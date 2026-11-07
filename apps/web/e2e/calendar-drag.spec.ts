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
 * Task 221: in the cabinet calendar the owner drags a visit with the mouse to another
 * specialist and time, confirms the move, then drags it before working hours and saves it
 * with "Zapisz także poza godzinami pracy". Screenshots 221 (the confirmation) and 221-a
 * (the error and the outside-hours choice). Task 223: "Umów ponownie" from the visit card,
 * screenshot 223.
 */

const PASSWORD = 'e2e-password-123';
const run = Date.now().toString(36);
const OWNER = `drag-owner-${run}@example.com`;
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

const minutes = (clock: string) => {
  const [h, m] = clock.split(':').map(Number);
  return h! * 60 + m!;
};
const clock = (total: number) =>
  `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;

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

test('the owner drags a visit to another specialist and time, and before working hours', async ({
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

  // Tomorrow (UTC date, 08:00 UTC and later is the same day in Warsaw): one visit for Ilian.
  const tomorrow = new Date(Date.now() + 86_400_000);
  const day = tomorrow.toISOString().slice(0, 10);
  const at = (utcHour: number) =>
    new Date(
      Date.UTC(tomorrow.getUTCFullYear(), tomorrow.getUTCMonth(), tomorrow.getUTCDate(), utcHour),
    ).toISOString();
  const visit = await json<{ id: string }>(
    await request.post(`${base}/appointments`, {
      headers: owner,
      data: {
        serviceId: haircut.id,
        staffId: staff[0],
        start: at(8),
        allowOutsideHours: true,
        customer: {
          name: 'Jan Kowalski',
          phone: '+48600000221',
          email: `drag-client-${run}@example.com`,
        },
      },
    }),
  );

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
  await page.goto(`/pl/app/calendar?date=${day}`);
  await expect(page.getByText('Przeciągnij wizytę myszką')).toBeVisible();

  const event = page.getByRole('button', { name: /Jan Kowalski/ });
  await expect(event).toBeVisible();
  const start = minutes(/(\d{2}:\d{2})–/.exec((await event.textContent()) ?? '')![1]!);
  const ilian = page.locator(`[data-staff-col="${staff[0]}"]`);
  const marek = page.locator(`[data-staff-col="${staff[1]}"]`);

  // 1. Two hours later, to Marek: the salon sees what was and what will be, and confirms.
  await dragVisit(page, event, marek, 120);
  const sheet = page.getByRole('dialog');
  await expect(sheet.getByRole('heading', { name: 'Przenieść wizytę?' })).toBeVisible();
  const summary = sheet.getByTestId('move-summary');
  await expect(summary).toContainText(`${clock(start)}–${clock(start + 45)} · Ilian`);
  await expect(summary).toContainText(`${clock(start + 120)}–${clock(start + 165)} · Marek`);
  await expect(sheet).toContainText('Jan Kowalski');
  await shot(page, '221-calendar-drag');
  await sheet.getByRole('button', { name: 'Przenieś wizytę' }).click();
  await expect(sheet).toBeHidden();
  await expect(marek.getByRole('button', { name: /Jan Kowalski/ })).toContainText(
    `${clock(start + 120)}–`,
  );
  await expect(ilian.getByRole('button', { name: /Jan Kowalski/ })).toHaveCount(0);
  const moved = await json<{ staff: { id: string }; start: string }>(
    await request.get(`${base}/appointments/${visit.id}`, { headers: owner }),
  );
  expect(moved.staff.id).toBe(staff[1]);
  expect(new Date(moved.start).toISOString()).toBe(at(10));

  // A plain click still opens the visit card (no drag).
  await marek.getByRole('button', { name: /Jan Kowalski/ }).click();
  await expect(
    page.getByRole('dialog').getByRole('button', { name: 'Przenieś', exact: true }),
  ).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: 'Zamknij' }).click();

  // 2. Before working hours (07:00): the server refuses, the owner may still save it.
  const now = start + 120;
  await dragVisit(page, marek.getByRole('button', { name: /Jan Kowalski/ }), marek, 7 * 60 - now);
  await expect(sheet.getByTestId('move-summary')).toContainText('07:00–07:45 · Marek');
  await sheet.getByRole('button', { name: 'Przenieś wizytę' }).click();
  await expect(sheet.getByRole('alert')).toBeVisible();
  const outside = sheet.getByLabel('Zapisz także poza godzinami pracy');
  await expect(outside).toBeVisible();
  await expect(sheet.getByRole('button', { name: 'Przenieś wizytę' })).toBeDisabled();
  await outside.check();
  await shot(page, '221-a-calendar-drag-outside-hours');
  await sheet.getByRole('button', { name: 'Przenieś wizytę' }).click();
  await expect(sheet).toBeHidden();
  await expect(marek.getByRole('button', { name: /Jan Kowalski/ })).toContainText('07:00–07:45');

  // 3. Task 223: "Umów ponownie" in the visit card — the same client, service, specialist and
  // time are filled in; the salon picks the date and saves without typing the phone again.
  await marek.getByRole('button', { name: /Jan Kowalski/ }).click();
  const card = page.getByRole('dialog');
  await card.getByRole('button', { name: 'Umów ponownie' }).click();
  await expect(card.getByRole('heading', { name: 'Nowa wizyta' })).toBeVisible();
  await expect(card).toContainText('Jan Kowalski');
  await expect(card.getByLabel('Usługa', { exact: true })).toHaveValue(haircut.id);
  await expect(card.getByLabel('Specjalista', { exact: true })).toHaveValue(staff[1]!);
  await expect(card.getByLabel('Godzina', { exact: true })).toHaveValue('07:00');
  const nextWeek = new Date(tomorrow.getTime() + 7 * 86_400_000).toISOString().slice(0, 10);
  await card.getByLabel('Data', { exact: true }).fill(nextWeek);
  await card.getByLabel('Godzina', { exact: true }).fill('12:00');
  await shot(page, '223-book-again');
  await card.getByRole('button', { name: 'Zapisz wizytę' }).click();
  await expect(card).toBeHidden();
  await expect(marek.getByRole('button', { name: /Jan Kowalski/ })).toContainText('12:00–12:45');
  const first = await json<{ customer: { id: string } }>(
    await request.get(`${base}/appointments/${visit.id}`, { headers: owner }),
  );
  const again = await json<{ appointments: { customer: { id: string } | null }[] }>(
    await request.get(`${base}/calendar`, {
      headers: owner,
      params: { from: nextWeek, to: nextWeek },
    }),
  );
  expect(again.appointments).toHaveLength(1);
  expect(again.appointments[0]!.customer?.id).toBe(first.customer.id);
  await context.close();
});
