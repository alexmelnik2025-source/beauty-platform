import {
  expect,
  test,
  type APIRequestContext,
  type APIResponse,
  type Page,
} from '@playwright/test';
import { freshAddress } from './addresses';
import { waitForEmail } from './mailpit';
import { serveApp } from './mobile-app';

/**
 * Task 180b, part 3: the client app's start screen searches before signing in ("Czego szukasz?"),
 * the catalogue asks the server for it, and "W pobliżu" puts the nearest salons first with the
 * distance. Screenshots 180b-b … 180b-d. Named to run after booking.spec.ts, which counts the salons of
 * a fresh catalogue.
 */

const PASSWORD = 'e2e-password-123';
const run = Date.now().toString(36);
const PHONE = { width: 390, height: 844 };
const CLOSE = `Blisko ${run}`;
const FAR = `Daleko ${run}`;
/** The app's salons; the site's test has its own (tests may run at the same time). */
const APP_CLOSE = `${CLOSE} app`;
const APP_FAR = `${FAR} app`;

const shot = (page: Page, name: string) => page.screenshot({ path: `e2e/screenshots/${name}.png` });

async function json<T>(res: APIResponse): Promise<T> {
  expect(res.ok(), `${res.url()} → ${res.status()} ${await res.text()}`).toBeTruthy();
  return (res.status() === 204 ? undefined : await res.json()) as T;
}

async function owner(api: APIRequestContext, who = 'app'): Promise<Record<string, string>> {
  const email = `home-${who}-${run}@example.com`;
  await json(
    await api.post('/v1/auth/register', {
      headers: freshAddress(),
      data: { email, password: PASSWORD, name: 'Aleksander Owner' },
    }),
  );
  const mail = await waitForEmail(email, /Potwierdź adres/);
  const token = /token=([^\s&]+)/.exec(mail.text)?.[1];
  await json(
    await api.post('/v1/auth/verify-email', { data: { token: decodeURIComponent(token!) } }),
  );
  const login = await json<{ accessToken: string }>(
    // Logins too are limited per address (30 in 15 minutes): one of its own.
    await api.post('/v1/auth/login', {
      headers: freshAddress(),
      data: { email, password: PASSWORD, clientType: 'mobile' },
    }),
  );
  return { Authorization: `Bearer ${login.accessToken}` };
}

async function salon(
  api: APIRequestContext,
  auth: Record<string, string>,
  name: string,
  place: { latitude: number; longitude: number } | Record<string, never>,
  team: { name: string; languages: string[]; specialties: string[] }[],
): Promise<void> {
  const org = await json<{ id: string }>(
    await api.post('/v1/organizations', { headers: auth, data: { name } }),
  );
  const location = await json<{ id: string }>(
    await api.post(`/v1/organizations/${org.id}/locations`, {
      headers: auth,
      data: {
        name,
        addressLine: 'ul. Mapowa 1',
        city: 'Aleksandrów Kujawski',
        postalCode: '87-700',
        ...place,
        onlineBookingEnabled: true,
        bookingTerms: '# Regulamin\n\nWizyta jest bezpłatna do odwołania.',
        privacyPolicy: `# Prywatność\n\nAdministratorem danych jest ${name}.`,
      },
    }),
  );
  const base = `/v1/organizations/${org.id}/locations/${location.id}`;
  const service = await json<{ id: string }>(
    await api.post(`${base}/services`, {
      headers: auth,
      data: { name: 'Usługa', durationMinutes: 30, priceGrosze: 5000 },
    }),
  );
  for (const member of team) {
    await json(
      await api.post(`${base}/staff`, {
        headers: auth,
        data: {
          displayName: member.name,
          languages: member.languages,
          specialties: member.specialties,
          serviceIds: [service.id],
        },
      }),
    );
  }
}

test('the app searches from the start screen and lists the nearest salons first', async ({
  browser,
  request,
}) => {
  const auth = await owner(request);
  await salon(request, auth, APP_FAR, { latitude: 50.0614, longitude: 19.9366 }, [
    { name: 'Ilian', languages: ['pl'], specialties: ['barber'] },
  ]);
  await salon(request, auth, APP_CLOSE, { latitude: 52.231, longitude: 21.0122 }, [
    { name: 'Nazar', languages: ['pl'], specialties: ['barber'] },
  ]);

  const clientApp = await serveApp('mobile-client');
  const phone = await browser.newContext({
    viewport: PHONE,
    isMobile: true,
    locale: 'pl-PL',
    timezoneId: 'Europe/Warsaw',
    // The phone "is" in the centre of Warsaw and the client allows the location.
    geolocation: { latitude: 52.2297, longitude: 21.0122 },
    permissions: ['geolocation'],
  });
  try {
    const app = await phone.newPage();
    await app.goto(clientApp.url);
    // The start screen: the search comes first, signing in is below it.
    const what = app.getByLabel('Czego szukasz?', { exact: true });
    await expect(what).toBeVisible();
    await expect(
      app.getByText(
        'Szukaj salonu bez logowania — konto założy się samo przy pierwszej rezerwacji.',
      ),
    ).toBeVisible();
    await expect(app.getByLabel('E-mail', { exact: true })).toBeVisible();
    await what.fill(`kujawski app ${run}`);
    await shot(app, '180b-b-client-app-start-search');
    await app.getByRole('button', { name: 'Szukaj', exact: true }).click();

    // The catalogue keeps what was typed and finds both salons (the city, without Polish letters).
    await expect(app.getByRole('heading', { name: 'Znajdź salon' })).toBeVisible();
    await expect(app.getByLabel('Czego szukasz? Usługa, salon, miasto lub ulica')).toHaveValue(
      `kujawski app ${run}`,
    );
    await expect(app.getByRole('article', { name: APP_CLOSE })).toBeVisible();
    await expect(app.getByRole('article', { name: APP_FAR })).toBeVisible();
    await expect(app.getByText('Znalezione salony: 2')).toBeVisible();

    // "W pobliżu": the list, nearest first, with the distance from the client.
    await app.getByRole('button', { name: /W pobliżu/ }).click();
    await expect(app.getByRole('button', { name: /W pobliżu/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    const cards = app.getByRole('article');
    await expect(cards.first()).toHaveAccessibleName(APP_CLOSE);
    await expect(cards.nth(1)).toHaveAccessibleName(APP_FAR);
    await expect(cards.first().getByText('0,1 km od Ciebie')).toBeVisible();
    await expect(cards.nth(1).getByText(/^\d{3} km od Ciebie$/)).toBeVisible();
    await shot(app, '180b-c-client-app-near-me');

    // Off again, and a search that finds nothing says so.
    await app.getByRole('button', { name: /W pobliżu/ }).click();
    await expect(cards.first().getByText(/km od Ciebie/)).toHaveCount(0);
    await app.getByLabel('Czego szukasz? Usługa, salon, miasto lub ulica').fill(`gdansk ${run}`);
    await expect(app.getByText('Nic nie znaleziono. Zmień wyszukiwanie.')).toBeVisible();
    await shot(app, '180b-d-client-app-search-empty');
  } finally {
    await phone.close();
    clientApp.server.close();
  }
});

test('the site catalogue lists the nearest salons first with the distance (task 180b)', async ({
  browser,
  request,
}) => {
  const auth = await owner(request, 'site');
  await salon(request, auth, `${FAR} site`, { latitude: 50.0614, longitude: 19.9366 }, [
    { name: 'Ilian', languages: ['pl'], specialties: ['barber'] },
  ]);
  await salon(request, auth, `${CLOSE} site`, { latitude: 52.231, longitude: 21.0122 }, [
    { name: 'Nazar', languages: ['pl'], specialties: ['barber'] },
  ]);
  const site = await browser.newContext({
    viewport: PHONE,
    isMobile: true,
    locale: 'pl-PL',
    geolocation: { latitude: 52.2297, longitude: 21.0122 },
    permissions: ['geolocation'],
  });
  try {
    const page = await site.newPage();
    await page.goto(`/pl/salons?q=${encodeURIComponent(`site ${run}`)}`);
    await expect(page.getByText('Znalezione salony: 2')).toBeVisible();
    await page.getByRole('button', { name: /W pobliżu/ }).click();
    await expect(page.getByRole('button', { name: /W pobliżu/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    const cards = page.getByRole('article');
    await expect(cards.first()).toHaveAccessibleName(`${CLOSE} site`);
    await expect(cards.first().getByText('0,1 km od Ciebie')).toBeVisible();
    await expect(cards.nth(1)).toHaveAccessibleName(`${FAR} site`);
    await expect(cards.nth(1).getByText(/^\d{3} km od Ciebie$/)).toBeVisible();
    await shot(page, '180b-e-catalogue-near-me-site');
  } finally {
    await site.close();
  }
});

test('"W pobliżu" on the home page opens the catalogue with the nearest salons (task 205)', async ({
  browser,
  request,
}) => {
  const auth = await owner(request, 'home');
  await salon(request, auth, `${CLOSE} home`, { latitude: 52.2299, longitude: 21.0122 }, [
    { name: 'Nazar', languages: ['pl'], specialties: ['barber'] },
  ]);
  const site = await browser.newContext({
    viewport: PHONE,
    isMobile: true,
    locale: 'pl-PL',
    geolocation: { latitude: 52.2297, longitude: 21.0122 },
    permissions: ['geolocation'],
  });
  try {
    const page = await site.newPage();
    await page.goto('/pl');
    await page.getByRole('link', { name: '⌖ W pobliżu' }).click();
    await expect(page).toHaveURL(/\/pl\/salons\?near=1/);
    await expect(page.getByRole('button', { name: /W pobliżu/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    const close = page.getByRole('article', { name: `${CLOSE} home` });
    await expect(close.getByText('0,0 km od Ciebie')).toBeVisible();
    await shot(page, '205-home-near-me');
  } finally {
    await site.close();
  }
});
