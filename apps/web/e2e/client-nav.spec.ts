import { expect, request as playwrightRequest, test, type APIResponse } from '@playwright/test';
import { waitForEmail } from './mailpit';

/**
 * Task 180 (owner's note 05.11, 01:32: "where do I sign up? where do I find a salon?"): the
 * client's menu on the home page, the catalogue, a salon's booking page and "My visits" —
 * "Znajdź salon" and "Zaloguj się · bez hasła — kod na e-mail"; the home page for clients with
 * "Dla salonów" at the bottom; no menu inside the window on the salon's own site.
 * Screenshots 180, 180a, 180b.
 */

const PASSWORD = 'e2e-password-123';
const run = Date.now().toString(36);
const OWNER = `nav-owner-${run}@example.com`;
const PHONE = { width: 390, height: 844 };
const n = Math.floor(Math.random() * 65_536);
const ADDRESS = { 'x-forwarded-for': `198.18.${n >> 8}.${n & 255}` };

async function json<T>(res: APIResponse): Promise<T> {
  expect(res.ok(), `${res.url()} → ${res.status()} ${await res.text()}`).toBeTruthy();
  return (res.status() === 204 ? undefined : await res.json()) as T;
}

/** A salon open for online booking (one service, one specialist). */
async function bookableSalon(baseURL: string): Promise<string> {
  const api = await playwrightRequest.newContext({ baseURL, extraHTTPHeaders: ADDRESS });
  await json(
    await api.post('/v1/auth/register', {
      data: { email: OWNER, password: PASSWORD, name: 'Nav Owner' },
    }),
  );
  const mail = await waitForEmail(OWNER, /Potwierdź adres/);
  const token = /token=([^\s&]+)/.exec(mail.text)?.[1];
  await json(
    await api.post('/v1/auth/verify-email', { data: { token: decodeURIComponent(token!) } }),
  );
  const login = await json<{ accessToken: string }>(
    await api.post('/v1/auth/login', {
      data: { email: OWNER, password: PASSWORD, clientType: 'mobile' },
    }),
  );
  const owner = { Authorization: `Bearer ${login.accessToken}` };
  const org = await json<{ id: string }>(
    await api.post('/v1/organizations', { headers: owner, data: { name: `Nav Barber ${run}` } }),
  );
  const location = await json<{ id: string; slug: string }>(
    await api.post(`/v1/organizations/${org.id}/locations`, {
      headers: owner,
      data: {
        name: `Nav Barber ${run}`,
        addressLine: 'ul. Puławska 1',
        city: 'Warszawa',
        postalCode: '02-515',
        onlineBookingEnabled: true,
        bookingTerms: '# Regulamin\n\nWizyta jest bezpłatna do odwołania.',
        privacyPolicy: '# Prywatność\n\nAdministratorem danych jest salon.',
      },
    }),
  );
  const base = `/v1/organizations/${org.id}/locations/${location.id}`;
  const service = await json<{ id: string }>(
    await api.post(`${base}/services`, {
      headers: owner,
      data: { name: 'Strzyżenie męskie', durationMinutes: 45, priceGrosze: 9000, bufferMinutes: 0 },
    }),
  );
  await json(
    await api.post(`${base}/staff`, {
      headers: owner,
      data: { displayName: 'Marek', serviceIds: [service.id] },
    }),
  );
  // Online booking ends with the test: the catalogue tests count their own salons.
  const saved = await json<{ version: number }>(await api.get(base, { headers: owner }));
  const off = async () =>
    json(
      await api.patch(base, {
        headers: owner,
        data: { version: saved.version, onlineBookingEnabled: false },
      }),
    );
  cleanups.push(async () => {
    await off();
    await api.dispose();
  });
  return location.slug;
}

const cleanups: (() => Promise<unknown>)[] = [];
test.afterAll(async () => {
  for (const cleanup of cleanups) await cleanup();
});

test('a client finds a salon and "Moje wizyty" from every client page (task 180)', async ({
  browser,
  baseURL,
}) => {
  const slug = await bookableSalon(baseURL!);
  const context = await browser.newContext({ viewport: PHONE, locale: 'pl-PL', isMobile: true });
  const page = await context.newPage();

  // ── Home page: two big choices, the salon dashboard at the bottom ───────
  await page.goto('/pl');
  const menu = page.getByRole('navigation', { name: 'Menu klienta' });
  await expect(page.getByRole('heading', { name: 'Umów wizytę w salonie' })).toBeVisible();
  await expect(
    menu.getByRole('link', { name: /Zaloguj się.*bez hasła — kod na e-mail/ }),
  ).toBeVisible();
  await expect(page.getByRole('link', { name: 'Dla salonów' })).toHaveAttribute(
    'href',
    '/pl/login',
  );
  await page.screenshot({ path: 'e2e/screenshots/180-client-home.png' });

  // ── Task 180b: "Czego szukasz?" + "Gdzie?", kinds of place ──────────────
  const searchForm = page.getByRole('search');
  await expect(page.getByRole('link', { name: 'Barber', exact: true })).toHaveAttribute(
    'href',
    '/pl/salons?specialty=barber',
  );
  await searchForm.getByLabel('Czego szukasz?').fill(`nav barber ${run}`);
  await searchForm.getByLabel('Gdzie?').fill('warszawa');
  await page.screenshot({ path: 'e2e/screenshots/180b-client-home-search.png' });
  await searchForm.getByRole('button', { name: 'Szukaj' }).click();
  await expect(page).toHaveURL(/\/pl\/salons\?q=nav/);
  await expect(page.getByRole('article', { name: `Nav Barber ${run}` })).toBeVisible();
  await expect(page.getByText('Znalezione salony: 1')).toBeVisible();
  await expect(page.getByLabel('Szukaj: nazwa, miasto, ulica lub usługa')).toHaveValue(
    `nav barber ${run} warszawa`,
  );
  await page.screenshot({ path: 'e2e/screenshots/180b-a-catalogue-search.png' });
  // Without Polish letters, with the service: "strzyzenie meskie" is "Strzyżenie męskie".
  await page
    .getByLabel('Szukaj: nazwa, miasto, ulica lub usługa')
    .fill(`strzyzenie meskie barber ${run}`);
  await expect(page).toHaveURL(/\/pl\/salons/);
  await expect(page.getByText('Znalezione salony: 1')).toBeVisible();
  await page.getByLabel('Szukaj: nazwa, miasto, ulica lub usługa').fill(`golenie ${run}`);
  await expect(page.getByText('Znalezione salony: 0')).toBeVisible();
  await page.getByLabel('Szukaj: nazwa, miasto, ulica lub usługa').fill('');
  await page.goto('/pl');

  // ── The catalogue: the hint that no account is needed ──────────────────
  await page
    .getByRole('main')
    .getByRole('link', { name: /Znajdź salon/ })
    .click();
  await expect(page.getByRole('heading', { name: 'Znajdź salon' })).toBeVisible();
  await expect(
    page.getByText('Wybierz salon i kliknij „Umów wizytę” — konto nie jest potrzebne.'),
  ).toBeVisible();
  await expect(menu.getByRole('link', { name: 'Znajdź salon' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await page.screenshot({ path: 'e2e/screenshots/180a-catalogue-menu.png' });

  // ── A salon's booking page has the same menu; the salon's own site does not ──
  await page.goto(`/pl/b/${slug}`);
  await expect(page.getByRole('heading', { name: `Nav Barber ${run}` })).toBeVisible();
  await expect(menu.getByRole('link', { name: 'Znajdź salon' })).toBeVisible();
  await page.screenshot({ path: 'e2e/screenshots/180b-booking-menu.png' });
  await page.goto(`/pl/b/${slug}?embed=1`);
  await expect(page.getByRole('heading', { name: `Nav Barber ${run}` })).toBeVisible();
  await expect(menu).toHaveCount(0);

  // ── "Zaloguj się" opens "Moje wizyty" with the code sign-in ─────────────
  await page.goto('/pl/salons');
  await menu.getByRole('link', { name: /Zaloguj się/ }).click();
  await expect(page.getByRole('heading', { name: 'Moje wizyty' })).toBeVisible();
  await expect(page).toHaveURL(/\/pl\/c$/);
  await context.close();
});
