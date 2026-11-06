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
 * Task 206: "Program lojalnościowy" in the business app (web preview of apps/mobile-business).
 * The owner switches the program on, adds a discount and a free service as rewards, sees a
 * client's operation and removes a reward again. Screenshots 206–206b.
 */

const PASSWORD = 'e2e-password-123';
const run = Date.now().toString(36);
const OWNER = `loyalty-app-owner-${run}@example.com`;
const ANNA = `loyalty-app-anna-${run}@example.com`;
const PHONE = { width: 390, height: 844 };
// An address of its own for sign-up and sign-in (reserved for tests, RFC 2544): the API allows 10 sign-ups an hour from one.
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

test('the owner runs the loyalty program from the business app (task 206)', async ({
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
  const beard = await json<{ id: string }>(
    await request.post(`${base}/services`, {
      headers: owner,
      data: { name: 'Broda', durationMinutes: 30, priceGrosze: 5000 },
    }),
  );
  await json(
    await request.post(`${base}/services`, {
      headers: owner,
      data: { name: 'Strzyżenie męskie', durationMinutes: 45, priceGrosze: 9000 },
    }),
  );

  const businessApp = await serveApp('mobile-business');
  try {
    const context = await browser.newContext({
      viewport: PHONE,
      locale: 'pl-PL',
      isMobile: true,
      // Sign-ins from this test's own address too, so other tests keep their login limit.
      extraHTTPHeaders: ADDRESS,
    });
    const app = await context.newPage();
    await app.goto(businessApp.url);
    await app.getByLabel('E-mail lub telefon').fill(OWNER);
    await app.getByRole('button', { name: 'Wyślij kod' }).click();
    const mail = await waitForEmail(OWNER, /Kod logowania do aplikacji salonu/);
    await app.getByLabel('Kod', { exact: true }).fill(/\b(\d{6})\b/.exec(mail.text)![1]!);
    await app.getByRole('button', { name: 'Zaloguj się' }).click();
    await expect(app.getByRole('button', { name: 'Dziś' })).toBeVisible();

    await app.getByRole('button', { name: 'Program lojalnościowy' }).click();
    await expect(app.getByRole('heading', { name: 'Program lojalnościowy' })).toBeVisible();
    await expect(app.getByText('Program wyłączony')).toBeVisible();
    await expect(app.getByText('Karta pieczątek: 1 za opłaconą wizytę')).toBeVisible();
    await expect(app.getByText(/Nie ma jeszcze nagród/)).toBeVisible();

    // ── Switched on ────────────────────────────────────────────────────
    await app.getByRole('button', { name: 'Włącz program' }).click();
    await expect(app.getByText('Program jest włączony.')).toBeVisible();
    await expect(app.getByText('Program włączony', { exact: true })).toBeVisible();
    const on = await json<{ enabled: boolean; mode: string }>(
      await request.get(`${orgBase}/loyalty/program`, { headers: owner }),
    );
    expect(on).toMatchObject({ enabled: true, mode: 'stamps' });

    // ── −25% for 5 stamps, a free beard for 8 ──────────────────────────
    await app.getByRole('button', { name: '+ Dodaj nagrodę' }).click();
    await app.getByRole('button', { name: 'Zapisz' }).click();
    await expect(app.getByText('Wpisz nazwę nagrody (do 80 znaków).')).toBeVisible();
    await app.getByLabel('Nazwa nagrody (np. −25% na strzyżenie)').fill('−25% na strzyżenie');
    await app.getByLabel('Zniżka, %').fill('25');
    await app.getByLabel('Ile pieczątek').fill('5');
    await app.getByRole('button', { name: 'Zapisz' }).click();
    await expect(app.getByText('Dodano nagrodę.')).toBeVisible();
    await expect(app.getByText('Zniżka 25% · pieczątki: 5')).toBeVisible();

    await app.getByRole('button', { name: '+ Dodaj nagrodę' }).click();
    await app.getByLabel('Nazwa nagrody (np. −25% na strzyżenie)').fill('Broda gratis');
    await app.getByRole('button', { name: 'Darmowa usługa' }).click();
    await app.getByRole('button', { name: 'Broda', exact: true }).click();
    await app.getByLabel('Ile pieczątek').fill('8');
    await shot(app, '206-business-app-loyalty-add');
    await app.getByRole('button', { name: 'Zapisz' }).click();
    await expect(app.getByText('Gratis: Broda · pieczątki: 8')).toBeVisible();
    const rewards = await json<
      { name: string; kind: string; cost: number; freeServiceId: string | null }[]
    >(await request.get(`${orgBase}/loyalty/rewards`, { headers: owner }));
    expect(rewards.map((r) => [r.name, r.kind, r.cost])).toEqual([
      ['−25% na strzyżenie', 'discount_percent', 5],
      ['Broda gratis', 'free_service', 8],
    ]);
    expect(rewards[1]!.freeServiceId).toBe(beard.id);

    // ── A client brought a paper card with 2 stamps ────────────────────
    const customer = await json<{ id: string }>(
      await request.post(`${orgBase}/customers`, {
        headers: owner,
        data: { name: 'Anna Kowalska', phone: '+48600100200', email: ANNA },
      }),
    );
    await json(
      await request.post(`${orgBase}/loyalty/accounts/${customer.id}/adjustments`, {
        headers: owner,
        data: { points: 2, reason: 'Papierowa karta' },
      }),
    );
    await app.getByRole('button', { name: '‹ Wróć' }).click();
    await app.getByRole('button', { name: 'Program lojalnościowy' }).click();
    await expect(app.getByText('Ręczna zmiana · Anna Kowalska')).toBeVisible();
    await expect(app.getByText(/^\+2 · saldo: 2 · /)).toBeVisible();
    await expect(app.getByText('Papierowa karta')).toBeVisible();
    await shot(app, '206a-business-app-loyalty');

    // ── The free beard is removed; the discount stays ──────────────────
    await app.getByRole('button', { name: 'Usuń nagrodę: Broda gratis' }).click();
    await expect(app.getByText(/Usunąć tę nagrodę z katalogu\?/)).toBeVisible();
    await app.getByRole('button', { name: 'Tak, usuń' }).click();
    await expect(app.getByText('Usunięto nagrodę.')).toBeVisible();
    await expect(app.getByText('Gratis: Broda · pieczątki: 8')).toHaveCount(0);
    await expect(app.getByText('Zniżka 25% · pieczątki: 5')).toBeVisible();

    // ── Switched off again, after a question ───────────────────────────
    await app.getByRole('button', { name: 'Wyłącz program' }).click();
    await expect(app.getByText(/Wyłączyć program\?/)).toBeVisible();
    await shot(app, '206b-business-app-loyalty-off');
    await app.getByRole('button', { name: 'Tak, wyłącz' }).click();
    await expect(app.getByText('Program jest wyłączony.')).toBeVisible();
    const off = await json<{ enabled: boolean }>(
      await request.get(`${orgBase}/loyalty/program`, { headers: owner }),
    );
    expect(off.enabled).toBe(false);
    await context.close();
  } finally {
    businessApp.server.close();
  }
});
