import {
  expect,
  test,
  type APIRequestContext,
  type APIResponse,
  type Page,
} from '@playwright/test';
import { waitForEmail } from './mailpit';
import { serveApp } from './mobile-app';

/**
 * Task 335: "Dzień specjalny" in a specialist's schedule of the business app (web preview of
 * apps/mobile-business). The owner sets special hours for one date (an empty field is pointed
 * out: a whole day off is time off) and removes another date's special hours, which gets the
 * usual weekly hours back. Screenshots 335, 335a. Task 338: time off for a part of one day
 * (tomorrow 12:00–15:00; a wrong time is pointed out). Screenshot 338.
 */

const PASSWORD = 'e2e-password-123';
const run = Date.now().toString(36);
const OWNER = `app-special-day-owner-${run}@example.com`;
const PHONE = { width: 390, height: 844 };
// An address of this test only (sign-ups and codes are limited per address).
const OWNER_IP = { 'x-forwarded-for': '203.0.113.89' };

const shot = (page: Page, name: string) => page.screenshot({ path: `e2e/screenshots/${name}.png` });

async function json<T>(res: APIResponse): Promise<T> {
  expect(res.ok(), `${res.url()} → ${res.status()} ${await res.text()}`).toBeTruthy();
  return (res.status() === 204 ? undefined : await res.json()) as T;
}

async function verifiedUser(api: APIRequestContext, email: string, name: string) {
  await json(
    await api.post('/v1/auth/register', {
      headers: OWNER_IP,
      data: { email, password: PASSWORD, name },
    }),
  );
  const mail = await waitForEmail(email, /Potwierdź adres/);
  const token = /token=([^\s&]+)/.exec(mail.text)?.[1];
  expect(token, 'verification link').toBeTruthy();
  await json(
    await api.post('/v1/auth/verify-email', {
      headers: OWNER_IP,
      data: { token: decodeURIComponent(token!) },
    }),
  );
  const login = await json<{ accessToken: string }>(
    await api.post('/v1/auth/login', {
      headers: OWNER_IP,
      data: { email, password: PASSWORD, clientType: 'mobile' },
    }),
  );
  return { Authorization: `Bearer ${login.accessToken}` };
}

/** The salon's date (Warsaw) n days from now, YYYY-MM-DD. */
const warsawDate = (n: number) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Warsaw' }).format(
    new Date(Date.now() + n * 86_400_000),
  );

test('business app: the owner sets and removes a specialist’s special day', async ({
  browser,
  request,
}) => {
  const owner = await verifiedUser(request, OWNER, 'Aleksander Owner');
  const org = await json<{ id: string }>(
    await request.post('/v1/organizations', { headers: owner, data: { name: 'GESTALT' } }),
  );
  const location = await json<{ id: string }>(
    await request.post(`/v1/organizations/${org.id}/locations`, {
      headers: owner,
      data: {
        name: 'Gestalt Barbershop',
        addressLine: 'ul. Józefa Bema 91',
        city: 'Warszawa',
        postalCode: '01-233',
      },
    }),
  );
  const base = `/v1/organizations/${org.id}/locations/${location.id}`;
  const kasia = await json<{ id: string }>(
    await request.post(`${base}/staff`, { headers: owner, data: { displayName: 'Kasia' } }),
  );
  await json(
    await request.put(`${base}/staff/${kasia.id}/working-hours`, {
      headers: owner,
      data: {
        days: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
          weekday,
          intervals: [{ start: '10:00', end: '18:00' }],
        })),
      },
    }),
  );
  // A special day already set, ten days ahead — it will be removed in the app.
  const later = warsawDate(10);
  await json(
    await request.put(`${base}/staff/${kasia.id}/working-hours/overrides/${later}`, {
      headers: owner,
      data: { intervals: [{ start: '12:00', end: '16:00' }] },
    }),
  );

  const businessApp = await serveApp('mobile-business');
  try {
    const context = await browser.newContext({
      viewport: PHONE,
      locale: 'pl-PL',
      timezoneId: 'Europe/Warsaw',
      isMobile: true,
      extraHTTPHeaders: OWNER_IP,
    });
    const phone = await context.newPage();
    await phone.goto(businessApp.url);
    await phone.getByLabel('E-mail lub telefon').fill(OWNER);
    await phone.getByRole('button', { name: 'Wyślij kod' }).click();
    const code = await waitForEmail(OWNER, /Kod logowania do aplikacji salonu/);
    await phone.getByLabel('Kod', { exact: true }).fill(/\b(\d{6})\b/.exec(code.text)![1]!);
    await phone.getByRole('button', { name: 'Zaloguj się' }).click();
    await expect(phone.getByRole('button', { name: 'Dziś' })).toBeVisible();

    await phone.getByRole('button', { name: 'Grafik zespołu' }).click();
    await phone.getByRole('button', { name: 'Kasia', exact: true }).click();
    await expect(phone.getByRole('heading', { name: 'Grafik: Kasia' })).toBeVisible();
    await expect(phone.getByText('Dni specjalne')).toBeVisible();
    await expect(phone.getByText('12:00–16:00')).toBeVisible();

    // ── 335: the day after tomorrow, 10:00–14:00 ───────────────────────────
    await phone.getByRole('button', { name: '+ Dzień specjalny' }).click();
    await expect(phone.getByRole('button', { name: 'Dzień: Dzień wcześniej' })).toBeDisabled();
    await phone.getByRole('button', { name: 'Dzień: Dzień później' }).click();
    await phone.getByRole('button', { name: 'Dzień: Dzień później' }).click();
    await phone.getByRole('button', { name: 'Zapisz dzień' }).click();
    await expect(phone.getByText('Wpisz godziny pracy tego dnia.', { exact: false })).toBeVisible();
    await phone.getByLabel('Godziny tego dnia').fill('10-14');
    await shot(phone, '335-business-app-special-day');
    await phone.getByRole('button', { name: 'Zapisz dzień' }).click();
    await expect(phone.getByText('Dzień specjalny zapisany.', { exact: false })).toBeVisible();
    await expect(phone.getByText('10:00–14:00')).toBeVisible();

    // ── 335: the later special day goes, its usual hours are back ──────────
    const removeButtons = phone.getByRole('button', { name: /^Usuń: / });
    await expect(removeButtons).toHaveCount(2);
    await removeButtons.last().click();
    await expect(phone.getByText('Przywrócić zwykłe godziny tego dnia?')).toBeVisible();
    await phone.getByRole('button', { name: 'Tak, usuń' }).click();
    await expect(phone.getByText('Przywrócono zwykłe godziny tego dnia.')).toBeVisible();
    await expect(phone.getByText('12:00–16:00')).toHaveCount(0);
    await shot(phone, '335a-business-app-special-day-removed');

    // ── 338: time off for a few hours of tomorrow ──────────────────────────
    await phone.getByRole('button', { name: 'Dodaj wolne' }).click();
    await phone.getByRole('button', { name: 'Część dnia' }).click();
    await expect(phone.getByRole('button', { name: 'Dzień: Dzień później' })).toBeVisible();
    await expect(phone.getByRole('button', { name: 'Do: Dzień później' })).toHaveCount(0);
    await phone.getByRole('button', { name: 'Dzień: Dzień później' }).click();
    await phone.getByLabel('Godziny wolnego').fill('15-12');
    await phone.getByRole('button', { name: 'Zapisz wolne' }).click();
    await expect(phone.getByText('Wpisz godziny wolnego, np. 12:00–15:00.')).toBeVisible();
    await phone.getByLabel('Godziny wolnego').fill('12-15');
    await phone.getByLabel('Powód (np. urlop)').fill('Lekarz');
    await shot(phone, '338-business-app-time-off-hours');
    await phone.getByRole('button', { name: 'Zapisz wolne' }).click();
    await expect(phone.getByText('Wolne zapisane.', { exact: false })).toBeVisible();
    await expect(phone.getByText(/12:00–15:00/)).toBeVisible();
    await expect(phone.getByText('Lekarz', { exact: true })).toBeVisible();
    await context.close();
  } finally {
    businessApp.server.close();
  }

  const hours = await json<{
    overrides: { date: string; intervals: { start: string; end: string }[] }[];
  }>(await request.get(`${base}/staff/${kasia.id}/working-hours`, { headers: owner }));
  expect(hours.overrides).toEqual([
    { date: warsawDate(2), intervals: [{ start: '10:00', end: '14:00' }] },
  ]);
  const off = await json<{ start: string; end: string; note: string | null }[]>(
    await request.get(`${base}/staff/${kasia.id}/time-off`, { headers: owner }),
  );
  expect(off).toEqual([
    expect.objectContaining({
      start: `${warsawDate(1)}T12:00`,
      end: `${warsawDate(1)}T15:00`,
      note: 'Lekarz',
    }),
  ]);
});
