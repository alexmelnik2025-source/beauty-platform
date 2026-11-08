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
 * Task 348: "Zmień nagrodę" in "Program lojalnościowy" of the business app (web preview of
 * apps/mobile-business). The owner changes a reward's price, gives its coupon 30 days and limits it
 * to "Strzyżenie"; a wrong validity is pointed out. Screenshot 348.
 */

const PASSWORD = 'e2e-password-123';
const run = Date.now().toString(36);
const OWNER = `app-reward-edit-owner-${run}@example.com`;
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

test('business app: the owner changes a reward', async ({ browser, request }) => {
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
  const services: Record<string, string> = {};
  for (const name of ['Strzyżenie', 'Broda']) {
    const service = await json<{ id: string }>(
      await request.post(`${base}/services`, {
        headers: owner,
        data: { name, durationMinutes: 30, priceGrosze: 8000, bufferMinutes: 0 },
      }),
    );
    services[name] = service.id;
  }
  const reward = await json<{ id: string }>(
    await request.post(`/v1/organizations/${org.id}/loyalty/rewards`, {
      headers: owner,
      data: { name: '−25% na strzyżenie', kind: 'discount_percent', discountPercent: 25, cost: 5 },
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

    await phone.getByRole('button', { name: 'Program lojalnościowy' }).click();
    await phone.getByRole('button', { name: 'Zmień nagrodę: −25% na strzyżenie' }).click();
    await expect(phone.getByLabel('Nazwa nagrody (np. −25% na strzyżenie)')).toHaveValue(
      '−25% na strzyżenie',
    );
    await phone.getByLabel('Ile pieczątek').fill('6');
    await phone.getByLabel('Kupon ważny (dni), puste — bez terminu').fill('0');
    await phone.getByRole('button', { name: 'Zapisz', exact: true }).click();
    await expect(phone.getByText('Ważność kuponu: od 1 do 3650 dni albo puste.')).toBeVisible();
    await phone.getByLabel('Kupon ważny (dni), puste — bez terminu').fill('30');
    await phone.getByRole('button', { name: 'Strzyżenie', exact: true }).click();
    await shot(phone, '348-business-app-reward-edit');
    await phone.getByRole('button', { name: 'Zapisz', exact: true }).click();
    await expect(phone.getByText('Nagroda zmieniona.')).toBeVisible();
    await expect(phone.getByText('kupon ważny 30 dni · tylko: Strzyżenie')).toBeVisible();
    await expect(phone.getByText('Zniżka 25% · pieczątki: 6')).toBeVisible();
    await context.close();
  } finally {
    businessApp.server.close();
  }

  const saved = await json<
    { id: string; cost: number; couponValidityDays: number | null; serviceIds: string[] }[]
  >(await request.get(`/v1/organizations/${org.id}/loyalty/rewards`, { headers: owner }));
  expect(saved.find((r) => r.id === reward.id)).toMatchObject({
    cost: 6,
    couponValidityDays: 30,
    serviceIds: [services['Strzyżenie']],
  });
});
