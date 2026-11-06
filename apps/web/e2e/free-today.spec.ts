import {
  expect,
  test,
  type APIRequestContext,
  type APIResponse,
  type Page,
} from '@playwright/test';
import { freshAddress } from './addresses';
import { waitForEmail } from './mailpit';
import { serveApp } from './mobile-app';

/**
 * Task 120: "Wolne dziś". Kasia works around the clock (no notice needed), Marek has no hours:
 * over the price list "Wolne dziś: Kasia" and a green ring on her circle; in the client app a
 * "Wolne dziś" line under her name in the team. Screenshots 120–120a.
 */

const PASSWORD = 'e2e-password-123';
const run = Date.now().toString(36);
const PHONE = { width: 390, height: 844 };
const NAME = `Dziś Wolne ${run}`;
const OWNER = `free-today-${run}@example.com`;

const shot = (page: Page, name: string) => page.screenshot({ path: `e2e/screenshots/${name}.png` });

async function json<T>(res: APIResponse): Promise<T> {
  expect(res.ok(), `${res.url()} → ${res.status()} ${await res.text()}`).toBeTruthy();
  return (res.status() === 204 ? undefined : await res.json()) as T;
}

async function salonWithFreeKasia(api: APIRequestContext): Promise<string> {
  await json(
    await api.post('/v1/auth/register', {
      headers: freshAddress(),
      data: { email: OWNER, password: PASSWORD, name: 'Aleksander Owner' },
    }),
  );
  const mail = await waitForEmail(OWNER, /Potwierdź adres/);
  const token = /token=([^\s&]+)/.exec(mail.text)?.[1];
  await json(
    await api.post('/v1/auth/verify-email', { data: { token: decodeURIComponent(token!) } }),
  );
  const login = await json<{ accessToken: string }>(
    await api.post('/v1/auth/login', {
      headers: freshAddress(),
      data: { email: OWNER, password: PASSWORD, clientType: 'mobile' },
    }),
  );
  const owner = { Authorization: `Bearer ${login.accessToken}` };
  const org = await json<{ id: string }>(
    await api.post('/v1/organizations', { headers: owner, data: { name: NAME } }),
  );
  const location = await json<{ id: string; slug: string }>(
    await api.post(`/v1/organizations/${org.id}/locations`, {
      headers: owner,
      data: {
        name: NAME,
        addressLine: 'ul. Dzika 3',
        city: 'Aleksandrów Kujawski',
        postalCode: '87-700',
        minLeadMinutes: 0,
        onlineBookingEnabled: true,
        bookingTerms: '# Regulamin\n\nWizyta jest bezpłatna do odwołania.',
        privacyPolicy: `# Prywatność\n\nAdministratorem danych jest ${NAME}.`,
      },
    }),
  );
  const base = `/v1/organizations/${org.id}/locations/${location.id}`;
  const service = await json<{ id: string }>(
    await api.post(`${base}/services`, {
      headers: owner,
      data: { name: 'Konturowanie', durationMinutes: 15, priceGrosze: 3000 },
    }),
  );
  for (const name of ['Kasia', 'Marek']) {
    const staff = await json<{ id: string }>(
      await api.post(`${base}/staff`, {
        headers: owner,
        data: { displayName: name, serviceIds: [service.id] },
      }),
    );
    if (name === 'Kasia') {
      await json(
        await api.put(`${base}/staff/${staff.id}/working-hours`, {
          headers: owner,
          data: {
            days: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
              weekday,
              intervals: [{ start: '00:00', end: '24:00' }],
            })),
          },
        }),
      );
    }
  }
  return location.slug;
}

test('"Wolne dziś" over the price list and in the client app', async ({ browser, request }) => {
  const slug = await salonWithFreeKasia(request);
  // In the last minutes of the day nobody fits any more: then the line is not shown at all.
  const free = await json<{ staffIds: string[] }>(
    await request.get(`/v1/public/locations/${slug}/free-today`),
  );
  const kasiaFree = free.staffIds.length === 1;
  expect(free.staffIds.length).toBeLessThanOrEqual(1);

  const phone = await browser.newContext({
    viewport: PHONE,
    isMobile: true,
    locale: 'pl-PL',
    timezoneId: 'Europe/Warsaw',
  });
  try {
    const client = await phone.newPage();
    await client.goto(`/pl/b/${slug}`);
    await expect(client.getByText('Konturowanie').first()).toBeVisible();
    const line = client.locator('.free-today');
    if (kasiaFree) {
      await expect(line).toHaveText('Wolne dziś: Kasia');
      await expect(client.locator('.service-team .avatar[data-free-today]')).toHaveCount(1);
      await expect(client.getByRole('button', { name: 'Kasia — wolne terminy' })).toHaveAttribute(
        'data-free-today',
        'true',
      );
    } else {
      await expect(line).toHaveCount(0);
    }
    await shot(client, '120-booking-free-today');

    const clientApp = await serveApp('mobile-client');
    try {
      const app = await phone.newPage();
      await app.goto(clientApp.url);
      await app.getByRole('button', { name: 'Znajdź salon' }).click();
      await expect(app.getByRole('heading', { name: 'Znajdź salon' })).toBeVisible();
      await app.getByLabel('Czego szukasz? Usługa, salon, miasto lub ulica').fill(NAME);
      await app
        .getByRole('article', { name: NAME })
        .getByRole('button', { name: 'Zobacz salon' })
        .click();
      await expect(app.getByText('Marek', { exact: true })).toBeVisible();
      await expect(app.getByText('● Wolne dziś')).toHaveCount(kasiaFree ? 1 : 0);
      await app.getByText('Marek', { exact: true }).scrollIntoViewIfNeeded();
      await shot(app, '120a-client-app-free-today');
    } finally {
      clientApp.server.close();
    }
  } finally {
    await phone.close();
  }
});
