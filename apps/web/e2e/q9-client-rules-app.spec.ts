import {
  expect,
  test,
  type APIRequestContext,
  type APIResponse,
  type Page,
} from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { freshAddress } from './addresses';
import { waitForEmail } from './mailpit';
import { serveApp } from './mobile-app';

const password = randomUUID();
const run = Date.now().toString(36);
const OWNER = `q9-app-owner-${run}@example.com`;
const OLA = `q9-app-ola-${run}@example.com`;
const PHONE = { width: 390, height: 844 };

const shot = (page: Page, name: string) => page.screenshot({ path: `e2e/screenshots/${name}.png` });

async function json<T>(res: APIResponse): Promise<T> {
  expect(res.ok(), `${res.url()} → ${res.status()} ${await res.text()}`).toBeTruthy();
  return (res.status() === 204 ? undefined : await res.json()) as T;
}

async function verifiedUser(api: APIRequestContext, email: string, name: string) {
  await json(
    await api.post('/v1/auth/register', {
      headers: freshAddress(),
      data: { email, password, name },
    }),
  );
  const mail = await waitForEmail(email, /Potwierdź adres/);
  const token = /token=([^\s&]+)/.exec(mail.text)?.[1];
  expect(token, 'verification link').toBeTruthy();
  await json(
    await api.post('/v1/auth/verify-email', { data: { token: decodeURIComponent(token!) } }),
  );
  const login = await json<{ accessToken: string }>(
    await api.post('/v1/auth/login', {
      headers: freshAddress(),
      data: { email, password, clientType: 'mobile' },
    }),
  );
  return { Authorization: `Bearer ${login.accessToken}` };
}

test('Q9: the owner sets a personal rule in the business app and the client confirms the payment notice', async ({
  browser,
  request,
}) => {
  const owner = await verifiedUser(request, OWNER, 'Aleksander Owner');
  const org = await json<{ id: string }>(
    await request.post('/v1/organizations', { headers: owner, data: { name: 'GESTALT' } }),
  );
  const location = await json<{ id: string; slug: string; version: number }>(
    await request.post(`/v1/organizations/${org.id}/locations`, {
      headers: owner,
      data: {
        name: 'Gestalt Zasady',
        addressLine: 'ul. Józefa Bema 91',
        city: 'Warszawa',
        postalCode: '01-233',
      },
    }),
  );
  const base = `/v1/organizations/${org.id}/locations/${location.id}`;
  await json(
    await request.patch(base, {
      headers: owner,
      data: {
        version: location.version,
        onlineBookingEnabled: true,
        bookingTerms: '# Regulamin rezerwacji\n\nRezerwacja jest bezpłatna.',
        privacyPolicy: '# Polityka prywatności\n\nAdministratorem danych jest GESTALT.',
      },
    }),
  );
  const service = await json<{ id: string }>(
    await request.post(`${base}/services`, {
      headers: owner,
      data: { name: 'Strzyżenie męskie', durationMinutes: 45, priceGrosze: 9000 },
    }),
  );
  const staff = await json<{ id: string }>(
    await request.post(`${base}/staff`, {
      headers: owner,
      data: { displayName: 'Kasia', serviceIds: [service.id] },
    }),
  );
  await json(
    await request.put(`${base}/staff/${staff.id}/working-hours`, {
      headers: owner,
      data: {
        days: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
          weekday,
          intervals: [{ start: '00:00', end: '24:00' }],
        })),
      },
    }),
  );

  // The default salon protection is off.
  const yesterday = new Date(Date.now() - 86_400_000);
  yesterday.setUTCMinutes(0, 0, 0);
  const missed = await json<{ id: string; version: number }>(
    await request.post(`${base}/appointments`, {
      headers: owner,
      data: {
        serviceId: service.id,
        staffId: staff.id,
        start: yesterday.toISOString(),
        allowOutsideHours: true,
        alreadyHappened: true,
        customer: { name: 'Ola Nowak', phone: '+48600300400', email: OLA },
      },
    }),
  );
  await json(
    await request.post(`${base}/appointments/${missed.id}/status`, {
      headers: owner,
      data: { version: missed.version, status: 'no_show' },
    }),
  );

  const business = await serveApp('mobile-business');
  const desk = await browser.newContext({
    viewport: PHONE,
    locale: 'pl-PL',
    extraHTTPHeaders: freshAddress(),
  });
  try {
    const app = await desk.newPage();
    await app.goto(business.url);
    await app.getByLabel('E-mail lub telefon').fill(OWNER);
    await app.getByRole('button', { name: 'Wyślij kod' }).click();
    const message = await waitForEmail(OWNER, /Kod logowania do aplikacji salonu/);
    await app.getByLabel('Kod', { exact: true }).fill(/\b(\d{6})\b/.exec(message.text)![1]!);
    await app.getByRole('button', { name: 'Zaloguj się' }).click();
    await app.getByRole('tab', { name: 'Klienci' }).click();
    await app.getByRole('button', { name: /Ola Nowak/ }).click();
    await app.getByRole('button', { name: 'Więcej', exact: true }).click();
    const rule = app.getByRole('button', { name: 'Zasady dla klienta' });
    await expect(rule).toHaveAttribute('aria-expanded', 'false');
    await rule.click();
    await expect(app.getByRole('radio', { name: 'Według zasad salonu' })).toBeChecked();
    const prepay = app.getByRole('radio', { name: 'Najpierw opłata zaległych (w salonie)' });
    await prepay.click();
    await expect(app.getByText('Zapisano zasady dla klienta.')).toBeVisible();
    await expect(app.getByText(/Nieodbyte wizyty: 90,00/)).toBeVisible();
    await rule.click();
    await expect(prepay).toBeChecked();
    await shot(app, 'q9-business-app-client-rules');
  } finally {
    await desk.close();
    business.server.close();
  }

  const clientApp = await serveApp('mobile-client');
  try {
    for (const signedIn of [false, true]) {
      const phone = await browser.newContext({
        viewport: { width: 320, height: 700 },
        isMobile: true,
        locale: 'pl-PL',
        extraHTTPHeaders: freshAddress(),
      });
      try {
        if (signedIn) {
          await json(
            await request.post('/v1/client/auth/code', {
              headers: freshAddress(),
              data: { email: OLA, locale: 'pl' },
            }),
          );
          const mail = await waitForEmail(OLA, /Kod logowania do Twoich wizyt/);
          const { token } = await json<{ token: string }>(
            await request.post('/v1/client/auth/verify', {
              data: { email: OLA, code: /\b(\d{6})\b/.exec(mail.text)![1]!, clientType: 'mobile' },
            }),
          );
          await phone.addInitScript(
            (token) => localStorage.setItem('beauty.client.session', token),
            token,
          );
        }
        const page = await phone.newPage();
        await page.goto(`${clientApp.url}/pl/b/${location.slug}`);
        await page.getByRole('button', { name: 'Umów wizytę', exact: true }).click();
        await page.getByRole('button', { name: /^Strzyżenie męskie,/ }).click();
        await page
          .getByRole('button', { name: /^\d{2}:\d{2}$/ })
          .first()
          .click();
        await page.getByLabel('Imię i nazwisko').fill('Ola Nowak');
        await page.getByLabel('Telefon', { exact: true }).fill('600 300 400');
        if (!signedIn) await page.getByRole('textbox', { name: 'E-mail', exact: true }).fill(OLA);
        await page.getByRole('checkbox', { name: /Akceptuję regulamin/ }).click();
        if (!signedIn) {
          await page.getByRole('button', { name: 'Wyślij kod' }).click();
          const mail = await waitForEmail(OLA, /Kod potwierdzenia/);
          await page.getByLabel('Kod z e-maila').fill(/\b(\d{6})\b/.exec(mail.text)![1]!);
        }
        await page.getByRole('button', { name: 'Potwierdź wizytę', exact: true }).click();
        await expect(page.getByText('Zapłacisz w salonie za poprzednią i tę wizytę')).toBeVisible();
        await expect(page.getByText(/Nieodbyte wizyty: 90,00/)).toBeVisible();
        await shot(
          page,
          signedIn ? 'q9-client-app-pay-notice-signed-in' : 'q9-client-app-pay-notice-code',
        );
        await page.getByRole('button', { name: 'Rozumiem — potwierdź wizytę' }).click();
        await expect(page.getByRole('heading', { name: 'Do zobaczenia!' })).toBeVisible();
      } finally {
        await phone.close();
      }
    }
  } finally {
    clientApp.server.close();
  }
});
