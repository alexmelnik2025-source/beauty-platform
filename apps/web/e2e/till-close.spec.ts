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
 * Task 232: "Zamknij kasę". A visit paid in cash (90 zł) yesterday; in "Kasa dnia" the owner
 * types the cash counted in the till — 80 zł — and sees "brakuje 10,00 zł" (screenshot 232),
 * then counts again and it matches (232-a). The business app shows the closed till under
 * "Kasa dnia" and counts it again (232-b). Task 233: the report lists the counted day (233),
 * and the business app's report too (235). Task 236: cash taken out of the till (236), put in from the
 * business app (236-a); the report shows it beside the closed day (237).
 */

const PASSWORD = 'e2e-password-123';
const run = Date.now().toString(36);
const OWNER = `till-owner-${run}@example.com`;
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

test('the owner closes the till: counted cash beside the cash visits of the day', async ({
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
  const service = await json<{ id: string }>(
    await request.post(`${base}/services`, {
      headers: owner,
      data: { name: 'Strzyżenie męskie', durationMinutes: 45, priceGrosze: 9000, bufferMinutes: 0 },
    }),
  );
  const staff = await json<{ id: string }>(
    await request.post(`${base}/staff`, {
      headers: owner,
      data: { displayName: 'Ilian', serviceIds: [service.id] },
    }),
  );
  // Visits can't be booked in the past: book tomorrow at 10:00 UTC and move it a day back.
  const tomorrow = new Date(Date.now() + 86_400_000);
  const booked = await json<{ id: string; version: number }>(
    await request.post(`${base}/appointments`, {
      headers: owner,
      data: {
        serviceId: service.id,
        staffId: staff.id,
        start: new Date(
          Date.UTC(tomorrow.getUTCFullYear(), tomorrow.getUTCMonth(), tomorrow.getUTCDate(), 10),
        ).toISOString(),
        allowOutsideHours: true,
        customer: {
          name: 'Jan Kowalski',
          phone: '+48600000232',
          email: `jan-${run}@example.com`,
        },
      },
    }),
  );
  execFileSync('psql', [
    (process.env.DATABASE_URL ?? '').replace(/\?.*$/, ''),
    '-v',
    'ON_ERROR_STOP=1',
    '-c',
    `UPDATE appointment SET start_at = start_at - interval '2 days', end_at = end_at - interval '2 days', blocked_until = blocked_until - interval '2 days' WHERE id = '${booked.id}'`,
  ]);
  const visit = await json<{ date: string; version: number }>(
    await request.post(`${base}/appointments/${booked.id}/status`, {
      headers: owner,
      data: { version: booked.version, status: 'completed' },
    }),
  );
  await json(
    await request.post(`${base}/appointments/${booked.id}/payment`, {
      headers: owner,
      data: { version: visit.version, paid: true, method: 'cash' },
    }),
  );

  const context = await browser.newContext({ viewport: DESKTOP, locale: 'pl-PL' });
  const page = await context.newPage();
  await page.goto('/pl/login');
  await page.getByLabel('E-mail').fill(OWNER);
  await page.getByLabel('Hasło').fill(PASSWORD);
  await page.getByRole('button', { name: 'Zaloguj się' }).click();
  await page.waitForURL(/\/pl\/app\/calendar/);
  // Task 239: today's calendar reminds that the till of the visit's day was not closed.
  const reminder = page.getByTestId('till-reminder');
  await expect(reminder).toContainText('nie została zamknięta');
  await shot(page, '239-till-not-closed');
  await reminder.getByRole('button', { name: 'Pokaż ten dzień' }).click();
  await expect(reminder).toHaveCount(0);
  const till = page.getByTestId('till');
  await expect(till).toContainText(/Kasa dnia: 90,00\s*zł/);

  await till.getByRole('button', { name: 'Zamknij kasę' }).click();
  const form = page.getByTestId('till-close-form');
  await expect(form).toContainText(/Gotówka za wizyty tego dnia: 90,00\s*zł/);
  const save = form.getByRole('button', { name: 'Zapisz' });
  await form.getByLabel(/Gotówka w kasie/).fill('80x');
  await expect(form.getByText('Wpisz kwotę, np. 150 lub 150,50.')).toBeVisible();
  await expect(save).toBeDisabled();
  await form.getByLabel(/Gotówka w kasie/).fill('80');
  await form.getByLabel('Notatka (opcjonalnie)').fill('Reszta wydana z kasy');
  await save.click();

  const closed = till.getByTestId('till-closed');
  await expect(closed).toContainText('Kasa zamknięta');
  await expect(closed.getByTestId('till-diff')).toHaveText(/brakuje 10,00\s*zł/);
  await expect(closed).toContainText('Reszta wydana z kasy');
  await expect(closed).toContainText('Aleksander Owner');
  await shot(page, '232-till-close-missing');

  // After a reload it is still there; counting again replaces it.
  await page.reload();
  await expect(till.getByTestId('till-diff')).toHaveText(/brakuje 10,00\s*zł/);
  await till.getByRole('button', { name: 'Policz ponownie' }).click();
  await expect(form.getByLabel(/Gotówka w kasie/)).toHaveValue('80,00');
  await form.getByLabel(/Gotówka w kasie/).fill('90');
  await form.getByLabel('Notatka (opcjonalnie)').fill('');
  await form.getByRole('button', { name: 'Zapisz' }).click();
  await expect(till.getByTestId('till-diff')).toHaveText('zgadza się');
  await shot(page, '232-a-till-close-matches');
  // Closed — today's calendar no longer reminds of it.
  await page.getByRole('button', { name: 'Dziś', exact: true }).click();
  await expect(till).toHaveCount(0);
  await expect(reminder).toHaveCount(0);

  // Task 233: "Zamknięcia kasy" in the report.
  await page.getByRole('link', { name: 'Raporty' }).click();
  await page.waitForURL(/\/pl\/app\/reports$/);
  await page.getByRole('button', { name: 'Ostatnie 30 dni' }).click();
  const closes = page.getByTestId('report-till-closes');
  await closes.scrollIntoViewIfNeeded();
  await expect(closes.getByRole('heading')).toHaveText('Zamknięcia kasy');
  await expect(closes.getByRole('row')).toHaveCount(2);
  await expect(closes.getByRole('row').nth(1)).toContainText(/90,00\s*zł.*90,00\s*zł/);
  await expect(closes.getByTestId('report-till-total')).toHaveText(/Różnica razem: 0,00\s*zł/);
  await shot(page, '233-report-till-closes');

  // Task 236: 10 zł taken out of the till for towels — the till should then hold 80 zł; the
  // closed till says the cash changed since. Removing the mistake brings it back.
  await page.goto(`/pl/app/calendar?date=${visit.date}`);
  await till.getByRole('button', { name: 'Wpłata / wypłata' }).click();
  const moveForm = page.getByTestId('till-move-form');
  await expect(moveForm.getByLabel('Wypłata z kasy')).toBeChecked();
  const moveSave = moveForm.getByRole('button', { name: 'Zapisz' });
  await moveForm.getByLabel(/Kwota/).fill('10');
  await expect(moveSave).toBeDisabled(); // a reason is needed
  await moveForm.getByLabel('Powód').fill('Ręczniki');
  await moveSave.click();
  const moves = till.getByTestId('till-moves');
  await expect(moves).toContainText(/wypłata 10,00\s*zł · Ręczniki/);
  await expect(moves).toContainText('Aleksander Owner');
  await expect(till.getByTestId('till-closed')).toContainText(
    /zmieniły się płatności gotówką lub wpłaty i wypłaty — teraz 80,00\s*zł/,
  );
  await till.getByRole('button', { name: 'Policz ponownie' }).click();
  await expect(form).toContainText(
    /Powinno być w kasie: 80,00\s*zł \(za wizyty gotówką 90,00\s*zł, wpłaty 0,00\s*zł, wypłaty 10,00\s*zł\)/,
  );
  await shot(page, '236-till-cash-out');
  await form.getByRole('button', { name: 'Anuluj' }).click();

  // Task 237: the report shows the cash taken out beside the closed day.
  await page.getByRole('link', { name: 'Raporty' }).click();
  await page.waitForURL(/\/pl\/app\/reports$/);
  await page.getByRole('button', { name: 'Ostatnie 30 dni' }).click();
  await closes.scrollIntoViewIfNeeded();
  await expect(closes.getByRole('columnheader', { name: 'Wypłaty' })).toBeVisible();
  await expect(closes.getByRole('row').nth(1)).toContainText(/0,00\s*zł.*10,00\s*zł/);
  await shot(page, '237-report-till-moves');
  // Task 238: the cash journal of the period as a CSV file for the accountant.
  const [tillFile] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'CSV kasy' }).click(),
  ]);
  expect(tillFile.suggestedFilename()).toMatch(/^till-.+\.csv$/);
  const tillText = (await readFile((await tillFile.path())!)).toString('utf8');
  expect(tillText.startsWith('\uFEFFData;Godzina;Rodzaj;Kwota;Powinno być;Różnica')).toBe(true);
  expect(tillText).toMatch(/;Wypłata z kasy;10,00;;;Ręczniki;Aleksander Owner/);
  expect(tillText).toMatch(/;Zamknięcie kasy;90,00;90,00;0,00;;Aleksander Owner/);
  await page.getByRole('button', { name: 'CSV kasy' }).scrollIntoViewIfNeeded();
  await shot(page, '238-report-till-csv');
  await page.goto(`/pl/app/calendar?date=${visit.date}`);
  await moves.getByRole('button', { name: /Usuń: wypłata 10,00\s*zł · Ręczniki/ }).click();
  await expect(moves).toHaveCount(0);
  await expect(till.getByTestId('till-diff')).toHaveText('zgadza się');
  await expect(till.getByTestId('till-closed')).not.toContainText('zmieniły się');
  await context.close();

  // The business app (its web preview): the closed till under "Kasa dnia", counted again.
  const businessApp = await serveApp('mobile-business');
  try {
    const app = await (
      await browser.newContext({
        viewport: { width: 390, height: 844 },
        locale: 'pl-PL',
        isMobile: true,
      })
    ).newPage();
    await app.goto(businessApp.url);
    await app.getByLabel('E-mail lub telefon').fill(OWNER);
    await app.getByRole('button', { name: 'Wyślij kod' }).click();
    const mail = await waitForEmail(OWNER, /Kod logowania do aplikacji salonu/);
    await app.getByLabel('Kod', { exact: true }).fill(/\b(\d{6})\b/.exec(mail.text)![1]!);
    await app.getByRole('button', { name: 'Zaloguj się' }).click();
    await expect(app.getByRole('button', { name: 'Dziś' })).toBeVisible();
    const appTill = app.getByTestId('till');
    for (let back = 0; back < 3 && !(await appTill.isVisible()); back++) {
      await app.getByRole('button', { name: 'Poprzedni dzień' }).click();
      await app.waitForTimeout(800);
    }
    await expect(appTill.getByTestId('till-diff')).toHaveText('Zgadza się');
    await appTill.getByRole('button', { name: 'Policz ponownie' }).click();
    const appForm = app.getByTestId('till-close-form');
    await expect(appForm).toContainText(/Gotówka za wizyty tego dnia: 90,00\s*zł/);
    await app.getByLabel(/Gotówka w kasie/).fill('100');
    await app.getByLabel('Notatka (opcjonalnie)').fill('Klient nie wziął reszty');
    await app.getByRole('button', { name: 'Zapisz', exact: true }).click();
    await expect(appTill.getByTestId('till-diff')).toHaveText(/Nadwyżka 10,00\s*zł/);
    await expect(appTill).toContainText('Klient nie wziął reszty');
    await appTill.scrollIntoViewIfNeeded();
    await shot(app, '232-b-business-app-till-close');

    // Task 236 in the business app: 10 zł put into the till, then removed as a mistake.
    await appTill.getByRole('button', { name: 'Wpłata / wypłata' }).click();
    const appMove = app.getByTestId('till-move-form');
    await appMove.getByRole('radio', { name: 'Wpłata do kasy' }).click();
    await appMove.getByLabel(/Kwota/).fill('10');
    await appMove.getByLabel('Powód').fill('Reszta');
    await appMove.getByRole('button', { name: 'Zapisz', exact: true }).click();
    const appMoves = appTill.getByTestId('till-moves');
    await expect(appMoves).toContainText(/Wpłata 10,00\s*zł · Reszta/);
    await expect(appTill.getByTestId('till-closed')).toContainText(/teraz 100,00\s*zł/);
    await appMoves.scrollIntoViewIfNeeded();
    await shot(app, '236-a-business-app-cash-in');
    await appMoves.getByRole('button', { name: /Usuń: Wpłata 10,00\s*zł · Reszta/ }).click();
    await expect(appMoves).toHaveCount(0);

    // Task 235: "Zamknięcia kasy" in the business app's report.
    await app.getByRole('button', { name: 'Raporty' }).click();
    await app.getByRole('button', { name: 'Ostatnie 30 dni' }).click();
    const appCloses = app.getByTestId('report-till-closes');
    await appCloses.scrollIntoViewIfNeeded();
    await expect(appCloses).toContainText(/Zamknięcia kasy · różnica razem: \+10,00\s*zł/);
    await expect(appCloses).toContainText(/policzono 100,00\s*zł · powinno być 90,00\s*zł/);
    await shot(app, '235-business-app-report-till-closes');
    // Task 238: "CSV kasy" in the app — the till's cash journal of the period.
    const [appTillFile] = await Promise.all([
      app.waitForEvent('download'),
      app.getByRole('button', { name: 'CSV kasy' }).click(),
    ]);
    expect(appTillFile.suggestedFilename()).toMatch(/^till-.+\.csv$/);
    const appTillText = (await readFile((await appTillFile.path())!)).toString('utf8');
    expect(appTillText.charCodeAt(0)).toBe(0xfeff);
    expect(appTillText).toMatch(
      /;Zamknięcie kasy;100,00;90,00;10,00;Klient nie wziął reszty;Aleksander Owner/,
    );
    await app.getByRole('button', { name: 'CSV kasy' }).scrollIntoViewIfNeeded();
    await shot(app, '238-a-business-app-till-csv');
  } finally {
    businessApp.server.close();
  }
});
