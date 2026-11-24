import { execFileSync } from 'node:child_process';
import {
  expect,
  test,
  type APIRequestContext,
  type APIResponse,
  type Locator,
  type Page,
} from '@playwright/test';
import { waitForEmail } from './mailpit';
import { serveApp } from './mobile-app';

/**
 * Task 343: the client's coupon on a visit in the business app (web preview of
 * apps/mobile-business). The owner uses Jan's −25% coupon on a completed visit (the price to pay
 * goes down), takes it off again and uses it by code. A gift voucher covers part of the discounted price.
 */

const PASSWORD = 'e2e-password-123';
const run = Date.now().toString(36);
const OWNER = `app-visit-coupon-owner-${run}@example.com`;
const rewardName = 'Strzyżenie i pielęgnacja bardzo długich włosów z rabatem dla stałego klienta';
const PHONE = { width: 320, height: 844 };
// An address of its own for sign-up and sign-in (reserved for tests, RFC 2544).
const n = Math.floor(Math.random() * 65_536);
const ADDRESS = { 'x-forwarded-for': `198.19.${n >> 8}.${n & 255}` };

const shot = (page: Page, name: string) => page.screenshot({ path: `e2e/screenshots/${name}.png` });

async function expectTarget(control: Locator) {
  const box = await control.boundingBox();
  expect(box!.width).toBeGreaterThanOrEqual(44);
  expect(box!.height).toBeGreaterThanOrEqual(44);
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(PHONE.width);
}

async function expectFieldError(field: Locator, description: string | RegExp) {
  await expect(field).toHaveAccessibleDescription(description);
  await expect(field).toHaveAttribute('aria-invalid', 'true');
  await expect(field).toHaveCSS('border-top-color', 'rgb(179, 38, 30)');
  const input = (await field.boundingBox())!;
  const alert = (await field.locator('..').getByRole('alert').boundingBox())!;
  expect(alert.y).toBeGreaterThanOrEqual(input.y + input.height - 1);
  expect(alert.y - input.y - input.height).toBeLessThan(16);
}

async function json<T>(res: APIResponse): Promise<T> {
  expect(res.ok(), `${res.url()} → ${res.status()} ${await res.text()}`).toBeTruthy();
  return (res.status() === 204 ? undefined : await res.json()) as T;
}

async function verifiedUser(api: APIRequestContext, email: string, name: string) {
  await json(
    await api.post('/v1/auth/register', {
      headers: ADDRESS,
      data: { email, password: PASSWORD, name },
    }),
  );
  const mail = await waitForEmail(email, /Potwierdź adres/);
  const token = /token=([^\s&]+)/.exec(mail.text)?.[1];
  expect(token, 'verification link').toBeTruthy();
  await json(
    await api.post('/v1/auth/verify-email', {
      headers: ADDRESS,
      data: { token: decodeURIComponent(token!) },
    }),
  );
  const login = await json<{ accessToken: string }>(
    await api.post('/v1/auth/login', {
      headers: ADDRESS,
      data: { email, password: PASSWORD, clientType: 'mobile' },
    }),
  );
  return { Authorization: `Bearer ${login.accessToken}` };
}

test('business app: the owner uses a client’s coupon on a visit, from the list and by code', async ({
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
  const orgBase = `/v1/organizations/${org.id}`;
  const base = `${orgBase}/locations/${location.id}`;
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
  // Book tomorrow in the salon’s timezone, including after 23:00 UTC.
  const tomorrow = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Warsaw' }).format(
    new Date(Date.now() + 86_400_000),
  );
  const booked = await json<{ id: string; version: number; customer: { id: string } }>(
    await request.post(`${base}/appointments`, {
      headers: owner,
      data: {
        serviceId: service.id,
        staffId: staff.id,
        start: `${tomorrow}T10:00:00.000Z`,
        allowOutsideHours: true,
        customer: { name: 'Jan Kowalski', phone: '+48600000343' },
      },
    }),
  );
  // Move this test visit to yesterday so both discounts and voucher payments are available.
  execFileSync('psql', [
    (process.env.DATABASE_URL ?? '').replace(/\?.*$/, ''),
    '-v',
    'ON_ERROR_STOP=1',
    '-c',
    `UPDATE appointment SET start_at = start_at - interval '2 days', end_at = end_at - interval '2 days', blocked_until = blocked_until - interval '2 days' WHERE id = '${booked.id}'`,
  ]);
  await json(
    await request.post(`${base}/appointments/${booked.id}/status`, {
      headers: owner,
      data: { version: booked.version, status: 'completed' },
    }),
  );
  const voucher = await json<{ code: string }>(
    await request.post(`${base}/gift-vouchers`, {
      headers: owner,
      data: { amountGrosze: 5000 },
    }),
  );
  // The program on, −25% for 5 stamps, and Jan already has the coupon.
  const program = await json<Record<string, unknown>>(
    await request.get(`${orgBase}/loyalty/program`, { headers: owner }),
  );
  delete program.earnRules;
  await json(
    await request.put(`${orgBase}/loyalty/program`, {
      headers: owner,
      data: { ...program, enabled: true },
    }),
  );
  const reward = await json<{ id: string }>(
    await request.post(`${orgBase}/loyalty/rewards`, {
      headers: owner,
      data: {
        name: rewardName,
        kind: 'discount_percent',
        discountPercent: 25,
        freeServiceId: null,
        cost: 5,
      },
    }),
  );
  const account = `${orgBase}/loyalty/accounts/${booked.customer.id}`;
  await json(
    await request.post(`${account}/adjustments`, {
      headers: owner,
      data: { points: 5, reason: 'Papierowa karta' },
    }),
  );
  let coupon: { id: string; code: string };

  const businessApp = await serveApp('mobile-business');
  try {
    const context = await browser.newContext({
      viewport: PHONE,
      locale: 'pl-PL',
      timezoneId: 'Europe/Warsaw',
      isMobile: true,
      extraHTTPHeaders: ADDRESS,
    });
    const phone = await context.newPage();
    await phone.goto(businessApp.url);
    await phone.getByLabel('E-mail lub telefon').fill(OWNER);
    await phone.getByRole('button', { name: 'Wyślij kod' }).click();
    const code = await waitForEmail(OWNER, /Kod logowania do aplikacji salonu/);
    await phone.getByLabel('Kod', { exact: true }).fill(/\b(\d{6})\b/.exec(code.text)![1]!);
    await phone.getByRole('button', { name: 'Zaloguj się' }).click();
    await expect(phone.getByRole('button', { name: 'Dziś' })).toBeVisible();

    await phone.getByRole('button', { name: 'Poprzedni dzień' }).click();
    await phone
      .getByRole('button', { name: /Jan Kowalski/ })
      .first()
      .click();
    await expect(phone.getByText('Aktywne kupony (0)')).toBeVisible();
    await phone.getByRole('button', { name: '‹ Wróć', exact: true }).click();
    coupon = await json<{ id: string; code: string }>(
      await request.post(`${account}/redemptions`, {
        headers: owner,
        data: { rewardId: reward.id },
      }),
    );
    await phone
      .getByRole('button', { name: /Jan Kowalski/ })
      .first()
      .click();
    await phone.addStyleTag({ content: 'div, span, input { font-size: 24px !important; }' });
    await expect(phone.getByText('Kupony i rabat klienta')).toBeVisible();

    const field = phone.getByRole('textbox', { name: 'Kod kuponu od klienta' });
    const apply = phone.getByRole('button', { name: 'Użyj kodu' });
    await expectTarget(field);
    await expectTarget(apply);
    await apply.click();
    await expectFieldError(field, '! Kod kuponu od klienta');
    await field.fill('NIEZNANY');
    await expect(field).not.toHaveAttribute('aria-invalid', 'true');
    await apply.click();
    await expectFieldError(field, '! Nie ma takiego kuponu u tego klienta.');
    const rewardLabel = phone.getByText(rewardName, { exact: false }).first();
    await expect(rewardLabel).toBeVisible();
    expect(await rewardLabel.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);

    // ── From the list: −22,50 zł, 67,50 zł to pay ──────────────────────
    await phone.getByRole('button', { name: `Użyj kuponu ${coupon.code}` }).click();
    await expect(phone.getByText('Rabat dodany do wizyty.')).toBeVisible();
    await expect(phone.getByText(/Do zapłaty: 67,50\s*zł/)).toBeVisible();
    await shot(phone, '343-business-app-visit-coupon');

    // ── Taken off, then used again by the code Jan shows ───────────────
    await phone.getByRole('button', { name: `Zdejmij kupon ${coupon.code}` }).click();
    await expect(phone.getByText('Rabat zdjęty z wizyty.')).toBeVisible();
    await expect(phone.getByText(/Do zapłaty:/)).toHaveCount(0);
    await phone.getByLabel('Kod kuponu od klienta').fill(` ${coupon.code.toLowerCase()} `);
    await phone.getByRole('button', { name: 'Użyj kodu' }).click();
    await expect(phone.getByText('Rabat dodany do wizyty.')).toBeVisible();
    await expect(phone.getByText(/Do zapłaty: 67,50\s*zł/)).toBeVisible();
    const vouchers = phone.getByTestId('visit-vouchers');
    await vouchers.getByRole('button', { name: 'Klient płaci bonem podarunkowym?' }).click();
    await expect(vouchers.getByText('Bonem jeszcze nie płacono.')).toBeVisible();
    const voucherCode = vouchers.getByRole('textbox', { name: 'Kod bonu' });
    const amount = vouchers.getByRole('textbox', { name: 'Kwota do zapłaty bonem' });
    const pay = vouchers.getByRole('button', { name: 'Zapłać bonem' });
    await expectTarget(voucherCode);
    await expectTarget(amount);
    await expectTarget(pay);
    await expectTarget(vouchers.getByRole('button', { name: 'Anuluj' }));
    await pay.click();
    await expectFieldError(voucherCode, '! Kod bonu');
    await voucherCode.fill('ZZZZ-ZZZZ');
    await pay.click();
    await expectFieldError(voucherCode, '! Nie ma bonu z tym kodem w tym salonie.');
    await voucherCode.fill(voucher.code);
    await expect(amount).toHaveValue('67,50');
    await amount.fill('67,51');
    await pay.click();
    await expectFieldError(amount, /! Do dopłaty za wizytę: 67,50\s*zł/);
    await amount.fill('67,50');
    await pay.click();
    await expectFieldError(amount, /! Na bonie zostało mniej/);
    await expect(voucherCode).not.toHaveAttribute('aria-invalid', 'true');
    await amount.fill('50');
    await pay.click();
    await expect(vouchers.getByTestId('visit-voucher-left')).toHaveText(/17,50\s*zł/);
    await expect(vouchers.getByText('Bonem jeszcze nie płacono.')).toHaveCount(0);
    await context.close();
  } finally {
    businessApp.server.close();
  }

  const visit = await json<{ discountGrosze: number; coupons: { id: string }[] }>(
    await request.get(`${base}/appointments/${booked.id}`, { headers: owner }),
  );
  expect(visit.discountGrosze).toBe(2250);
  expect(visit.coupons.map((c) => c.id)).toEqual([coupon.id]);
});
