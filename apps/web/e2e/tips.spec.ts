import {
  expect,
  test,
  type APIRequestContext,
  type APIResponse,
  type Page,
} from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { freshAddress } from './addresses';
import { waitForEmail } from './mailpit';
import { serveApp } from './mobile-app';

/**
 * Task 229: tips. In the card of a visit that took place the owner notes "Napiwek" 15,50 zł
 * (screenshot 229); "Kasa dnia" shows it apart from the visit money (229-a) and "Raporty" has
 * "Napiwki" by specialist (229-b). The business app: the tip in the visit and "Kasa dnia"
 * (229-c), "Napiwki" in its report (229-d).
 * Task 390: "Do wypłaty" — commission plus tips by specialist (390, app 390-a).
 * Task 304: "Rabaty" in the report — a coupon, the client's tier discount and happy hours on the
 * paid visit (screenshot 304), the same in the business app (304-a).
 */

const PASSWORD = 'e2e-password-123';
const run = Date.now().toString(36);
const OWNER = `tip-owner-${run}@example.com`;
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

test('the owner notes a tip; the till and the report show it apart from the revenue', async ({
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
  // Task 390: Ilian gets 40% of what his paid visits bring.
  await json(
    await request.put(`${base}/reports/commissions/${staff.id}`, {
      headers: owner,
      data: { commissionPercent: 40 },
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
          phone: '+48600000229',
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

  const context = await browser.newContext({ viewport: DESKTOP, locale: 'pl-PL' });
  const page = await context.newPage();
  await page.goto('/pl/login');
  await page.getByLabel('E-mail').fill(OWNER);
  await page.getByLabel('Hasło').fill(PASSWORD);
  await page.getByRole('button', { name: 'Zaloguj się' }).click();
  await page.waitForURL(/\/pl\/app\/calendar/);
  await page.goto(`/pl/app/calendar?date=${visit.date}`);
  const till = page.getByTestId('till');
  await expect(till).toContainText('przyszli, nieopłacone: 1');
  await page.getByRole('button', { name: /Jan Kowalski/ }).click();
  const card = page.getByRole('dialog');
  await expect(card).toContainText('Odbyła się');
  const tip = card.getByLabel(/Napiwek/);
  await expect(tip).toHaveValue('');
  const save = card.getByRole('button', { name: 'Zapisz napiwek' });
  await expect(save).toBeDisabled();
  await tip.fill('15,5x');
  await expect(card.getByText('Wpisz kwotę, np. 15 lub 15,50.')).toBeVisible();
  await expect(save).toBeDisabled();
  await tip.fill('15,50');
  await save.click();
  await expect(card.getByText('Zmieniono napiwek')).toBeVisible();
  await expect(tip).toHaveValue('15,50');
  await expect(save).toBeDisabled();
  // Pay for the visit too: the tip is not part of the price.
  await card.getByRole('button', { name: 'Opłacono', exact: true }).click();
  await expect(card.getByTestId('paid-chip')).toBeVisible();
  await tip.scrollIntoViewIfNeeded();
  await shot(page, '229-visit-tip');
  await page.keyboard.press('Escape');
  await expect(card).toBeHidden();

  await expect(till).toContainText(/Kasa dnia: 90,00\s*zł/);
  await expect(till.getByTestId('till-tips')).toHaveText(/Napiwki 15,50\s*zł/);
  await shot(page, '229-a-calendar-till-tips');
  // Task 304: the visit had a coupon of 10 zł, the tier's 5 zł and happy hours of 10 zł (the
  // price before them was 100 zł). Set after the till check: the till shows the paid amount.
  execFileSync('psql', [
    (process.env.DATABASE_URL ?? '').replace(/\?.*$/, ''),
    '-v',
    'ON_ERROR_STOP=1',
    '-c',
    `UPDATE appointment SET discount_grosze = 1500, tier_discount_grosze = 500, tier_name = 'Gold', tier_discount_percent = 5, list_price_grosze = 10000, happy_hour_percent = 10 WHERE id = '${booked.id}'`,
  ]);

  await page.getByRole('link', { name: 'Raporty' }).click();
  await page.waitForURL(/\/pl\/app\/reports$/);
  await page.getByRole('button', { name: 'Ostatnie 30 dni' }).click();
  const tips = page.getByTestId('report-tips');
  await tips.scrollIntoViewIfNeeded();
  await expect(tips.getByRole('heading')).toHaveText(/Napiwki: 15,50\s*zł/);
  await expect(tips.getByRole('meter', { name: 'Ilian' })).toHaveAttribute('aria-valuenow', '100');
  await expect(tips.getByRole('listitem')).toContainText('wizyty z napiwkiem: 1');
  await shot(page, '229-b-report-tips');
  const discounts = page.getByTestId('report-discounts');
  await discounts.scrollIntoViewIfNeeded();
  await expect(discounts.getByRole('heading')).toHaveText(/Rabaty: 25,00\s*zł/);
  await expect(discounts.getByRole('listitem')).toHaveCount(3);
  await expect(discounts.getByRole('listitem').nth(0)).toContainText('Kupony lojalnościowe');
  await expect(discounts.getByRole('listitem').nth(0)).toContainText(/10,00\s*zł · wizyty: 1/);
  await expect(discounts.getByRole('meter', { name: 'Rabat poziomu klienta' })).toHaveAttribute(
    'aria-valuenow',
    '20',
  );
  await expect(discounts.getByRole('listitem').nth(2)).toContainText('Happy hours');
  await shot(page, '304-report-discounts');
  // Task 390: "Do wypłaty" — 40% of 75 zł (90 zł minus 15 zł of discounts) plus the tip.
  const payout = page.getByTestId('report-commissions');
  await payout.scrollIntoViewIfNeeded();
  const ilianPayout = payout.getByRole('row').filter({ hasText: 'Ilian' });
  await expect(ilianPayout).toContainText(/30,00\s*zł/);
  await expect(ilianPayout).toContainText(/15,50\s*zł/);
  await expect(ilianPayout).toContainText(/45,50\s*zł/);
  await expect(payout.getByTestId('report-payout')).toHaveText(
    /Razem do wypłaty \(prowizje i napiwki\): 45,50\s*zł/,
  );
  await shot(page, '390-report-payout');
  await context.close();

  // The business app (its web preview): the day's tips, the tip in the visit, the report.
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
    await expect(appTill.getByTestId('till-tips')).toHaveText(/Napiwki 15,50\s*zł/);
    await app
      .getByRole('button', { name: /Jan Kowalski/ })
      .first()
      .click();
    const appTip = app.getByLabel(/Napiwek/);
    await expect(appTip).toHaveValue('15,50');
    await appTip.fill('20');
    await app.getByRole('button', { name: 'Zapisz napiwek' }).click();
    await expect(app.getByRole('button', { name: 'Zapisz napiwek' })).toBeDisabled();
    await expect(appTip).toHaveValue('20');
    await app.getByTestId('tip-field').scrollIntoViewIfNeeded();
    await shot(app, '229-c-business-app-visit-tip');
    await app.getByRole('button', { name: '‹ Wróć' }).first().click();
    await expect(appTill.getByTestId('till-tips')).toHaveText(/Napiwki 20,00\s*zł/);
    await app.getByRole('button', { name: 'Raporty' }).click();
    await app.getByRole('button', { name: 'Ostatnie 30 dni' }).click();
    const appTips = app.getByTestId('report-tips');
    await appTips.scrollIntoViewIfNeeded();
    await expect(appTips).toContainText(/Napiwki: 20,00\s*zł/);
    await expect(appTips).toContainText(/Ilian/);
    await expect(appTips).toContainText(/20,00\s*zł · wizyty z napiwkiem: 1/);
    await shot(app, '229-d-business-app-report-tips');
    const appDiscounts = app.getByTestId('report-discounts');
    await appDiscounts.scrollIntoViewIfNeeded();
    await expect(appDiscounts).toContainText(/Rabaty: 25,00\s*zł/);
    await expect(appDiscounts).toContainText('Rabat poziomu klienta');
    await expect(appDiscounts).toContainText(/5,00\s*zł · wizyty: 1/);
    await shot(app, '304-a-business-app-report-discounts');
    // Task 390: the same in the app — the tip is 20 zł now.
    const appPayout = app.getByTestId('report-commissions');
    await appPayout.scrollIntoViewIfNeeded();
    await expect(appPayout).toContainText(/40% · 30,00\s*zł/);
    await expect(appPayout).toContainText(/\+ napiwki 20,00\s*zł = 50,00\s*zł/);
    await expect(app.getByTestId('report-payout')).toHaveText(
      /Razem do wypłaty \(z napiwkami\): 50,00\s*zł/,
    );
    await shot(app, '390-a-business-app-report-payout');
  } finally {
    businessApp.server.close();
  }
});
