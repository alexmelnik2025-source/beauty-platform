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
 * Task 191 (owner's manual test 05.11: "the map does not work"): the catalogue's map really draws —
 * OpenStreetMap tiles load and the salons are markers, on the site and in the client app. Salons
 * that have not marked their place are still listed, and the map still shows the country with a
 * line saying why there is no marker. Screenshots 191–191b.
 */

const PASSWORD = 'e2e-password-123';
const run = Date.now().toString(36);
const PHONE = { width: 390, height: 844 };
const ON_MAP = `Na mapie ${run}`;
const NO_PLACE = `Bez miejsca ${run}`;

const shot = (page: Page, name: string) => page.screenshot({ path: `e2e/screenshots/${name}.png` });

async function json<T>(res: APIResponse): Promise<T> {
  expect(res.ok(), `${res.url()} → ${res.status()} ${await res.text()}`).toBeTruthy();
  return (res.status() === 204 ? undefined : await res.json()) as T;
}

async function owner(api: APIRequestContext): Promise<Record<string, string>> {
  const email = `map-render-${run}@example.com`;
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

/** Answers of the OpenStreetMap tile server that came back with a picture. */
function countTiles(page: Page): () => number {
  let loaded = 0;
  page.on('response', (res) => {
    if (res.url().startsWith('https://tile.openstreetmap.org/') && res.status() === 200) loaded++;
  });
  return () => loaded;
}

test('the catalogue map draws tiles and markers; salons without a place stay in the list', async ({
  browser,
  request,
}) => {
  const auth = await owner(request);
  await salon(request, auth, ON_MAP, { latitude: 52.2297, longitude: 21.0122 }, [
    { name: 'Ilian', languages: ['pl'], specialties: ['barber'] },
  ]);
  await salon(request, auth, NO_PLACE, {}, [
    { name: 'Nazar', languages: ['pl'], specialties: ['barber'] },
  ]);

  // ── The site: /pl/salons ──────────────────────────────────────────────
  const site = await browser.newContext({ viewport: PHONE, isMobile: true, locale: 'pl-PL' });
  const page = await site.newPage();
  const siteTiles = countTiles(page);
  await page.goto('/pl/salons');
  const map = page.getByRole('img', { name: 'Mapa salonów' });
  await expect(map).toBeVisible();
  await expect(map.locator('circle.directory-marker').first()).toBeVisible();
  await expect.poll(siteTiles, { timeout: 15_000 }).toBeGreaterThan(0);
  await map.scrollIntoViewIfNeeded();
  await shot(page, '191-catalogue-map-site');
  await site.close();

  // ── The client app (web preview) ─────────────────────────────────────
  const clientApp = await serveApp('mobile-client');
  const phone = await browser.newContext({
    viewport: PHONE,
    isMobile: true,
    locale: 'pl-PL',
    timezoneId: 'Europe/Warsaw',
  });
  try {
    const app = await phone.newPage();
    const appTiles = countTiles(app);
    await app.goto(clientApp.url);
    await app.getByRole('button', { name: 'Znajdź salon' }).click();
    await app.getByLabel('Szukaj: nazwa, miasto, ulica').fill(ON_MAP);
    await expect(app.getByRole('img', { name: 'Mapa salonów' })).toBeVisible();
    await expect(app.getByRole('button', { name: `Salon na mapie: ${ON_MAP}` })).toBeVisible();
    await expect.poll(appTiles, { timeout: 15_000 }).toBeGreaterThan(0);
    await shot(app, '191a-client-app-map');

    // A salon without a place: in the list, the map shows the country and says why.
    await app.getByLabel('Szukaj: nazwa, miasto, ulica').fill(NO_PLACE);
    await expect(app.getByRole('article', { name: NO_PLACE })).toBeVisible();
    await expect(app.getByRole('img', { name: 'Mapa salonów' })).toBeVisible();
    await expect(app.getByText('Te salony nie zaznaczyły jeszcze miejsca na mapie.')).toBeVisible();
    await expect(app.getByRole('button', { name: /^Salon na mapie:/ })).toHaveCount(0);
    await shot(app, '191b-client-app-map-no-place');
  } finally {
    await phone.close();
    clientApp.server.close();
  }
});
