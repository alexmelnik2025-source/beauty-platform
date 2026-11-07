import {
  expect,
  test,
  type APIRequestContext,
  type APIResponse,
  type Locator,
  type Page,
} from '@playwright/test';
import { freshAddress } from './addresses';
import { waitForEmail } from './mailpit';

/**
 * Task 222: "Tydzień" in the cabinet calendar — one specialist's week, a column per day. The
 * owner switches to the week, picks Marek, sees his visits on their days, drags one to the
 * next day, and opens a day from the week. Screenshot 222.
 */

const PASSWORD = 'e2e-password-123';
const run = Date.now().toString(36);
const OWNER = `week-owner-${run}@example.com`;
const DESKTOP = { width: 1280, height: 1000 };
const HOUR_PX = 80;
/** The salon's own address: the API limits sign-ups and sign-ins per address. */
const OWNER_IP = freshAddress();

const shot = (page: Page, name: string) =>
  page.screenshot({ path: `e2e/screenshots/${name}.png`, fullPage: true });

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

/** Presses the visit with the mouse and drags it to `column`, `deltaMinutes` later. */
async function dragVisit(page: Page, visit: Locator, column: Locator, deltaMinutes: number) {
  const from = (await visit.boundingBox())!;
  const to = (await column.boundingBox())!;
  const x = from.x + from.width / 2;
  const y = from.y + 12;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y + 10, { steps: 3 });
  await page.mouse.move(to.x + to.width / 2, y + (deltaMinutes / 60) * HOUR_PX, { steps: 12 });
  await page.mouse.up();
}

test("the owner sees one specialist's week and moves a visit to another day", async ({
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
  const haircut = await json<{ id: string }>(
    await request.post(`${base}/services`, {
      headers: owner,
      data: { name: 'Strzyżenie męskie', durationMinutes: 45, priceGrosze: 9000 },
    }),
  );
  const staff: string[] = [];
  for (const displayName of ['Ilian', 'Marek']) {
    const s = await json<{ id: string }>(
      await request.post(`${base}/staff`, {
        headers: owner,
        data: { displayName, serviceIds: [haircut.id] },
      }),
    );
    await json(
      await request.put(`${base}/staff/${s.id}/working-hours`, {
        headers: owner,
        data: {
          days: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
            weekday,
            intervals: [{ start: '08:00', end: '20:00' }],
          })),
        },
      }),
    );
    staff.push(s.id);
  }

  // Next week's Wednesday and Thursday (Warsaw dates), visits at 09:00 UTC.
  const warsawToday = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Warsaw' }).format(
    new Date(),
  );
  const noon = Date.parse(`${warsawToday}T12:00:00Z`);
  const toMonday = (8 - new Date(noon).getUTCDay()) % 7 || 7;
  const dayAt = (offset: number) =>
    new Date(noon + (toMonday + offset) * 86_400_000).toISOString().slice(0, 10);
  const wednesday = dayAt(2);
  const thursday = dayAt(3);
  const friday = dayAt(4);
  const book = async (staffId: string, day: string, name: string, phone: string) =>
    json<{ id: string }>(
      await request.post(`${base}/appointments`, {
        headers: owner,
        data: {
          serviceId: haircut.id,
          staffId,
          start: `${day}T09:00:00.000Z`,
          allowOutsideHours: true,
          customer: { name, phone, email: `week-${phone.slice(-3)}-${run}@example.com` },
        },
      }),
    );
  const jan = await book(staff[1]!, wednesday, 'Jan Kowalski', '+48600000301');
  await book(staff[1]!, thursday, 'Piotr Nowak', '+48600000302');
  await book(staff[0]!, wednesday, 'Adam Ilianowy', '+48600000303');

  const context = await browser.newContext({
    viewport: DESKTOP,
    locale: 'pl-PL',
    extraHTTPHeaders: OWNER_IP,
  });
  const page = await context.newPage();
  await page.goto('/pl/login');
  await page.getByLabel('E-mail').fill(OWNER);
  await page.getByLabel('Hasło').fill(PASSWORD);
  await page.getByRole('button', { name: 'Zaloguj się' }).click();
  await page.waitForURL(/\/pl\/app\/calendar/);
  await page.goto(`/pl/app/calendar?date=${wednesday}`);

  await page.getByRole('button', { name: 'Tydzień', exact: true }).click();
  await page.getByLabel('Tydzień specjalisty').selectOption({ label: 'Marek' });
  const week = page.getByTestId('calendar-week');
  await expect(week.locator('[data-col-date]')).toHaveCount(7);
  const column = (day: string) => week.locator(`[data-col-date="${day}"]`);
  await expect(column(wednesday).getByRole('button', { name: /Jan Kowalski/ })).toBeVisible();
  await expect(column(thursday).getByRole('button', { name: /Piotr Nowak/ })).toBeVisible();
  // Only Marek's visits: Ilian's client is not in the week.
  await expect(week.getByRole('button', { name: /Adam Ilianowy/ })).toHaveCount(0);
  await shot(page, '222-calendar-week');

  // Drag Jan to Friday, the same time: the move keeps the specialist and changes the day.
  await dragVisit(
    page,
    column(wednesday).getByRole('button', { name: /Jan Kowalski/ }),
    column(friday),
    0,
  );
  const sheet = page.getByRole('dialog');
  await expect(sheet.getByRole('heading', { name: 'Przenieść wizytę?' })).toBeVisible();
  await expect(sheet.getByTestId('move-summary')).toContainText('Marek');
  await sheet.getByRole('button', { name: 'Przenieś wizytę' }).click();
  await expect(sheet).toBeHidden();
  await expect(column(friday).getByRole('button', { name: /Jan Kowalski/ })).toBeVisible();
  await expect(column(wednesday).getByRole('button', { name: /Jan Kowalski/ })).toHaveCount(0);
  const moved = await json<{ date: string; staff: { id: string } }>(
    await request.get(`${base}/appointments/${jan.id}`, { headers: owner }),
  );
  expect(moved.date).toBe(friday);
  expect(moved.staff.id).toBe(staff[1]);

  // A day's number opens that day with every specialist.
  await week.locator('.day-pick').nth(3).click();
  const day = page.getByTestId('calendar-day');
  await expect(day).toBeVisible();
  await expect(day.getByRole('button', { name: /Piotr Nowak/ })).toBeVisible();
  await expect(day.locator('[data-staff-col]')).toHaveCount(2);
  await context.close();
});
