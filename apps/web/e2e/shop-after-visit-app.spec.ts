import { execFileSync } from 'node:child_process';
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
 * Task Q3 (screen C in the client app): the card of a visit that took place shows "Na wizycie
 * użyto"; "Umów kolejną wizytę" books the same specialist and the products come along — put aside
 * for the new visit (Q3-C-app, Q3-C-app-booked); back in the old visit's card they show as put
 * aside on it (Q3-C-app-saved).
 */

const PASSWORD = 'e2e-password-123';
const run = Date.now().toString(36);
const OWNER = `after-visit-app-${run}@example.com`;
const CLIENT = `after-visit-app-client-${run}@example.com`;
const SPECIALIST = `after-visit-staff-${run}@example.com`;
const PHONE = { width: 320, height: 844 };

const shot = (page: Page, name: string) =>
  page.screenshot({ path: `e2e/screenshots/${name}.png`, fullPage: true });

async function json<T>(res: APIResponse): Promise<T> {
  expect(res.ok(), `${res.url()} → ${res.status()} ${await res.text()}`).toBeTruthy();
  return (res.status() === 204 ? undefined : await res.json()) as T;
}

/** Runs SQL on the test database (for what the API can't do: visits in the past). */
function sql(statement: string) {
  const url = (process.env.DATABASE_URL ?? '').replace(/\?.*$/, '');
  execFileSync('psql', [url, '-v', 'ON_ERROR_STOP=1', '-c', statement]);
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

async function verifiedUser(api: APIRequestContext, email: string, name: string) {
  await json(
    await api.post('/v1/auth/register', {
      headers: freshAddress(),
      data: { email, password: PASSWORD, name },
    }),
  );
  const mail = await waitForEmail(email, /Potwierdź adres/);
  const token = /token=([^\s&]+)/.exec(mail.text)?.[1];
  await json(
    await api.post('/v1/auth/verify-email', { data: { token: decodeURIComponent(token!) } }),
  );
  const login = await json<{ accessToken: string }>(
    await api.post('/v1/auth/login', {
      headers: freshAddress(),
      data: { email, password: PASSWORD, clientType: 'mobile' },
    }),
  );
  return { Authorization: `Bearer ${login.accessToken}` };
}

async function owner(api: APIRequestContext) {
  const auth = await verifiedUser(api, OWNER, 'Właściciel');
  const name = `Po Wizycie Apka ${run}`;
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
    orgId: org.id,
    locationId: location.id,
  };
}

test('"Na wizycie użyto" in the client app (task Q3, screen C)', async ({ browser, request }) => {
  const salon = await owner(request);
  const product = async (name: string, priceGrosze: number) =>
    json<{ id: string }>(
      await request.post(`${salon.base}/products`, {
        headers: salon.auth,
        data: { name, priceGrosze, stockQuantity: 5, inSalonShop: true },
      }),
    );
  await product('Pomada Reuzel różowa', 5900);
  await product('Wosk matowy', 4500);
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

  // The first visit, booked online, took place; Ilya used the pomade and the wax at it.
  const ip = freshAddress();
  const from = new Date().toISOString().slice(0, 10);
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
        phone: '+48600100204',
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
  const id = first.appointment.id;
  await json(
    await request.post(`/v1/organizations/${salon.orgId}/invitations`, {
      headers: salon.auth,
      data: {
        email: SPECIALIST,
        role: 'staff',
        locationIds: [salon.locationId],
        staffMemberId: ilya.id,
      },
    }),
  );
  const invitation = await waitForEmail(SPECIALIST, /Zaproszenie/);
  const inviteToken = /\/invite\/(\S+)/.exec(invitation.text)![1]!;
  const staffAuth = await verifiedUser(request, SPECIALIST, 'Ilya');
  await json(await request.post(`/v1/invitations/${inviteToken}/accept`, { headers: staffAuth }));
  const businessApp = await serveApp('mobile-business');
  try {
    const phone = await browser.newPage({
      viewport: PHONE,
      isMobile: true,
      locale: 'pl-PL',
      timezoneId: 'Europe/Warsaw',
      extraHTTPHeaders: freshAddress(),
    });
    await phone.goto(businessApp.url);
    await phone.getByLabel('E-mail lub telefon').fill(SPECIALIST);
    await phone.getByRole('button', { name: 'Wyślij kod' }).click();
    const signin = await waitForEmail(SPECIALIST, /Kod logowania do aplikacji salonu/);
    await phone.getByLabel('Kod', { exact: true }).fill(/\b(\d{6})\b/.exec(signin.text)![1]!);
    await phone.getByRole('button', { name: 'Zaloguj się' }).click();
    await expect(phone.getByRole('button', { name: 'Dziś' })).toBeVisible();
    const localDate = (date: Date) =>
      new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Warsaw' }).format(date);
    if (localDate(new Date(free.slots[0]!.start)) !== localDate(new Date()))
      await phone.getByRole('button', { name: 'Następny dzień' }).click();
    await phone
      .getByRole('button', { name: /Anna Kowalska/ })
      .first()
      .click();
    const used = phone.getByTestId('visit-products');
    for (const name of ['Pomada Reuzel różowa', 'Wosk matowy']) {
      await used.getByRole('button', { name, exact: true }).click();
      await expect(used.getByRole('button', { name: '✓ ' + name, exact: true })).toBeVisible();
    }
    await phone.close();
  } finally {
    businessApp.server.close();
  }

  sql(
    `UPDATE appointment SET status = 'completed', start_at = start_at - interval '4 days', end_at = end_at - interval '4 days', blocked_until = blocked_until - interval '4 days' WHERE id = '${id}';
     UPDATE appointment_access_token SET expires_at = now() + interval '7 days' WHERE appointment_id = '${id}'`,
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
      .getByRole('button', { name: /Strzyżenie, Po Wizycie Apka/ })
      .first()
      .click();
    const used = app.getByRole('region', { name: 'Na wizycie użyto' });
    await expect(used.getByText('Pomada Reuzel różowa')).toBeVisible();
    await expect(used.getByText('Wosk matowy')).toBeVisible();
    await expect(used.getByText(/Nie masz jeszcze kolejnej wizyty/)).toBeVisible();
    await used.getByRole('button', { name: 'Kup: Wosk matowy' }).click();
    await used.getByRole('button', { name: /Zamów z płatnością przy odbiorze w salonie/ }).click();
    await expect(used.getByText('Zamówiono. Odbiór i płatność w salonie.')).toBeVisible();
    await used.getByRole('button', { name: /Odłóż na następną wizytę: Pomada/ }).click();
    await used.getByRole('button', { name: /Odłóż na następną wizytę: Wosk/ }).click();
    await used.scrollIntoViewIfNeeded();
    await shot(app, 'Q3-C-app');

    // "Umów kolejną wizytę": Ilya's times, signed in — no code; the products come along.
    await used.getByRole('button', { name: 'Umów kolejną wizytę' }).click();
    await expect(app.getByRole('heading', { name: 'Wybierz termin' })).toBeVisible();
    await app
      .getByRole('button', { name: /^\d{2}:\d{2}$/ })
      .first()
      .click();
    await expect(app.getByRole('heading', { name: 'Twoje dane' })).toBeVisible();
    await app.getByRole('textbox', { name: 'Imię i nazwisko' }).fill('Anna Kowalska');
    await app.getByRole('textbox', { name: 'Telefon' }).fill('600 100 204');
    await app.getByRole('checkbox', { name: /Akceptuję regulamin rezerwacji/ }).click();
    await app.getByRole('button', { name: 'Potwierdź wizytę' }).click();
    await expect(app.getByRole('heading', { name: 'Do zobaczenia!' })).toBeVisible();
    await expect(
      app.getByText('✓ Produkty czekają na Ciebie w salonie: 2. Zapłacisz przy odbiorze.'),
    ).toBeVisible();
    await shot(app, 'Q3-C-app-booked');
    await phone.close();
  } finally {
    clientApp.server.close();
  }
  // The salon sees both products waiting on the new visit.
  const visits = await json<{ id: string; status: string }[]>(
    await request.get(`${salon.base}/appointments`, {
      headers: salon.auth,
      params: { from, to },
    }),
  );
  const fresh = visits.find((v) => v.id !== id && v.status === 'confirmed');
  const waiting = await json<{ reservations: { status: string }[] }>(
    await request.get(`${salon.base}/appointments/${fresh!.id}/reservations`, {
      headers: salon.auth,
    }),
  );
  expect(waiting.reservations.map((r) => r.status)).toEqual(['reserved', 'reserved']);
});
