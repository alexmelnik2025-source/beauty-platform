import {
  expect,
  test,
  type APIRequestContext,
  type APIResponse,
  type Page,
} from '@playwright/test';
import { freshAddress } from './addresses';
import { listTo, textOf, waitForEmail } from './mailpit';
import { serveApp } from './mobile-app';

/**
 * Task Q3 in the client app: a visit with a product put aside is cancelled; its card in "Moje
 * wizyty" shows "Przenieść produkty na nowy termin?" instead of "Umów ponownie" — one button books
 * the same specialist and the product comes along to the new visit (Q3-move-app,
 * Q3-move-app-booked).
 */

const PASSWORD = 'e2e-password-123';
const run = Date.now().toString(36);
const OWNER = `move-app-${run}@example.com`;
const CLIENT = `move-app-client-${run}@example.com`;
const PHONE = { width: 390, height: 844 };

const shot = (page: Page, name: string) =>
  page.screenshot({ path: `e2e/screenshots/${name}.png`, fullPage: true });

async function json<T>(res: APIResponse): Promise<T> {
  expect(res.ok(), `${res.url()} → ${res.status()} ${await res.text()}`).toBeTruthy();
  return (res.status() === 204 ? undefined : await res.json()) as T;
}

/** The newest "Kod potwierdzenia" that came after `before` such emails. */
async function nextCode(before: number): Promise<string> {
  const until = Date.now() + 20_000;
  for (;;) {
    const codes = (await listTo(CLIENT)).filter((m) => /Kod potwierdzenia/.test(m.Subject));
    if (codes.length > before) return /\b(\d{6})\b/.exec(await textOf(codes[0]!.ID))![1]!;
    if (Date.now() > until) throw new Error('No new code');
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

const codeCount = async () =>
  (await listTo(CLIENT)).filter((m) => /Kod potwierdzenia/.test(m.Subject)).length;

async function owner(api: APIRequestContext) {
  await json(
    await api.post('/v1/auth/register', {
      headers: freshAddress(),
      data: { email: OWNER, password: PASSWORD, name: 'Właściciel' },
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
  const auth = { Authorization: `Bearer ${login.accessToken}` };
  const name = `Przenosiny Apka ${run}`;
  const org = await json<{ id: string }>(
    await api.post('/v1/organizations', { headers: auth, data: { name } }),
  );
  const location = await json<{ id: string; slug: string }>(
    await api.post(`/v1/organizations/${org.id}/locations`, {
      headers: auth,
      data: {
        name,
        addressLine: 'ul. Józefa Bema 91',
        city: 'Warszawa',
        postalCode: '01-233',
        onlineBookingEnabled: true,
        bookingTerms: '# Regulamin\n\nWizyta jest bezpłatna do odwołania.',
        privacyPolicy: `# Prywatność\n\nAdministratorem danych jest ${name}.`,
      },
    }),
  );
  return {
    auth,
    base: `/v1/organizations/${org.id}/locations/${location.id}`,
    slug: location.slug,
  };
}

test('"Przenieść produkty na nowy termin?" in the client app (task Q3)', async ({
  browser,
  request,
}) => {
  const salon = await owner(request);
  const pomade = await json<{ id: string }>(
    await request.post(`${salon.base}/products`, {
      headers: salon.auth,
      data: {
        name: 'Pomada Reuzel różowa',
        priceGrosze: 5900,
        stockQuantity: 5,
        inSalonShop: true,
      },
    }),
  );
  const cut = await json<{ id: string }>(
    await request.post(`${salon.base}/services`, {
      headers: salon.auth,
      data: { name: 'Strzyżenie', durationMinutes: 30, priceGrosze: 8000 },
    }),
  );
  const ilya = await json<{ id: string }>(
    await request.post(`${salon.base}/staff`, {
      headers: salon.auth,
      data: { displayName: 'Ilya', serviceIds: [cut.id] },
    }),
  );
  await json(
    await request.put(`${salon.base}/staff/${ilya.id}/working-hours`, {
      headers: salon.auth,
      data: {
        days: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
          weekday,
          intervals: [{ start: '08:00', end: '20:00' }],
        })),
      },
    }),
  );

  // A visit two days ahead with the pomade put aside, then cancelled by the client.
  const ip = freshAddress();
  const from = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
  const to = new Date(Date.now() + 6 * 86_400_000).toISOString().slice(0, 10);
  const free = await json<{ slots: { start: string }[] }>(
    await request.get(`/v1/public/locations/${salon.slug}/availability`, {
      params: { serviceId: cut.id, staffId: ilya.id, from, to },
    }),
  );
  const hold = await json<{ holdId: string; holdToken: string }>(
    await request.post(`/v1/public/locations/${salon.slug}/holds`, {
      headers: ip,
      data: { serviceId: cut.id, staffId: ilya.id, start: free.slots[0]!.start },
    }),
  );
  const before = await codeCount();
  await json(
    await request.post(`/v1/public/holds/${hold.holdId}/code`, {
      headers: ip,
      data: {
        holdToken: hold.holdToken,
        name: 'Anna Kowalska',
        phone: '+48600100205',
        email: CLIENT,
        locale: 'pl',
        acceptTerms: true,
      },
    }),
  );
  const first = await json<{ appointment: { id: string }; manageToken: string }>(
    await request.post(`/v1/public/holds/${hold.holdId}/confirm`, {
      headers: ip,
      data: { holdToken: hold.holdToken, code: await nextCode(before) },
    }),
  );
  await json(
    await request.post(`/v1/public/appointments/${first.manageToken}/products`, {
      headers: ip,
      data: { productId: pomade.id },
    }),
  );
  await json(
    await request.post(`/v1/public/appointments/${first.manageToken}/cancel`, {
      headers: ip,
      data: {},
    }),
  );

  const clientApp = await serveApp('mobile-client');
  try {
    const phone = await browser.newContext({
      viewport: PHONE,
      locale: 'pl-PL',
      isMobile: true,
      extraHTTPHeaders: freshAddress(),
    });
    const app = await phone.newPage();
    await app.goto(clientApp.url);
    await app.getByLabel('E-mail', { exact: true }).fill(CLIENT);
    await app.getByRole('button', { name: 'Wyślij kod' }).click();
    const signIn = await waitForEmail(CLIENT, /Kod logowania do Twoich wizyt/);
    await app.getByLabel('Kod z e-maila').fill(/\b(\d{6})\b/.exec(signIn.text)![1]!);
    await app.getByRole('button', { name: 'Zaloguj się' }).click();
    await app.getByRole('tab', { name: 'Historia', exact: true }).click();
    await app
      .getByRole('button', { name: /Strzyżenie, Przenosiny Apka/ })
      .first()
      .click();
    const move = app.getByRole('region', { name: 'Przenieść produkty na nowy termin?' });
    await expect(move.getByText('Pomada Reuzel różowa')).toBeVisible();
    // One main button: "Umów ponownie" gives way to "Wybierz nowy termin".
    await expect(app.getByRole('button', { name: 'Umów ponownie' })).toHaveCount(0);
    await move.scrollIntoViewIfNeeded();
    await shot(app, 'Q3-move-app');

    await move.getByRole('button', { name: 'Wybierz nowy termin' }).click();
    await expect(app.getByRole('heading', { name: 'Wybierz termin' })).toBeVisible();
    await app
      .getByRole('button', { name: /^\d{2}:\d{2}$/ })
      .first()
      .click();
    await expect(app.getByRole('heading', { name: 'Twoje dane' })).toBeVisible();
    await app.getByRole('textbox', { name: 'Imię i nazwisko' }).fill('Anna Kowalska');
    await app.getByRole('textbox', { name: 'Telefon' }).fill('600 100 205');
    await app.getByRole('checkbox', { name: /Akceptuję regulamin rezerwacji/ }).click();
    await app.getByRole('button', { name: 'Potwierdź wizytę' }).click();
    await expect(app.getByRole('heading', { name: 'Do zobaczenia!' })).toBeVisible();
    await expect(
      app.getByText('✓ Produkty czekają na Ciebie w salonie: 1. Zapłacisz przy odbiorze.'),
    ).toBeVisible();
    await shot(app, 'Q3-move-app-booked');
    await phone.close();
  } finally {
    clientApp.server.close();
  }
  // The salon sees the pomade waiting on the new visit.
  const visits = await json<{ id: string; status: string }[]>(
    await request.get(`${salon.base}/appointments`, {
      headers: salon.auth,
      params: { from: new Date().toISOString().slice(0, 10), to },
    }),
  );
  const fresh = visits.find((v) => v.id !== first.appointment.id && v.status === 'confirmed');
  const waiting = await json<{ reservations: { status: string }[] }>(
    await request.get(`${salon.base}/appointments/${fresh!.id}/reservations`, {
      headers: salon.auth,
    }),
  );
  expect(waiting.reservations.map((r) => r.status)).toEqual(['reserved']);
});
