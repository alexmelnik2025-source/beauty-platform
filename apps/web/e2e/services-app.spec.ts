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
 * Task 93: "Usługi" in the business app (web preview of apps/mobile-business). The owner sees
 * the price list by category with a warning on a service nobody performs, changes a price and a
 * duration, and takes a service off online booking. Task 253: "↑" puts the combo first in its
 * category — the order clients see. Task 255: "↑" by "Broda" puts the category first.
 * Task 310: "Duplikuj" makes a copy of the combo with Kasia's own price. Screenshots 93–93b,
 * 253, 255, 310.
 */

const PASSWORD = 'e2e-password-123';
const run = Date.now().toString(36);
const OWNER = `services-app-owner-${run}@example.com`;
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

test('the owner changes prices, durations and online booking in the business app (task 93)', async ({
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
  const kasia = await json<{ id: string }>(
    await request.post(`${base}/staff`, { headers: owner, data: { displayName: 'Kasia' } }),
  );
  const hair = await json<{ id: string }>(
    await request.post(`${base}/service-categories`, { headers: owner, data: { name: 'Włosy' } }),
  );
  const beard = await json<{ id: string }>(
    await request.post(`${base}/service-categories`, {
      headers: owner,
      data: { name: 'Broda', sortOrder: 1 },
    }),
  );
  const haircut = await json<{ id: string }>(
    await request.post(`${base}/services`, {
      headers: owner,
      data: {
        name: 'Strzyżenie męskie',
        durationMinutes: 45,
        priceGrosze: 9000,
        categoryId: hair.id,
        staffIds: [kasia.id],
      },
    }),
  );
  const combo = await json<{ id: string }>(
    await request.post(`${base}/services`, {
      headers: owner,
      data: {
        name: 'Strzyżenie + broda',
        durationMinutes: 75,
        priceGrosze: 13000,
        categoryId: hair.id,
        staffIds: [kasia.id],
      },
    }),
  );
  // Task 310: Kasia's own price of the combo goes to its copy too.
  await json(
    await request.put(`${base}/services/${combo.id}/staff-prices`, {
      headers: owner,
      data: { prices: [{ staffId: kasia.id, priceGrosze: 14000 }] },
    }),
  );
  await json(
    await request.post(`${base}/services`, {
      headers: owner,
      data: {
        name: 'Trymowanie brody',
        durationMinutes: 30,
        priceGrosze: 6000,
        categoryId: beard.id,
      },
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

    // ── The price list by category ─────────────────────────────────────
    await app.getByRole('button', { name: 'Usługi' }).click();
    await expect(app.getByRole('heading', { name: 'Usługi', exact: true })).toBeVisible();
    await expect(app.getByRole('heading', { name: 'Włosy' })).toBeVisible();
    await expect(app.getByRole('heading', { name: 'Broda' })).toBeVisible();
    await expect(app.getByText(/90,00\s*zł · 45 min/)).toBeVisible();
    await expect(
      app.getByText('Nikt jej nie wykonuje — klienci nie zarezerwują jej online'),
    ).toBeVisible();
    await shot(app, '93-business-app-services');

    // ── Price and duration ─────────────────────────────────────────────
    await app.getByRole('button', { name: 'Zmień: Strzyżenie męskie' }).click();
    await app.getByLabel('Cena (PLN)').fill('95,50');
    await app.getByLabel('Czas (min)').fill('47');
    await app.getByRole('button', { name: 'Zapisz' }).click();
    await expect(app.getByText('Czas w minutach, co 5 minut (5–480).')).toBeVisible();
    await app.getByLabel('Czas (min)').fill('60');
    await shot(app, '93b-business-app-service-edit');
    await app.getByRole('button', { name: 'Zapisz' }).click();
    await expect(app.getByText('Zapisano: Strzyżenie męskie.')).toBeVisible();
    await expect(app.getByText(/95,50\s*zł · 1 g/)).toBeVisible();

    // ── Off online booking ───────────────────────────────────────────────
    await app.getByRole('button', { name: 'Zmień: Strzyżenie męskie' }).click();
    await app.getByRole('checkbox', { name: 'Dostępna do rezerwacji online' }).click();
    await app.getByRole('button', { name: 'Zapisz' }).click();
    await expect(app.getByText('Niedostępna online')).toBeVisible();

    // ── Task 253: the combo goes first in "Włosy" ────────────────────────
    await expect(app.getByRole('button', { name: 'Wyżej: Strzyżenie męskie' })).toHaveCount(0);
    await app.getByRole('button', { name: 'Wyżej: Strzyżenie + broda' }).click();
    await expect(app.getByText('Kolejność zapisana — tak klienci widzą usługi.')).toBeVisible();
    await expect(app.getByRole('button', { name: 'Wyżej: Strzyżenie męskie' })).toBeVisible();
    await expect(app.getByRole('button', { name: 'Wyżej: Strzyżenie + broda' })).toHaveCount(0);
    await shot(app, '253-business-app-service-order');

    // ── Task 255: "Broda" goes first among the categories ─────────────────
    await expect(app.getByRole('button', { name: 'Kategoria wyżej: Włosy' })).toHaveCount(0);
    await app.getByRole('button', { name: 'Kategoria wyżej: Broda' }).click();
    await expect(app.getByRole('button', { name: 'Kategoria wyżej: Włosy' })).toBeVisible();
    await expect(app.getByRole('button', { name: 'Kategoria wyżej: Broda' })).toHaveCount(0);
    await shot(app, '255-business-app-category-order');

    // ── Task 310: "Duplikuj" the combo ──────────────────────────────────
    await app.getByRole('button', { name: 'Duplikuj: Strzyżenie + broda' }).click();
    await expect(app.getByRole('heading', { name: 'Kopia usługi' })).toBeVisible();
    await expect(app.getByLabel('Nazwa')).toHaveValue('Strzyżenie + broda (kopia)');
    await expect(app.getByLabel('Cena (PLN)')).toHaveValue('130');
    await app.getByLabel('Nazwa').fill('');
    await app.getByRole('button', { name: 'Zapisz' }).click();
    await expect(app.getByText('Wpisz nazwę (do 100 znaków).')).toBeVisible();
    await app.getByLabel('Nazwa').fill('Strzyżenie + broda junior');
    await app.getByLabel('Cena (PLN)').fill('110');
    await shot(app, '310-business-app-service-copy');
    await app.getByRole('button', { name: 'Zapisz' }).click();
    await expect(app.getByText('Dodano usługę: Strzyżenie + broda junior.')).toBeVisible();
    await expect(
      app.getByRole('button', { name: 'Zmień: Strzyżenie + broda junior' }),
    ).toBeVisible();
    await context.close();
  } finally {
    businessApp.server.close();
  }

  const saved = await json<{ priceGrosze: number; durationMinutes: number; active: boolean }>(
    await request.get(`${base}/services/${haircut.id}`, { headers: owner }),
  );
  expect(saved).toMatchObject({ priceGrosze: 9550, durationMinutes: 60, active: false });
  const list = await json<{ id: string }[]>(
    await request.get(`${base}/services`, { headers: owner }),
  );
  expect(list.map((s) => s.id).slice(0, 2)).toEqual([combo.id, haircut.id]);
  const categories = await json<{ id: string }[]>(
    await request.get(`${base}/service-categories`, { headers: owner }),
  );
  expect(categories.map((c) => c.id)).toEqual([beard.id, hair.id]);

  // Task 310: the copy — at the end of "Włosy", as the combo, with Kasia's own price.
  const copied = await json<
    {
      id: string;
      name: string;
      categoryId: string | null;
      priceGrosze: number;
      durationMinutes: number;
      staffIds: string[];
    }[]
  >(await request.get(`${base}/services`, { headers: owner }));
  const junior = copied.find((s) => s.name === 'Strzyżenie + broda junior');
  expect(junior).toMatchObject({
    categoryId: hair.id,
    priceGrosze: 11000,
    durationMinutes: 75,
    staffIds: [kasia.id],
  });
  const rates = await json<{
    prices: { serviceId: string; staffId: string; priceGrosze: number }[];
  }>(await request.get(`${base}/staff-prices`, { headers: owner }));
  expect(rates.prices.filter((p) => p.serviceId === junior!.id)).toEqual([
    { serviceId: junior!.id, staffId: kasia.id, priceGrosze: 14000 },
  ]);
});
