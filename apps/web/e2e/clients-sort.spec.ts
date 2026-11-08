import { expect, test, type APIResponse, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { freshAddress } from './addresses';
import { waitForEmail } from './mailpit';
import { serveApp } from './mobile-app';

/**
 * Task 279: "Kolejność" above the cabinet's client list — A–Z (the default), the latest visit
 * first, or the most visits first. Zenon came three times, Adam twice (the latest), Basia never.
 * The chosen order stays in the address (a reload keeps it). Screenshot 279.
 * Task 280: the same choice in the business app's "Klienci" (screenshot 280).
 * Task 281: "Najbliższa zaplanowana wizyta" — Basia is booked tomorrow, Zenon in two days
 * (screenshot 281); task 282: the same chip in the business app (screenshot 282).
 * Task 283: "Zapłacili najwięcej" — only Adam's visits are paid: Adam first, then the others by
 * name (screenshots 283, 283-a). Task 285: Adam's card shows "Średnio za wizytę" (screenshot 285);
 * task 286: the same in the business app (screenshot 286). Task 287: Adam's 12,50 zł tip as
 * "Napiwki łącznie" in the card (same screenshots); task 288: "Napiwki" in the business app.
 * Task 307: happy hours on Adam's visit as "Rabaty łącznie" (same screenshots); task 308: "Rabaty"
 * in the business app.
 * Task 290: both of Adam's visits were paid by card — "Zwykle płaci: Karta · 2×" in the card;
 * task 291: the same in the business app (same screenshots).
 * Task 301: Adam rated his visits 5 and 4 stars — "Oceny wizyt: ★ 4,5 · opinie: 2" in the card;
 * task 302: the same in the business app (same screenshots).
 */

const PASSWORD = 'e2e-password-123';
const run = Date.now().toString(36);
const OWNER = `sort-owner-${run}@example.com`;
const HOUR = 60 * 60_000;

const shot = (page: Page, name: string) => page.screenshot({ path: `e2e/screenshots/${name}.png` });

async function json<T>(res: APIResponse): Promise<T> {
  expect(res.ok(), `${res.url()} → ${res.status()} ${await res.text()}`).toBeTruthy();
  return (res.status() === 204 ? undefined : await res.json()) as T;
}

test('the owner sorts the clients by the latest visit and by the number of visits', async ({
  browser,
  request,
}) => {
  const address = freshAddress();
  await json(
    await request.post('/v1/auth/register', {
      headers: address,
      data: { email: OWNER, password: PASSWORD, name: 'Aleksander Owner' },
    }),
  );
  const mail = await waitForEmail(OWNER, /Potwierdź adres/);
  const token = /token=([^\s&]+)/.exec(mail.text)?.[1];
  await json(
    await request.post('/v1/auth/verify-email', { data: { token: decodeURIComponent(token!) } }),
  );
  const login = await json<{ accessToken: string }>(
    await request.post('/v1/auth/login', {
      headers: address,
      data: { email: OWNER, password: PASSWORD, clientType: 'mobile' },
    }),
  );
  const owner = { Authorization: `Bearer ${login.accessToken}` };
  const org = await json<{ id: string }>(
    await request.post('/v1/organizations', { headers: owner, data: { name: 'Kolejność Barber' } }),
  );
  const location = await json<{ id: string }>(
    await request.post(`/v1/organizations/${org.id}/locations`, {
      headers: owner,
      data: {
        name: 'Kolejność Barber',
        addressLine: 'ul. Józefa Bema 91',
        city: 'Warszawa',
        postalCode: '01-233',
      },
    }),
  );
  const salon = `/v1/organizations/${org.id}/locations/${location.id}`;
  const service = await json<{ id: string }>(
    await request.post(`${salon}/services`, {
      headers: owner,
      data: { name: 'Strzyżenie', durationMinutes: 30, priceGrosze: 8000 },
    }),
  );
  const staff = await json<{ id: string }>(
    await request.post(`${salon}/staff`, {
      headers: owner,
      data: { displayName: 'Kasia', serviceIds: [service.id] },
    }),
  );
  const client = async (name: string, phone: string) =>
    (
      await json<{ id: string }>(
        await request.post(`/v1/organizations/${org.id}/customers`, {
          headers: owner,
          data: { name, phone },
        }),
      )
    ).id;
  const zenon = await client('Zenon Stały', '+48600000791');
  const adam = await client('Adam Świeży', '+48600000792');
  const basia = await client('Basia Bez Wizyt', '+48600000793');
  // Visits entered afterwards as "came", on 5-minute marks a few hours ago.
  const visit = (customerId: string, hoursAgo: number, paid = false, paymentMethod?: string) =>
    request
      .post(`${salon}/appointments`, {
        headers: owner,
        data: {
          serviceId: service.id,
          staffId: staff.id,
          start: new Date(
            Math.floor((Date.now() - hoursAgo * HOUR) / 300_000) * 300_000,
          ).toISOString(),
          customerId,
          alreadyHappened: true,
          paid,
          paymentMethod,
          allowOutsideHours: true,
        },
      })
      .then(json);
  await visit(zenon, 6);
  await visit(zenon, 5);
  await visit(zenon, 4);
  // Task 283: only Adam's visits are paid — task 290: both by card.
  const adamFirst = (await visit(adam, 3, true, 'card')) as { id: string };
  const adamVisit = (await visit(adam, 2, true, 'card')) as { id: string; version: number };
  // Task 287: Adam left a 12,50 zł tip.
  await json(
    await request.put(`${salon}/appointments/${adamVisit.id}/tip`, {
      headers: owner,
      data: { version: adamVisit.version, tipGrosze: 1250 },
    }),
  );
  // Task 301: Adam rated his two visits 5 and 4 stars.
  execFileSync('psql', [
    (process.env.DATABASE_URL ?? '').replace(/\?.*$/, ''),
    '-v',
    'ON_ERROR_STOP=1',
    '-c',
    `INSERT INTO visit_review (id, appointment_id, location_id, staff_id, rating, updated_at) SELECT gen_random_uuid(), id, location_id, staff_id, CASE WHEN id = '${adamFirst.id}' THEN 5 ELSE 4 END, now() FROM appointment WHERE id IN ('${adamFirst.id}', '${adamVisit.id}')`,
    // Task 307: happy hours took 15 zł off Adam's second visit (it still cost 80 zł).
    '-c',
    `UPDATE appointment SET list_price_grosze = price_grosze + 1500, happy_hour_percent = 15 WHERE id = '${adamVisit.id}'`,
  ]);
  // Task 281: booked ahead — Basia tomorrow, Zenon in two days.
  const book = (customerId: string, hoursAhead: number) =>
    request
      .post(`${salon}/appointments`, {
        headers: owner,
        data: {
          serviceId: service.id,
          staffId: staff.id,
          start: new Date(
            Math.floor((Date.now() + hoursAhead * HOUR) / 300_000) * 300_000,
          ).toISOString(),
          customerId,
          allowOutsideHours: true,
        },
      })
      .then(json);
  await book(zenon, 48);
  await book(basia, 24);

  const desk = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    locale: 'pl-PL',
    timezoneId: 'Europe/Warsaw',
    extraHTTPHeaders: address,
  });
  const page = await desk.newPage();
  await page.goto('/pl/login');
  await page.getByLabel('E-mail').fill(OWNER);
  await page.getByLabel('Hasło').fill(PASSWORD);
  await page.getByRole('button', { name: 'Zaloguj się' }).click();
  await page.waitForURL(/\/pl\/app\//);
  await page.goto('/pl/app/clients');

  const rows = page.locator('.list-row');
  const order = page.getByTestId('clients-sort');
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText('Adam Świeży');
  await expect(rows.nth(1)).toContainText('Basia Bez Wizyt');
  await expect(rows.nth(2)).toContainText('Zenon Stały');

  await order.selectOption({ label: 'Najwięcej wizyt' });
  await expect(rows.nth(0)).toContainText('Zenon Stały');
  await expect(rows.nth(1)).toContainText('Adam Świeży');
  await expect(rows.nth(2)).toContainText('Basia Bez Wizyt');
  await expect(page).toHaveURL(/sort=visits/);
  await shot(page, '279-clients-sort');

  await order.selectOption({ label: 'Ostatnia wizyta — najnowsze' });
  await expect(rows.nth(0)).toContainText('Adam Świeży');
  await expect(rows.nth(1)).toContainText('Zenon Stały');
  await expect(rows.nth(2)).toContainText('Basia Bez Wizyt');

  // A reload keeps the order (task 272: the address).
  await page.reload();
  await expect(order).toHaveValue('recent');
  await expect(rows.nth(0)).toContainText('Adam Świeży');

  // Task 281: the nearest booked visit first, then the others by name.
  await order.selectOption({ label: 'Najbliższa zaplanowana wizyta' });
  await expect(rows.nth(0)).toContainText('Basia Bez Wizyt');
  await expect(rows.nth(1)).toContainText('Zenon Stały');
  await expect(rows.nth(2)).toContainText('Adam Świeży');
  await expect(page).toHaveURL(/sort=next/);
  await shot(page, '281-clients-sort-next');

  // Task 283: who paid the most first, then the others by name.
  await order.selectOption({ label: 'Zapłacili najwięcej' });
  await expect(rows.nth(0)).toContainText('Adam Świeży');
  await expect(rows.nth(1)).toContainText('Basia Bez Wizyt');
  await expect(rows.nth(2)).toContainText('Zenon Stały');
  await expect(page).toHaveURL(/sort=paid/);
  await shot(page, '283-clients-sort-paid');

  // Task 285: what one paid visit brings on average, in the client card.
  await page.getByRole('button', { name: /Adam Świeży/ }).click();
  const summary = page.getByTestId('client-summary');
  await summary.scrollIntoViewIfNeeded();
  await expect(summary).toContainText('Średnio za wizytę');
  await expect(summary).toContainText(/Średnio za wizytę\s*80,00/);
  // Task 287: the tips Adam left.
  await expect(summary).toContainText(/Napiwki łącznie\s*12,50/);
  // Task 307: what Adam saved.
  await expect(summary).toContainText(/Rabaty łącznie\s*15,00/);
  // Task 290: how Adam usually pays.
  await expect(summary).toContainText(/Zwykle płaci\s*Karta · 2×/);
  // Task 301: how Adam rated his visits.
  await expect(summary).toContainText(/Oceny wizyt\s*★ 4,5 · opinie: 2/);
  await shot(page, '285-client-average-visit');
  await page.keyboard.press('Escape');

  // A filter with its own order hides the choice.
  await page.getByRole('button', { name: /Nowi \(30 dni\)/ }).click();
  await expect(order).toHaveCount(0);
  await expect(rows).toHaveCount(2);
  await desk.close();

  // Task 280: the business app.
  const businessApp = await serveApp('mobile-business');
  try {
    const phone = await browser.newContext({
      viewport: { width: 390, height: 844 },
      locale: 'pl-PL',
      isMobile: true,
      extraHTTPHeaders: freshAddress(),
    });
    const app = await phone.newPage();
    await app.goto(businessApp.url);
    await app.getByLabel('E-mail lub telefon').fill(OWNER);
    await app.getByRole('button', { name: 'Wyślij kod' }).click();
    const code = await waitForEmail(OWNER, /Kod logowania do aplikacji salonu/);
    await app.getByLabel('Kod', { exact: true }).fill(/\b(\d{6})\b/.exec(code.text)![1]!);
    await app.getByRole('button', { name: 'Zaloguj się' }).click();
    await expect(app.getByRole('button', { name: 'Dziś' })).toBeVisible();
    await app.getByRole('button', { name: 'Klienci' }).click();
    const cards = app.getByRole('button', { name: /^Karta klienta: / });
    await expect(cards).toHaveCount(3);
    await expect(cards.nth(0)).toContainText('Adam Świeży');
    await app.getByRole('radio', { name: 'Najwięcej wizyt' }).click();
    await expect(cards.nth(0)).toContainText('Zenon Stały');
    await expect(cards.nth(1)).toContainText('Adam Świeży');
    await expect(cards.nth(2)).toContainText('Basia Bez Wizyt');
    await shot(app, '280-business-app-clients-sort');
    await app.getByRole('radio', { name: 'Ostatnia wizyta' }).click();
    await expect(cards.nth(0)).toContainText('Adam Świeży');
    await expect(cards.nth(1)).toContainText('Zenon Stały');
    // Task 282: the nearest booked visit first.
    await app.getByRole('radio', { name: 'Najbliższa wizyta' }).click();
    await expect(cards.nth(0)).toContainText('Basia Bez Wizyt');
    await expect(cards.nth(1)).toContainText('Zenon Stały');
    await expect(cards.nth(2)).toContainText('Adam Świeży');
    await shot(app, '282-business-app-clients-sort-next');
    // Task 283: who paid the most first.
    await app.getByRole('radio', { name: 'Zapłacili najwięcej' }).click();
    await expect(cards.nth(0)).toContainText('Adam Świeży');
    await expect(cards.nth(1)).toContainText('Basia Bez Wizyt');
    await expect(cards.nth(2)).toContainText('Zenon Stały');
    await shot(app, '283-a-business-app-clients-sort-paid');
    // Task 286: the average paid visit in the client card.
    await app.getByRole('button', { name: 'Karta klienta: Adam Świeży' }).click();
    await expect(app.getByText(/^Średnio za wizytę: 80,00/)).toBeVisible();
    // Task 288: the tips in the business app's card.
    await expect(app.getByText(/^Napiwki: 12,50/)).toBeVisible();
    // Task 308: the same in the business app's card.
    await expect(app.getByText(/^Rabaty: 15,00/)).toBeVisible();
    // Task 291: how Adam usually pays.
    await expect(app.getByText('Zwykle płaci: Karta')).toBeVisible();
    // Task 302: the ratings in the business app's card.
    await expect(app.getByText('Oceny: ★ 4,5 · opinie: 2')).toBeVisible();
    await shot(app, '286-business-app-client-average-visit');
    await phone.close();
  } finally {
    businessApp.server.close();
  }
});
