import {
  expect,
  test,
  type APIRequestContext,
  type APIResponse,
  type Page,
} from '@playwright/test';
import { freshAddress } from './addresses';
import { waitForEmail } from './mailpit';

/**
 * Task 400: "Inne salony w pobliżu" at the end of a salon page. Four salons of one owner in
 * Gdańsk, Sopot and Zakopane: the Gdańsk salon's page lists Wrzeszcz (2,3 km) and Sopot, not
 * itself and not Zakopane (farther than 30 km); a name opens that salon's page (screenshot 400).
 * The file name sorts after the specs that count every salon in the catalogue.
 */

const PASSWORD = 'e2e-password-123';
const run = Date.now().toString(36);
const PHONE = { width: 390, height: 844 };
const PREFIX = `Sąsiedzi ${run}`;

const shot = (page: Page, name: string) => page.screenshot({ path: `e2e/screenshots/${name}.png` });

async function json<T>(res: APIResponse): Promise<T> {
  expect(res.ok(), `${res.url()} → ${res.status()} ${await res.text()}`).toBeTruthy();
  return (res.status() === 204 ? undefined : await res.json()) as T;
}

async function owner(api: APIRequestContext): Promise<Record<string, string>> {
  const email = `nearby-${run}@example.com`;
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
): Promise<string> {
  const org = await json<{ id: string }>(
    await api.post('/v1/organizations', { headers: auth, data: { name } }),
  );
  const location = await json<{ id: string; slug: string }>(
    await api.post(`/v1/organizations/${org.id}/locations`, {
      headers: auth,
      data: {
        name,
        addressLine: 'ul. Długa 1',
        city: 'Gdańsk',
        postalCode: '80-001',
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
  return location.slug;
}

test('a salon page lists the other salons nearby, nearest first', async ({ browser, request }) => {
  const auth = await owner(request);
  const team = [{ name: 'Kasia', languages: ['pl'], specialties: ['barber'] }];
  const main = await salon(
    request,
    auth,
    `${PREFIX} Główny`,
    { latitude: 54.352, longitude: 18.6466 },
    team,
  );
  await salon(request, auth, `${PREFIX} Wrzeszcz`, { latitude: 54.3722, longitude: 18.6383 }, team);
  await salon(request, auth, `${PREFIX} Sopot`, { latitude: 54.4416, longitude: 18.5601 }, team);
  await salon(request, auth, `${PREFIX} Zakopane`, { latitude: 49.2992, longitude: 19.9496 }, team);

  const phone = await browser.newContext({
    viewport: PHONE,
    isMobile: true,
    locale: 'pl-PL',
    timezoneId: 'Europe/Warsaw',
  });
  try {
    const page = await phone.newPage();
    await page.goto(`/pl/b/${main}`);
    const section = page.getByRole('region', { name: 'Inne salony w pobliżu' });
    await expect(section).toBeVisible();
    const cards = section.getByRole('article');
    const wrzeszcz = section.getByRole('article', { name: `${PREFIX} Wrzeszcz` });
    await expect(wrzeszcz).toContainText('2,3 km stąd');
    await expect(section.getByRole('article', { name: `${PREFIX} Sopot` })).toBeVisible();
    await expect(section.getByRole('article', { name: `${PREFIX} Zakopane` })).toHaveCount(0);
    await expect(section.getByRole('article', { name: `${PREFIX} Główny` })).toHaveCount(0);
    expect(await cards.count()).toBeLessThanOrEqual(3);
    await section.scrollIntoViewIfNeeded();
    await shot(page, '400-salon-nearby');

    await wrzeszcz.getByRole('link', { name: `${PREFIX} Wrzeszcz` }).click();
    await expect(page.getByRole('heading', { level: 1, name: `${PREFIX} Wrzeszcz` })).toBeVisible();
    // From Wrzeszcz, Główny is the nearest.
    await expect(
      page
        .getByRole('region', { name: 'Inne salony w pobliżu' })
        .getByRole('article', { name: `${PREFIX} Główny` }),
    ).toContainText('2,3 km stąd');

    // On the salon's own site (embed) the client stays with this salon.
    await page.goto(`/pl/b/${main}?embed=1`);
    await expect(page.getByRole('heading', { level: 1, name: `${PREFIX} Główny` })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Inne salony w pobliżu' })).toHaveCount(0);
  } finally {
    await phone.close();
  }
});
