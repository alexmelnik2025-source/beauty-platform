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
 * Task 95: "Grafik zespołu" in the business app (web preview of apps/mobile-business).
 * The owner opens a specialist's schedule, changes the weekly hours (a wrong day is pointed
 * out) and adds time off. Screenshots go to e2e/screenshots (90–90b).
 */

const PASSWORD = 'e2e-password-123';
const run = Date.now().toString(36);
const OWNER = `app-hours-owner-${run}@example.com`;
const PHONE = { width: 390, height: 844 };
// An address of this test only (sign-ups and codes are limited per address).
const OWNER_IP = { 'x-forwarded-for': '198.51.100.96' };

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

test('business app: the owner changes a specialist’s hours and adds time off', async ({
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
    await request.post(`${base}/staff`, { headers: owner, data: { displayName: 'Ilian' } }),
  );
  await json(
    await request.put(`${base}/staff/${kasia.id}/working-hours`, {
      headers: owner,
      data: {
        days: [1, 2, 3, 4, 5, 6].map((weekday) => ({
          weekday,
          intervals: [{ start: '10:00', end: '18:00' }],
        })),
      },
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

    // ── The team → Kasia ───────────────────────────────────────────────────
    await phone.getByRole('button', { name: 'Grafik zespołu' }).click();
    await expect(phone.getByRole('heading', { name: 'Grafik zespołu' })).toBeVisible();
    await expect(phone.getByRole('button', { name: 'Ilian' })).toBeVisible();
    await phone.getByRole('button', { name: 'Kasia' }).click();
    await expect(phone.getByRole('heading', { name: 'Grafik: Kasia' })).toBeVisible();
    await expect(phone.getByText('10:00–18:00')).toHaveCount(6);
    await shot(phone, '90-business-app-team-hours');

    // ── Weekly hours: Monday with a break, Saturday off; a wrong Tuesday ───
    await phone.getByRole('button', { name: 'Zmień godziny pracy' }).click();
    const monday = phone.getByLabel('poniedziałek', { exact: true });
    await expect(monday).toHaveValue('10:00–18:00');
    await monday.fill('9-14, 15-20');
    await phone.getByLabel('wtorek', { exact: true }).fill('20-12');
    await phone.getByLabel('sobota', { exact: true }).fill('');
    await phone.getByLabel('niedziela', { exact: true }).fill('10:00-14:00');
    await phone.getByRole('button', { name: 'Zapisz godziny' }).click();
    await expect(phone.getByText('Sprawdź godziny: wtorek.', { exact: false })).toBeVisible();
    await shot(phone, '90a-business-app-team-hours-edit');
    await phone.getByLabel('wtorek', { exact: true }).fill('12:00–20:00');
    await phone.getByRole('button', { name: 'Zapisz godziny' }).click();
    await expect(phone.getByText('Godziny pracy zapisane.', { exact: false })).toBeVisible();
    await expect(phone.getByText('09:00–14:00, 15:00–20:00')).toBeVisible();

    // ── Time off for Kasia ─────────────────────────────────────────────────
    await phone.getByRole('button', { name: 'Dodaj wolne' }).click();
    await phone.getByRole('button', { name: 'Do: Dzień później' }).click();
    await phone.getByLabel('Powód (np. urlop)').fill('Urlop');
    await phone.getByRole('button', { name: 'Zapisz wolne' }).click();
    await expect(phone.getByText('Wolne zapisane.', { exact: false })).toBeVisible();
    await expect(phone.getByText('Urlop', { exact: true })).toBeVisible();
    await shot(phone, '90b-business-app-team-hours-saved');
    await context.close();
  } finally {
    businessApp.server.close();
  }

  const hours = await json<{
    weekly: { weekday: number; intervals: { start: string; end: string }[] }[];
  }>(await request.get(`${base}/staff/${kasia.id}/working-hours`, { headers: owner }));
  expect(
    [...hours.weekly]
      .sort((a, b) => a.weekday - b.weekday)
      .map((d) => [d.weekday, d.intervals.map((i) => `${i.start}-${i.end}`)]),
  ).toEqual([
    [1, ['09:00-14:00', '15:00-20:00']],
    [2, ['12:00-20:00']],
    [3, ['10:00-18:00']],
    [4, ['10:00-18:00']],
    [5, ['10:00-18:00']],
    [7, ['10:00-14:00']],
  ]);
  const off = await json<{ note: string | null }[]>(
    await request.get(`${base}/staff/${kasia.id}/time-off`, { headers: owner }),
  );
  expect(off.map((o) => o.note)).toEqual(['Urlop']);
});
