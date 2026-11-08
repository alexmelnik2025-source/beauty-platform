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
 * Task 340: "Program lojalnościowy" in the client card of the business app (web preview of
 * apps/mobile-business). The owner adds stamps by hand with a reason (a wrong number is pointed
 * out), exchanges them for a reward after a question (the client gets a coupon) and cancels the
 * coupon again (the stamps come back). Screenshots 340, 340a.
 */

const PASSWORD = 'e2e-password-123';
const run = Date.now().toString(36);
const OWNER = `app-client-bonus-owner-${run}@example.com`;
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

type Account = {
  balance: number;
  coupons: { code: string; status: string }[];
  transactions: { type: string; points: number; note: string | null }[];
};

test('business app: stamps by hand, a reward and a cancelled coupon in the client card', async ({
  browser,
  request,
}) => {
  const owner = await verifiedUser(request, OWNER, 'Aleksander Owner');
  const org = await json<{ id: string }>(
    await request.post('/v1/organizations', { headers: owner, data: { name: 'GESTALT' } }),
  );
  await json(
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
  // The program on (stamps, as by default) and one reward: −25% for 5 stamps.
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
  await json(
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
  const anna = await json<{ id: string }>(
    await request.post(`${orgBase}/customers`, {
      headers: owner,
      data: { name: 'Anna Kowalska', phone: '+48600100300' },
    }),
  );
  await json(
    await request.post(`${orgBase}/loyalty/accounts/${anna.id}/adjustments`, {
      headers: owner,
      data: { points: 3, reason: 'Start programu' },
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

    await phone.getByRole('button', { name: 'Klienci' }).click();
    await phone.getByRole('button', { name: 'Karta klienta: Anna Kowalska', exact: true }).click();
    await expect(phone.getByText('Pieczątki: 3', { exact: true })).toBeVisible();
    const redeem = phone.getByRole('button', {
      name: 'Wymień na nagrodę: −25% na strzyżenie',
    });
    await expect(redeem).toBeDisabled();
    await expect(phone.getByText('Start programu')).toBeVisible();

    // ── +2 stamps by hand (zero is pointed out first) ──────────────────
    await phone.getByRole('button', { name: 'Zmień saldo' }).click();
    await phone.getByLabel('Ile (np. 5 albo -2)').fill('0');
    await phone.getByLabel('Powód (widać go w historii)').fill('Papierowa karta');
    await phone.getByRole('button', { name: 'Zapisz zmianę' }).click();
    await expect(phone.getByText('Wpisz liczbę różną od zera, np. 5 albo -2.')).toBeVisible();
    await phone.getByLabel('Ile (np. 5 albo -2)').fill('2');
    await shot(phone, '340-business-app-client-bonus-adjust');
    await phone.getByRole('button', { name: 'Zapisz zmianę' }).click();
    await expect(phone.getByText('Saldo zmienione.')).toBeVisible();
    await expect(phone.getByText('Pieczątki: 5', { exact: true })).toBeVisible();
    await expect(phone.getByText('Papierowa karta')).toBeVisible();

    // ── 5 stamps → a coupon, after a question ──────────────────────────
    await expect(redeem).toBeEnabled();
    await redeem.click();
    await expect(phone.getByText(/Wymienić pieczątki: 5 na „−25% na strzyżenie”\?/)).toBeVisible();
    await phone.getByRole('button', { name: 'Tak, wymień' }).click();
    await expect(phone.getByText(/^Kupon wydany: /)).toBeVisible();
    await expect(phone.getByText('Pieczątki: 0', { exact: true })).toBeVisible();
    const issued = await json<Account>(
      await request.get(`${orgBase}/loyalty/accounts/${anna.id}`, { headers: owner }),
    );
    const couponCode = issued.coupons[0]!.code;
    await expect(phone.getByText(`Kupon wydany: ${couponCode}.`, { exact: false })).toBeVisible();
    await shot(phone, '340a-business-app-client-bonus-coupon');

    // ── The coupon is cancelled; the stamps come back ──────────────────
    await phone.getByRole('button', { name: `Anuluj kupon ${couponCode}` }).click();
    await expect(phone.getByText(`Anulować kupon ${couponCode}?`, { exact: false })).toBeVisible();
    await phone.getByRole('button', { name: 'Tak, anuluj' }).click();
    await expect(phone.getByText('Kupon anulowany, saldo wróciło do klienta.')).toBeVisible();
    await expect(phone.getByText('Pieczątki: 5', { exact: true })).toBeVisible();
    await context.close();
  } finally {
    businessApp.server.close();
  }

  const account = await json<Account>(
    await request.get(`${orgBase}/loyalty/accounts/${anna.id}`, { headers: owner }),
  );
  expect(account.balance).toBe(5);
  expect(account.coupons.map((c) => c.status)).toEqual(['cancelled']);
  expect(account.transactions.find((t) => t.type === 'adjust' && t.points === 2)?.note).toBe(
    'Papierowa karta',
  );
});
