import { expect, test, type APIRequestContext, type APIResponse } from '@playwright/test';
import { freshAddress } from './addresses';
import { waitForEmail } from './mailpit';

/**
 * Task 180b (owner's decision 05.11, "as in Fresha"): the client's home page searches —
 * "Czego szukasz?" (a service or the salon's name, accents do not matter), "Gdzie?" (a city),
 * "W pobliżu" (nearest first, with the distance), categories, salons with online booking.
 * Nobody signs in. Screenshots 180c–180f.
 */

const PASSWORD = 'e2e-password-123';
const run = Date.now().toString(36);
const PHONE = { width: 390, height: 844 };
const NAME = `Szukajka Barber ${run}`;
const SERVICE = `Koloryzacja ${run}`;
const CITY = `Zalesie ${run}`;
// Far from the other test salons, so it is the nearest one to a client standing there.
const PLACE = { latitude: 64.1466, longitude: -21.9426 };

async function json<T>(res: APIResponse): Promise<T> {
  expect(res.ok(), `${res.url()} → ${res.status()} ${await res.text()}`).toBeTruthy();
  return (res.status() === 204 ? undefined : await res.json()) as T;
}

async function salon(api: APIRequestContext): Promise<string> {
  const email = `home-search-${run}@example.com`;
  await json(
    await api.post('/v1/auth/register', {
      headers: freshAddress(),
      data: { email, password: PASSWORD, name: 'Search Owner' },
    }),
  );
  const mail = await waitForEmail(email, /Potwierdź adres/);
  const token = /token=([^\s&]+)/.exec(mail.text)?.[1];
  await json(
    await api.post('/v1/auth/verify-email', { data: { token: decodeURIComponent(token!) } }),
  );
  const login = await json<{ accessToken: string }>(
    await api.post('/v1/auth/login', {
      headers: freshAddress(),
      data: { email, password: PASSWORD, clientType: 'mobile' },
    }),
  );
  const auth = { Authorization: `Bearer ${login.accessToken}` };
  const org = await json<{ id: string }>(
    await api.post('/v1/organizations', { headers: auth, data: { name: NAME } }),
  );
  const location = await json<{ id: string; slug: string }>(
    await api.post(`/v1/organizations/${org.id}/locations`, {
      headers: auth,
      data: {
        name: NAME,
        addressLine: 'ul. Szukana 1',
        city: CITY,
        postalCode: '05-500',
        ...PLACE,
        onlineBookingEnabled: true,
        bookingTerms: '# Regulamin\n\nWizyta jest bezpłatna do odwołania.',
        privacyPolicy: `# Prywatność\n\nAdministratorem danych jest ${NAME}.`,
      },
    }),
  );
  const base = `/v1/organizations/${org.id}/locations/${location.id}`;
  const service = await json<{ id: string }>(
    await api.post(`${base}/services`, {
      headers: auth,
      data: { name: SERVICE, durationMinutes: 60, priceGrosze: 15000 },
    }),
  );
  await json(
    await api.post(`${base}/staff`, {
      headers: auth,
      data: { displayName: 'Ewa', specialties: ['barber'], serviceIds: [service.id] },
    }),
  );
  return location.slug;
}

test('the home page searches by service, city and "W pobliżu" without signing in (task 180b)', async ({
  browser,
  request,
}) => {
  const slug = await salon(request);
  const context = await browser.newContext({
    viewport: PHONE,
    isMobile: true,
    locale: 'pl-PL',
    timezoneId: 'Europe/Warsaw',
    geolocation: PLACE,
    permissions: ['geolocation'],
  });
  try {
    const page = await context.newPage();
    await page.goto('/pl');
    await expect(page.getByRole('heading', { name: 'Czego szukasz?' })).toBeVisible();
    const categories = page.getByRole('navigation', { name: 'Kategorie' });
    await expect(categories.getByRole('link', { name: 'Barber' })).toHaveAttribute(
      'href',
      '/pl/salons?specialty=barber',
    );
    await expect(page.getByRole('heading', { name: 'Salony z rezerwacją online' })).toBeVisible();
    await expect(page.getByText('Konto założy się samo przy pierwszej rezerwacji.')).toBeVisible();
    await page.screenshot({ path: 'e2e/screenshots/180c-client-home-search.png', fullPage: true });

    // ── A service, typed without the capital letter: the salon is found ────
    await page.getByLabel('Usługa lub nazwa salonu').fill(SERVICE.toLowerCase());
    await page.getByRole('button', { name: 'Szukaj' }).click();
    await expect(page).toHaveURL(/\/pl\/salons\?q=koloryzacja/);
    await expect(page.getByText(`Wyniki dla: ${SERVICE.toLowerCase()}`)).toBeVisible();
    await expect(page.getByText('Znalezione salony: 1')).toBeVisible();
    await expect(page.getByRole('heading', { name: NAME })).toBeVisible();
    await page.screenshot({ path: 'e2e/screenshots/180d-catalogue-search.png' });

    // ── A city that has nothing of it: the hint ─────────────────────────────
    await page.getByLabel('Gdzie?').fill('Nieistniejące Miasto');
    await page.getByRole('button', { name: 'Szukaj' }).click();
    await expect(
      page.getByText('Nic nie znaleźliśmy. Spróbuj innego słowa albo miasta.'),
    ).toBeVisible();
    await page.getByRole('link', { name: 'Wyczyść wyszukiwanie' }).click();
    await expect(page).toHaveURL(/\/pl\/salons$/);

    // ── The city, without Polish letters, from the home page ───────────────
    await page.goto('/pl');
    await page.getByLabel('Gdzie?').fill(CITY.toUpperCase());
    await page.getByRole('button', { name: 'Szukaj' }).click();
    await expect(page.getByRole('heading', { name: NAME })).toBeVisible();
    await expect(page.getByText('Znalezione salony: 1')).toBeVisible();

    // ── "W pobliżu": the nearest salon first, with the distance ─────────────
    await page.goto('/pl');
    await page.getByRole('button', { name: /W pobliżu/ }).click();
    await expect(page).toHaveURL(/\/pl\/salons\?near=64\.1466%2C-21\.9426/);
    await expect(page.getByText('Wyniki dla: w pobliżu')).toBeVisible();
    const first = page.locator('.directory-salon').first();
    await expect(first.getByRole('heading', { name: NAME })).toBeVisible();
    await expect(first.getByText('0 km od Ciebie')).toBeVisible();
    await page.screenshot({ path: 'e2e/screenshots/180e-catalogue-near-me.png' });

    // ── A category from the home page ──────────────────────────────────────
    await page.goto('/pl');
    await categories.getByRole('link', { name: 'Barber' }).click();
    await expect(page.getByRole('button', { name: /^Barber \(\d+\)$/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await page.screenshot({ path: 'e2e/screenshots/180f-catalogue-category.png' });

    // The salon's page opens without signing in.
    await page.goto(`/pl/b/${slug}`);
    await expect(page.getByRole('heading', { name: NAME })).toBeVisible();
  } finally {
    await context.close();
  }
});
