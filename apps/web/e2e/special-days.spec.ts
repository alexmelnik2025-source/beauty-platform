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
 * the usual hours back. Screenshots 336, 336a. Task 660: a wrong time, a wrong absence and a
 * name of only spaces are pointed out under their field (screenshot 660).
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
  // Task 660: the error is under "Do" in this section, not at the top of the sheet.
  // (the error text sits inside the field's label, so "Do" is found by its input here)
  const specialEnd = special.locator('input[type="time"]').last();
  await expect(specialEnd).toHaveAttribute('aria-invalid', 'true');
  await expect(special.locator('#special-end-error')).toHaveText(
    'Godzina „Do” musi być późniejsza niż „Od”.',
  );
  await special.scrollIntoViewIfNeeded();
  await shot(page, '660-staff-special-time-error');
  await special.getByLabel('Od', { exact: true }).fill('09:00');
  await expect(specialEnd).not.toHaveAttribute('aria-invalid', 'true');
  await expect(special.locator('#special-end-error')).toHaveCount(0);
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

  // ── task 660: an absence whose "Do" is before "Od" — pointed out under "Do" ──
  const absence = page.getByRole('region', { name: 'Nieobecności' });
  await absence.getByLabel('Od', { exact: true }).fill(`${warsawDate(5)}T15:00`);
  await absence.getByLabel('Do', { exact: true }).fill(`${warsawDate(5)}T11:00`);
  await absence.getByRole('button', { name: 'Dodaj nieobecność' }).click();
  const absenceEnd = absence.locator('input[type="datetime-local"]').last();
  await expect(absenceEnd).toHaveAttribute('aria-invalid', 'true');
  await expect(absence.locator('#absence-end-error')).toBeVisible();
  await absenceEnd.fill(`${warsawDate(5)}T18:00`);
  await expect(absence.locator('#absence-end-error')).toHaveCount(0);
  await absence.getByRole('button', { name: 'Dodaj nieobecność' }).click();
  await expect(absence.getByRole('button', { name: 'Usuń' })).toHaveCount(1);

  // ── task 660: a name of only spaces — under "Imię" ─────────────────────
  await page.keyboard.press('Escape');
  await page
    .getByRole('button', { name: /Dodaj specjalistę/ })
    .first()
    .click();
  const name = page.getByLabel('Imię widoczne dla klientów');
  await name.fill('   ');
  await page.getByRole('dialog').getByRole('button', { name: 'Zapisz', exact: true }).click();
  await expect(name).toHaveAttribute('aria-invalid', 'true');
  await expect(page.locator('#staff-name-error')).toHaveText('Uzupełnij to pole.');
  await context.close();

  const hours = await json<{
    overrides: { date: string; intervals: { start: string; end: string }[] }[];
  }>(await request.get(`${base}/staff/${kasia.id}/working-hours`, { headers: owner }));
  expect(hours.overrides).toEqual([{ date: soon, intervals: [{ start: '09:00', end: '13:00' }] }]);
});
