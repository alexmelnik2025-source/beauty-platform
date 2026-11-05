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
 * Task 160: the client app's "Znajdź salon" opens on a map (OpenStreetMap tiles). Language chips
 * carry the number of places ("🇺🇦 UA (1)"), the kind of place is the second filter; a marker
 * opens a small card (how many specialists speak the language, "Umów") → the salon's page.
 * Screenshots 160–160c.
 */

const PASSWORD = 'e2e-password-123';
const run = Date.now().toString(36);
const PHONE = { width: 390, height: 844 };
const BARBER = `Mapa Barber ${run}`;
const NAILS = `Mapa Paznokcie ${run}`;

const shot = (page: Page, name: string) => page.screenshot({ path: `e2e/screenshots/${name}.png` });

async function json<T>(res: APIResponse): Promise<T> {
  expect(res.ok(), `${res.url()} → ${res.status()} ${await res.text()}`).toBeTruthy();
  return (res.status() === 204 ? undefined : await res.json()) as T;
}

async function owner(api: APIRequestContext): Promise<Record<string, string>> {
  const email = `map-${run}@example.com`;
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
  place: { latitude: number; longitude: number },
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

test('the client app opens the catalogue on a map with language and kind-of-place chips', async ({
  browser,
  request,
}) => {
  const auth = await owner(request);
  await salon(request, auth, BARBER, { latitude: 52.8669, longitude: 18.6958 }, [
    { name: 'Taras', languages: ['uk', 'pl'], specialties: ['barber'] },
    { name: 'Oksana', languages: ['uk'], specialties: ['barber'] },
    { name: 'Piotr', languages: ['pl'], specialties: ['barber'] },
  ]);
  await salon(request, auth, NAILS, { latitude: 52.8742, longitude: 18.7031 }, [
    { name: 'Ania', languages: ['pl'], specialties: ['nails'] },
  ]);

  const clientApp = await serveApp('mobile-client');
  const phone = await browser.newContext({
    viewport: PHONE,
    isMobile: true,
    locale: 'pl-PL',
    timezoneId: 'Europe/Warsaw',
  });
  try {
    const app = await phone.newPage();
    await app.goto(clientApp.url);
    await app.getByRole('button', { name: 'Znajdź salon' }).click();
    await expect(app.getByRole('heading', { name: 'Znajdź salon' })).toBeVisible();
    // The map first, with both salons on it.
    await expect(app.getByRole('img', { name: 'Mapa salonów' })).toBeVisible();
    await expect(app.getByRole('button', { name: 'Mapa', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(app.getByRole('button', { name: `Salon na mapie: ${BARBER}` })).toBeVisible();
    await expect(app.getByRole('button', { name: `Salon na mapie: ${NAILS}` })).toBeVisible();
    await expect(app.getByRole('button', { name: /^ukraiński \(\d+\)$/ })).toContainText('UA (');
    await shot(app, '160-client-app-catalogue-map');

    // Ukrainian: the nail salon leaves the map; the barber's marker says 2 specialists speak it.
    await app.getByRole('button', { name: /^ukraiński \(\d+\)$/ }).click();
    await expect(app.getByRole('button', { name: `Salon na mapie: ${NAILS}` })).toHaveCount(0);
    const marker = app.getByRole('button', { name: `Salon na mapie: ${BARBER}` });
    await expect(marker).toHaveText('2');
    await marker.click();
    const card = app.getByRole('region', { name: BARBER });
    await expect(card).toContainText('Specjaliści mówiący — ukraiński: 2');
    await expect(card).toContainText(/Usługi od 50,00\s*zł/);
    await expect(card).toContainText(/Dziś (są wolne terminy|brak wolnych terminów)/);
    await shot(app, '160a-client-app-map-card');

    // Task 192: Ukrainian or Polish - both salons; a specialist counts once.
    await app.getByRole('button', { name: /^polski \(\d+\)$/ }).click();
    await expect(app.getByRole('button', { name: /^polski \(\d+\)$/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(app.getByRole('button', { name: `Salon na mapie: ${NAILS}` })).toHaveText('1');
    await expect(app.getByRole('button', { name: `Salon na mapie: ${BARBER}` })).toHaveText('3');
    await shot(app, '192a-client-app-languages-or');
    await app.getByRole('button', { name: 'Wyczyść' }).click();
    await expect(app.getByRole('button', { name: /^Wszystkie języki/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    // The kind of place: nails only (with every language).
    await app.getByRole('button', { name: /^Wszystkie języki/ }).click();
    await app.getByRole('button', { name: /^Manicure i pedicure \(\d+\)$/ }).click();
    await expect(app.getByRole('button', { name: `Salon na mapie: ${NAILS}` })).toBeVisible();
    await expect(app.getByRole('button', { name: `Salon na mapie: ${BARBER}` })).toHaveCount(0);
    await shot(app, '160b-client-app-map-nails');

    // The list view, and "Umów" on the card opens the salon's page.
    await app.getByRole('button', { name: 'Lista', exact: true }).click();
    await expect(app.getByRole('img', { name: 'Mapa salonów' })).toHaveCount(0);
    await expect(app.getByRole('article', { name: NAILS })).toBeVisible();
    await shot(app, '160c-client-app-list');
    await app.getByRole('button', { name: 'Mapa', exact: true }).click();
    await app.getByRole('button', { name: `Salon na mapie: ${NAILS}` }).click();
    await app
      .getByRole('region', { name: NAILS })
      .getByRole('button', { name: 'Umów wizytę' })
      .click();
    await expect(app.getByRole('heading', { name: NAILS })).toBeVisible();
  } finally {
    await phone.close();
    clientApp.server.close();
  }
});
