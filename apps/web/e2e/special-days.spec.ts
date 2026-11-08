import {
  expect,
  test,
  type APIRequestContext,
  type APIResponse,
  type Page,
} from '@playwright/test';
import { freshAddress } from './addresses';
import { waitForEmail } from './mailpit';

/**
 * Task 336: "Dni specjalne" in the cabinet — the owner opens a specialist in "Zespół", sets other
 * hours for one date (a wrong time is pointed out) and removes another special day, which gets
 * the usual hours back. Screenshots 336, 336a.
 */

const PASSWORD = 'e2e-password-123';
const run = Date.now().toString(36);
const OWNER = `special-days-owner-${run}@example.com`;
const DESKTOP = { width: 1440, height: 900 };

const shot = (page: Page, name: string) => page.screenshot({ path: `e2e/screenshots/${name}.png` });

async function json<T>(res: APIResponse): Promise<T> {
  expect(res.ok(), `${res.url()} → ${res.status()} ${await res.text()}`).toBeTruthy();
  return (res.status() === 204 ? undefined : await res.json()) as T;
}

async function verifiedUser(api: APIRequestContext, email: string, name: string) {
  await json(
    await api.post('/v1/auth/register', {
      headers: freshAddress(),
      data: { email, password: PASSWORD, name },
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

test('the owner sets and removes a specialist’s special day in the cabinet', async ({
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
  const later = warsawDate(10);
  await json(
    await request.put(`${base}/staff/${kasia.id}/working-hours/overrides/${later}`, {
      headers: owner,
      data: { intervals: [{ start: '12:00', end: '16:00' }] },
    }),
  );

  const context = await browser.newContext({
    viewport: DESKTOP,
    locale: 'pl-PL',
    timezoneId: 'Europe/Warsaw',
    extraHTTPHeaders: freshAddress(),
  });
  const page = await context.newPage();
  await page.goto('/pl/login');
  await page.getByLabel('E-mail').fill(OWNER);
  await page.getByLabel('Hasło').fill(PASSWORD);
  await page.getByRole('button', { name: 'Zaloguj się' }).click();
  await page.waitForURL(/\/pl\/app\/calendar/);
  await page.goto('/pl/app/team');
  await page.getByRole('button', { name: /^Kasia/ }).click();

  const special = page.getByRole('region', { name: 'Dni specjalne' });
  await expect(special).toBeVisible();
  await expect(special.getByText(/12:00–16:00/)).toBeVisible();

  // ── a wrong time first, then 09:00–13:00 in three days ────────────────
  const soon = warsawDate(3);
  await special.getByLabel('Dzień', { exact: true }).fill(soon);
  await special.getByLabel('Od', { exact: true }).fill('14:00');
  await special.getByLabel('Do', { exact: true }).fill('10:00');
  await special.getByRole('button', { name: 'Zapisz dzień specjalny' }).click();
  await expect(page.getByText('Godzina „Do” musi być późniejsza niż „Od”.')).toBeVisible();
  await special.getByLabel('Od', { exact: true }).fill('09:00');
  await special.getByLabel('Do', { exact: true }).fill('13:00');
  await special.getByRole('button', { name: 'Zapisz dzień specjalny' }).click();
  await expect(special.getByText('Dzień specjalny zapisany.')).toBeVisible();
  await expect(special.getByText(/09:00–13:00/)).toBeVisible();
  await special.scrollIntoViewIfNeeded();
  await shot(page, '336-cabinet-special-day');

  // ── the later special day goes: the usual hours are back ───────────────
  const remove = special.getByRole('button', { name: /^Usuń: / });
  await expect(remove).toHaveCount(2);
  await remove.last().click();
  await expect(special.getByText('Przywrócono zwykłe godziny tego dnia.')).toBeVisible();
  await expect(special.getByText(/12:00–16:00/)).toHaveCount(0);
  await shot(page, '336a-cabinet-special-day-removed');
  await context.close();

  const hours = await json<{
    overrides: { date: string; intervals: { start: string; end: string }[] }[];
  }>(await request.get(`${base}/staff/${kasia.id}/working-hours`, { headers: owner }));
  expect(hours.overrides).toEqual([{ date: soon, intervals: [{ start: '09:00', end: '13:00' }] }]);
});
