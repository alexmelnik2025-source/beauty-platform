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
 * Task 343: the client's coupon on a visit in the business app (web preview of
 * apps/mobile-business). The owner uses Jan's −25% coupon on tomorrow's visit (the price to pay
 * goes down), takes it off again and then uses it by the code Jan shows. Screenshot 343.
 */

const PASSWORD = 'e2e-password-123';
const run = Date.now().toString(36);
const OWNER = `app-visit-coupon-owner-${run}@example.com`;
const PHONE = { width: 390, height: 844 };
// An address of its own for sign-up and sign-in (reserved for tests, RFC 2544).
const n = Math.floor(Math.random() * 65_536);
const ADDRESS = { 'x-forwarded-for': `198.19.${n >> 8}.${n & 255}` };

const shot = (page: Page, name: string) => page.screenshot({ path: `e2e/screenshots/${name}.png` });

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
  // Tomorrow in Warsaw (the app's "Następny dzień"), also after 23:00 UTC.
  const tomorrow = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Warsaw' }).format(
    new Date(Date.now() + 86_400_000),
  );
  const booked = await json<{ id: string; customer: { id: string } }>(
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
        name: '−25% na strzyżenie',
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
  const coupon = await json<{ id: string; code: string }>(
    await request.post(`${account}/redemptions`, {
      headers: owner,
      data: { rewardId: reward.id },
    }),
  );

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

    await phone.getByRole('button', { name: 'Następny dzień' }).click();
    await phone
      .getByRole('button', { name: /Jan Kowalski/ })
      .first()
      .click();
    await expect(phone.getByText('Kupony i rabat klienta')).toBeVisible();

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
