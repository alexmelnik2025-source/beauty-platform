import {
  expect,
  test,
  type APIRequestContext,
  type APIResponse,
  type Page,
} from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { freshAddress } from './addresses';
import { waitForEmail } from './mailpit';
import { serveApp } from './mobile-app';

/**
 * Task 240: the client's birthday (day and month, no year) in the cabinet card, and "Urodziny w
 * ciągu 7 dni" above the client list — soonest first, with the date. Screenshots 240 and 240-a; the
 * business app shows the same list and the birthday in the card (240-b).
 * Task 245: "Zgoda na wiadomości" — only clients who agreed to the salon messages (245, 245-a).
 * Task 248: "Nowi (30 dni)" — clients whose first visit was in the last 30 days (248, 248-a).
 * Task 250: "Wraca zwykle co N dni" in the client card (250, 250-a).
 * Task 261: "Ulubiona usługa" and "Ulubiony specjalista" in the client card (261, 261-a).
 * Task 262: "Pora wrócić" — regular clients past their usual break with nothing booked (262, 262-a).
 * Task 264: "Nie przyszli" — clients who did not come in the last year (264, 264-a).
 * Task 265: "Nie przyszli: N" in the report, with a link to that list (265, 265-a).
 * Task 263: "Pora wrócić: N" in the report, with a link to that list (263, 263-a).
 * Task 269: the owner downloads all clients as CSV in the business app (269).
 * Task 270: "Byli tylko raz" — clients who came once, a month to a year ago (270, 270-a).
 * Task 271: "Byli tylko raz: N" in the report, with a link to that list (271, 271-a).
 */

const PASSWORD = 'e2e-password-123';
const run = Date.now().toString(36);
const OWNER = `birthday-owner-${run}@example.com`;
const DESKTOP = { width: 1280, height: 900 };
const PHONE = { width: 390, height: 844 };
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

/** "MM-DD" `days` from today. */
const mmdd = (days: number): string => {
  const d = new Date(Date.now() + days * 24 * 60 * 60_000);
  return `${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
};

test('the owner writes down a birthday and sees the birthdays of the week', async ({
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
        name: `Urodziny ${run}`,
        addressLine: 'ul. Józefa Bema 91',
        city: 'Warszawa',
        postalCode: '01-233',
      },
    }),
  );
  const clients: [string, string, string | null][] = [
    ['Jan Kowalski', '+48600000251', mmdd(3)],
    ['Adam Nowak', '+48600000252', mmdd(1)],
    ['Piotr Zieliński', '+48600000253', mmdd(20)],
    ['Ewa Wiśniewska', '+48600000254', null],
  ];
  for (const [name, phone, birthday] of clients) {
    await json(
      await request.post(`/v1/organizations/${org.id}/customers`, {
        headers: owner,
        data: { name, phone, ...(birthday ? { birthday } : {}) },
      }),
    );
  }

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
  await page.waitForURL(/\/pl\/app\//);
  await page.goto('/pl/app/clients');
  const rows = page.locator('.list .list-row');
  await expect(rows).toHaveCount(4);

  // Ewa tells her birthday: 15 March.
  await rows.filter({ hasText: 'Ewa Wiśniewska' }).click();
  const card = page.getByRole('dialog');
  await card.getByLabel('Dzień', { exact: true }).selectOption('15');
  await card.getByLabel('Miesiąc', { exact: true }).selectOption({ label: 'marzec' });
  await expect(card.getByText('Tylko dzień i miesiąc, bez roku.')).toBeVisible();
  await shot(page, '240-a-client-birthday-card');
  await card.locator('form.form').getByRole('button', { name: 'Zapisz', exact: true }).click();
  await expect(card).toBeHidden();
  await rows.filter({ hasText: 'Ewa Wiśniewska' }).click();
  await expect(card.getByLabel('Dzień', { exact: true })).toHaveValue('15');
  await expect(card.getByLabel('Miesiąc', { exact: true })).toHaveValue('3');
  await page.keyboard.press('Escape');
  await expect(card).toBeHidden();

  // Birthdays of the next 7 days: Adam (tomorrow) first, then Jan; Piotr is later, Ewa in March.
  const filter = page.getByRole('button', { name: /Urodziny w ciągu 7 dni/ });
  await filter.click();
  await expect(filter).toHaveAttribute('aria-pressed', 'true');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText('Adam Nowak');
  await expect(rows.nth(1)).toContainText('Jan Kowalski');
  await expect(rows.nth(1)).toContainText('🎂');
  await shot(page, '240-client-birthdays');
  await filter.click();
  await expect(rows).toHaveCount(4);

  // Task 245: Jan agreed to the salon messages; Piotr agreed and then unsubscribed.
  const sql = (statement: string) =>
    execFileSync('psql', [
      (process.env.DATABASE_URL ?? '').replace(/\?.*$/, ''),
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      statement,
    ]);
  const consent = (phone: string, granted: boolean, minutesAgo: number) =>
    sql(
      `INSERT INTO consent_record (id, customer_id, type, version, granted, created_at) SELECT gen_random_uuid(), id, 'marketing', 'e2e', ${granted}, now() - interval '${minutesAgo} minutes' FROM customer WHERE organization_id = '${org.id}' AND phone = '${phone}'`,
    );
  consent('+48600000251', true, 10);
  consent('+48600000253', true, 20);
  consent('+48600000253', false, 5);
  const consented = page.getByRole('button', { name: /Zgoda na wiadomości/ });
  await consented.click();
  await expect(consented).toHaveAttribute('aria-pressed', 'true');
  await expect(rows).toHaveCount(1);
  await expect(rows.nth(0)).toContainText('Jan Kowalski');
  await shot(page, '245-clients-consented');
  await consented.click();
  await expect(rows).toHaveCount(4);

  // Task 243: a visit on the client's birthday is marked in the calendar and in the visit card.
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
  // Ten days ahead at 12:00 UTC (the same day in Warsaw), so not among "the next 7 days".
  const start = new Date(Date.now() + 10 * 24 * 60 * 60_000);
  start.setUTCHours(12, 0, 0, 0);
  const marek = await json<{ id: string }>(
    await request.post(`/v1/organizations/${org.id}/customers`, {
      headers: owner,
      data: { name: 'Marek Lewandowski', phone: '+48600000255', birthday: mmdd(10) },
    }),
  );
  const visit = await json<{ date: string; customer: { birthdayToday: boolean } }>(
    await request.post(`${salon}/appointments`, {
      headers: owner,
      data: {
        serviceId: service.id,
        staffId: staff.id,
        start: start.toISOString(),
        customerId: marek.id,
        allowOutsideHours: true,
      },
    }),
  );
  expect(visit.customer.birthdayToday).toBe(true);
  await page.goto(`/pl/app/calendar?date=${visit.date}`);
  const block = page.getByRole('button', { name: /🎂 Marek Lewandowski/ });
  await expect(block).toBeVisible();
  await block.click();
  await expect(page.getByRole('dialog').getByText('🎂 Urodziny w dniu wizyty')).toBeVisible();
  await shot(page, '243-birthday-visit');
  await page.keyboard.press('Escape');

  // Task 248: Jan came for the first time today — "Nowi (30 dni)" lists only him.
  const [jan] = await json<{ id: string }[]>(
    await request.get(`/v1/organizations/${org.id}/customers?search=Jan%20Kowalski`, {
      headers: owner,
    }),
  );
  const firstVisit = new Date(Math.floor((Date.now() - 3 * 60 * 60_000) / 300_000) * 300_000);
  await json(
    await request.post(`${salon}/appointments`, {
      headers: owner,
      data: {
        serviceId: service.id,
        staffId: staff.id,
        start: firstVisit.toISOString(),
        customerId: jan!.id,
        alreadyHappened: true,
        allowOutsideHours: true,
      },
    }),
  );
  // Task 250: Jan also came 10 and 20 days ago — he usually comes back every 10 days.
  const sql250 = (statement: string) =>
    execFileSync('psql', [
      (process.env.DATABASE_URL ?? '').replace(/\?.*$/, ''),
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      statement,
    ]);
  for (const daysAgo of [10, 20]) {
    const earlier = await json<{ id: string }>(
      await request.post(`${salon}/appointments`, {
        headers: owner,
        data: {
          serviceId: service.id,
          staffId: staff.id,
          start: new Date(firstVisit.getTime() - (daysAgo / 10) * 60 * 60_000).toISOString(),
          customerId: jan!.id,
          alreadyHappened: true,
          allowOutsideHours: true,
        },
      }),
    );
    sql250(
      `UPDATE appointment SET start_at = start_at - interval '${daysAgo} days' + interval '${daysAgo / 10} hours', end_at = end_at - interval '${daysAgo} days' + interval '${daysAgo / 10} hours', blocked_until = blocked_until - interval '${daysAgo} days' + interval '${daysAgo / 10} hours' WHERE id = '${earlier.id}'`,
    );
  }
  await page.goto('/pl/app/clients');
  await expect(rows).toHaveCount(5);
  const newcomers = page.getByRole('button', { name: /Nowi \(30 dni\)/ });
  await newcomers.click();
  await expect(newcomers).toHaveAttribute('aria-pressed', 'true');
  await expect(rows).toHaveCount(1);
  await expect(rows.nth(0)).toContainText('Jan Kowalski');
  await shot(page, '248-clients-newcomers');
  await rows.nth(0).click();
  const summary = page.getByRole('dialog').getByTestId('client-summary');
  await expect(summary).toContainText('Wraca zwykle');
  await expect(summary).toContainText('co 10 dni · następna ok.');
  await summary.scrollIntoViewIfNeeded();
  await shot(page, '250-client-rhythm');
  // Task 261: three haircuts, all at Kasia's.
  await expect(summary).toContainText('Ulubiona usługa');
  await expect(summary).toContainText('Strzyżenie · 3×');
  await expect(summary).toContainText('Ulubiony specjalista');
  await expect(summary).toContainText('Kasia · 3×');
  await shot(page, '261-client-favorites');
  await page.keyboard.press('Escape');

  // Task 262: Piotr came 45, 30 and 15 days ago — every 15 days, so he is due now; Jan (every 10
  // days, last today) is not.
  const [piotr] = await json<{ id: string }[]>(
    await request.get(`/v1/organizations/${org.id}/customers?search=Piotr%20Zieli`, {
      headers: owner,
    }),
  );
  for (const [i, daysAgo] of [45, 30, 15].entries()) {
    const earlier = await json<{ id: string }>(
      await request.post(`${salon}/appointments`, {
        headers: owner,
        data: {
          serviceId: service.id,
          staffId: staff.id,
          start: new Date(firstVisit.getTime() + (i + 2) * 30 * 60_000).toISOString(),
          customerId: piotr!.id,
          alreadyHappened: true,
          allowOutsideHours: true,
        },
      }),
    );
    sql250(
      `UPDATE appointment SET start_at = start_at - interval '${daysAgo} days', end_at = end_at - interval '${daysAgo} days', blocked_until = blocked_until - interval '${daysAgo} days' WHERE id = '${earlier.id}'`,
    );
  }
  await page.reload();
  await expect(rows).toHaveCount(5);
  const overdue = page.getByRole('button', { name: /Pora wrócić/ });
  await overdue.click();
  await expect(overdue).toHaveAttribute('aria-pressed', 'true');
  await expect(rows).toHaveCount(1);
  await expect(rows.nth(0)).toContainText('Piotr Zieliński');
  await shot(page, '262-clients-overdue');
  // Task 263: the report counts Piotr and links to the list.
  await page.goto('/pl/app/reports');
  const overdueReport = page.getByTestId('report-overdue');
  await expect(overdueReport).toContainText('Pora wrócić: 1');
  await overdueReport.scrollIntoViewIfNeeded();
  await shot(page, '263-report-overdue');
  await overdueReport.getByRole('link', { name: 'Pokaż, komu pora wrócić' }).click();
  await page.waitForURL(/\/pl\/app\/clients\?overdue=1/);
  await expect(page.getByRole('button', { name: /Pora wrócić/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(rows).toHaveCount(1);
  await expect(rows.nth(0)).toContainText('Piotr Zieliński');
  // Task 264: Adam did not come to his visit 3 days ago — he is the only one under "Nie przyszli".
  const [adam] = await json<{ id: string }[]>(
    await request.get(`/v1/organizations/${org.id}/customers?search=Adam%20Nowak`, {
      headers: owner,
    }),
  );
  const missed = await json<{ id: string }>(
    await request.post(`${salon}/appointments`, {
      headers: owner,
      data: {
        serviceId: service.id,
        staffId: staff.id,
        start: new Date(firstVisit.getTime() - 45 * 60_000).toISOString(),
        customerId: adam!.id,
        alreadyHappened: true,
        allowOutsideHours: true,
      },
    }),
  );
  sql250(
    `UPDATE appointment SET status = 'no_show', start_at = start_at - interval '3 days', end_at = end_at - interval '3 days', blocked_until = blocked_until - interval '3 days' WHERE id = '${missed.id}'`,
  );
  await page.goto('/pl/app/clients');
  await expect(rows).toHaveCount(5);
  const noShows = page.getByRole('button', { name: /Nie przyszli/ });
  await noShows.click();
  await expect(noShows).toHaveAttribute('aria-pressed', 'true');
  await expect(rows).toHaveCount(1);
  await expect(rows.nth(0)).toContainText('Adam Nowak');
  await shot(page, '264-clients-no-shows');
  // Task 265: the report counts Adam and links to the list.
  await page.goto('/pl/app/reports');
  const noShowReport = page.getByTestId('report-no-shows');
  await expect(noShowReport).toContainText('Nie przyszli: 1');
  await noShowReport.scrollIntoViewIfNeeded();
  await shot(page, '265-report-no-shows');
  await noShowReport.getByRole('link', { name: 'Pokaż, kto nie przyszedł' }).click();
  await page.waitForURL(/\/pl\/app\/clients\?noShows=1/);
  await expect(page.getByRole('button', { name: /Nie przyszli/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(rows).toHaveCount(1);
  await expect(rows.nth(0)).toContainText('Adam Nowak');
  // Task 270: Ewa came once, 60 days ago, and has not booked again — she is the only one under
  // "Byli tylko raz" (Adam's only visit was a no-show, Marek's is ahead).
  const [ewa] = await json<{ id: string }[]>(
    await request.get(`/v1/organizations/${org.id}/customers?search=Ewa%20Wi`, {
      headers: owner,
    }),
  );
  const ewaVisit = await json<{ id: string }>(
    await request.post(`${salon}/appointments`, {
      headers: owner,
      data: {
        serviceId: service.id,
        staffId: staff.id,
        start: new Date(firstVisit.getTime() - 90 * 60_000).toISOString(),
        customerId: ewa!.id,
        alreadyHappened: true,
        allowOutsideHours: true,
      },
    }),
  );
  sql250(
    `UPDATE appointment SET start_at = start_at - interval '60 days', end_at = end_at - interval '60 days', blocked_until = blocked_until - interval '60 days' WHERE id = '${ewaVisit.id}'`,
  );
  await page.goto('/pl/app/clients');
  await expect(rows).toHaveCount(5);
  const once = page.getByRole('button', { name: /Byli tylko raz/ });
  await once.click();
  await expect(once).toHaveAttribute('aria-pressed', 'true');
  await expect(rows).toHaveCount(1);
  await expect(rows.nth(0)).toContainText('Ewa Wiśniewska');
  await shot(page, '270-clients-once');
  // Task 271: the report counts Ewa and links to the list.
  await page.goto('/pl/app/reports');
  const onceReport = page.getByTestId('report-once');
  await expect(onceReport).toContainText('Byli tylko raz: 1');
  await onceReport.scrollIntoViewIfNeeded();
  await shot(page, '271-report-once');
  await onceReport.getByRole('link', { name: 'Pokaż, kto był tylko raz' }).click();
  await page.waitForURL(/\/pl\/app\/clients\?once=1/);
  await expect(page.getByRole('button', { name: /Byli tylko raz/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(rows).toHaveCount(1);
  await expect(rows.nth(0)).toContainText('Ewa Wiśniewska');
  await context.close();

  // Business app (task 240b).
  const businessApp = await serveApp('mobile-business');
  try {
    const phone = await browser.newContext({
      viewport: PHONE,
      locale: 'pl-PL',
      isMobile: true,
      extraHTTPHeaders: freshAddress(),
    });
    const app = await phone.newPage();
    await app.goto(businessApp.url);
    await app.getByLabel('E-mail lub telefon').fill(OWNER);
    await app.getByRole('button', { name: 'Wyślij kod' }).click();
    const mail = await waitForEmail(OWNER, /Kod logowania do aplikacji salonu/);
    await app.getByLabel('Kod', { exact: true }).fill(/\b(\d{6})\b/.exec(mail.text)![1]!);
    await app.getByRole('button', { name: 'Zaloguj się' }).click();
    await expect(app.getByRole('button', { name: 'Dziś' })).toBeVisible();
    await app.getByRole('button', { name: 'Klienci' }).click();
    await expect(app.getByText('Ewa Wiśniewska')).toBeVisible();
    await app.getByRole('switch', { name: /Urodziny w ciągu 7 dni/ }).click();
    await expect(app.getByText('Ewa Wiśniewska')).toHaveCount(0);
    await expect(app.getByText('Piotr Zieliński')).toHaveCount(0);
    const cards = app.getByRole('button', { name: /^Karta klienta: / });
    await expect(cards).toHaveCount(2);
    await expect(cards.nth(0)).toContainText('Adam Nowak');
    await expect(cards.nth(1)).toContainText('Jan Kowalski');
    await shot(app, '240-b-business-app-birthdays');
    await app.getByRole('switch', { name: /Urodziny w ciągu 7 dni/ }).click();
    // Task 245 in the app: only Jan agreed to the salon messages (Piotr unsubscribed).
    await app.getByRole('switch', { name: /Zgoda na wiadomości/ }).click();
    await expect(cards).toHaveCount(1);
    await expect(cards.nth(0)).toContainText('Jan Kowalski');
    await shot(app, '245-a-business-app-consented');
    await app.getByRole('switch', { name: /Zgoda na wiadomości/ }).click();
    // Task 248 in the app: only Jan is a new client.
    await app.getByRole('switch', { name: /Nowi \(30 dni\)/ }).click();
    await expect(cards).toHaveCount(1);
    await expect(cards.nth(0)).toContainText('Jan Kowalski');
    await shot(app, '248-a-business-app-newcomers');
    // Task 250: Jan's card says he usually comes back every 10 days.
    await cards.nth(0).click();
    await expect(app.getByText('wraca zwykle co 10 dni')).toBeVisible();
    await shot(app, '250-a-business-app-client-rhythm');
    await expect(app.getByText('najczęściej: Strzyżenie (3×)')).toBeVisible();
    await expect(app.getByText('najczęściej u: Kasia (3×)')).toBeVisible();
    await shot(app, '261-a-business-app-client-favorites');
    await app.getByRole('button', { name: '‹ Wróć' }).first().click();
    await expect(cards).toHaveCount(1);
    await app.getByRole('switch', { name: /Nowi \(30 dni\)/ }).click();
    // Task 262 in the app: only Piotr is due to come back.
    await app.getByRole('switch', { name: /Pora wrócić/ }).click();
    await expect(cards).toHaveCount(1);
    await expect(cards.nth(0)).toContainText('Piotr Zieliński');
    await shot(app, '262-a-business-app-overdue');
    await app.getByRole('switch', { name: /Pora wrócić/ }).click();
    // Task 264 in the app: only Adam did not come.
    await app.getByRole('switch', { name: /Nie przyszli/ }).click();
    await expect(cards).toHaveCount(1);
    await expect(cards.nth(0)).toContainText('Adam Nowak');
    await shot(app, '264-a-business-app-no-shows');
    await app.getByRole('switch', { name: /Nie przyszli/ }).click();
    // Task 270 in the app: only Ewa came once.
    await app.getByRole('switch', { name: /Byli tylko raz/ }).click();
    await expect(cards).toHaveCount(1);
    await expect(cards.nth(0)).toContainText('Ewa Wiśniewska');
    await shot(app, '270-a-business-app-once');
    await app.getByRole('switch', { name: /Byli tylko raz/ }).click();
    // Task 269: the owner downloads the cabinet's clients CSV right in the app.
    const csvButton = app.getByRole('button', { name: 'Pobierz CSV klientów' });
    await expect(csvButton).toBeVisible();
    const [clientsCsv] = await Promise.all([app.waitForEvent('download'), csvButton.click()]);
    expect(clientsCsv.suggestedFilename()).toMatch(/^klienci-\d{4}-\d{2}-\d{2}\.csv$/);
    const clientsText = await readFile((await clientsCsv.path())!, 'utf8');
    expect(clientsText).toContain('"Imię i nazwisko"');
    expect(clientsText).toContain('"Adam Nowak"');
    await csvButton.scrollIntoViewIfNeeded();
    await shot(app, '269-business-app-clients-csv');
    await expect(app.getByRole('button', { name: 'Karta klienta: Ewa Wiśniewska' })).toBeVisible();
    await app.getByRole('button', { name: 'Karta klienta: Ewa Wiśniewska' }).click();
    await expect(app.getByText('🎂 Urodziny: 15 marca')).toBeVisible();
    // Task 241: the owner changes it right in the app.
    await app.getByRole('button', { name: '🎂 Zmień datę urodzin' }).click();
    await expect(app.getByLabel('Dzień', { exact: true })).toHaveValue('15');
    await expect(app.getByLabel('Miesiąc (1–12)')).toHaveValue('3');
    await app.getByLabel('Dzień', { exact: true }).fill('31');
    await app.getByLabel('Miesiąc (1–12)').fill('4');
    await app.getByRole('button', { name: 'Zapisz', exact: true }).first().click();
    // 31 April does not exist: the hint shows again as an error.
    await expect(app.getByText('Wpisz dzień i miesiąc, np. 15 i 3 — bez roku.')).toHaveCount(2);
    await app.getByLabel('Dzień', { exact: true }).fill('16');
    await app.getByLabel('Miesiąc (1–12)').fill('3');
    await shot(app, '241-business-app-birthday-edit');
    await app.getByRole('button', { name: 'Zapisz', exact: true }).first().click();
    await expect(app.getByText('🎂 Urodziny: 16 marca')).toBeVisible();
    await expect(app.getByText('Zapisano datę urodzin.')).toBeVisible();
    // Task 263 in the app: "Pora wrócić: 1" in the report opens the list with Piotr.
    await app.getByRole('button', { name: '‹ Wróć' }).first().click();
    await expect(app.getByRole('button', { name: 'Karta klienta: Ewa Wiśniewska' })).toBeVisible();
    await app.getByRole('button', { name: '‹ Wróć' }).first().click();
    await app.getByRole('button', { name: 'Raporty' }).click();
    const appOverdue = app.getByTestId('report-overdue');
    await expect(appOverdue).toContainText('Pora wrócić: 1');
    await appOverdue.scrollIntoViewIfNeeded();
    await shot(app, '263-a-business-app-report-overdue');
    await app.getByRole('button', { name: 'Pokaż, komu pora wrócić' }).click();
    // The switch is on: the list shows only the client it filters (as in task 249).
    await expect(app.getByRole('switch', { name: /Pora wrócić/ })).toBeVisible();
    await expect(cards).toHaveCount(1);
    await expect(cards.nth(0)).toContainText('Piotr Zieliński');
    // Task 265 in the app: "Nie przyszli: 1" in the report opens the list with Adam.
    await app.getByRole('button', { name: '‹ Wróć' }).first().click();
    const appNoShows = app.getByTestId('report-no-shows');
    await expect(appNoShows).toContainText('Nie przyszli: 1');
    await appNoShows.scrollIntoViewIfNeeded();
    await shot(app, '265-a-business-app-report-no-shows');
    await app.getByRole('button', { name: 'Pokaż, kto nie przyszedł' }).click();
    await expect(app.getByRole('switch', { name: /Nie przyszli/ })).toBeVisible();
    await expect(cards).toHaveCount(1);
    await expect(cards.nth(0)).toContainText('Adam Nowak');
    // Task 271 in the app: "Byli tylko raz: 1" in the report opens the list with Ewa.
    await app.getByRole('button', { name: '‹ Wróć' }).first().click();
    const appOnce = app.getByTestId('report-once');
    await expect(appOnce).toContainText('Byli tylko raz: 1');
    await appOnce.scrollIntoViewIfNeeded();
    await shot(app, '271-a-business-app-report-once');
    await app.getByRole('button', { name: 'Pokaż, kto był tylko raz' }).click();
    await expect(app.getByRole('switch', { name: /Byli tylko raz/ })).toBeVisible();
    await expect(cards).toHaveCount(1);
    await expect(cards.nth(0)).toContainText('Ewa Wiśniewska');
    await phone.close();
  } finally {
    businessApp.server.close();
  }
});
