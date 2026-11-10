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
 * Task 362: "Otwarte teraz". Kasia works around the clock: on the salon page and in the client
 * app "Otwarte · do północy". A vacation for today closes the salon: "Zamknięte · otwarcie:
 * jutro, 00:00", although the weekly table still says 00:00–24:00. Screenshots 362–362b.
 * Task 363: the same line on the salon's card in the catalogue (site and client app), 363–363a.
 * Task 364: and on every salon card of the home page, 364.
 */

const PASSWORD = 'e2e-password-123';
const run = Date.now().toString(36);
const PHONE = { width: 390, height: 844 };
const NAME = `Otwarte Teraz ${run}`;
const OWNER = `open-status-${run}@example.com`;

const shot = (page: Page, name: string) => page.screenshot({ path: `e2e/screenshots/${name}.png` });

async function json<T>(res: APIResponse): Promise<T> {
  expect(res.ok(), `${res.url()} → ${res.status()} ${await res.text()}`).toBeTruthy();
  return (res.status() === 204 ? undefined : await res.json()) as T;
}

async function salonWithKasia(
  api: APIRequestContext,
): Promise<{ slug: string; vacation: () => Promise<void> }> {
  await json(
    await api.post('/v1/auth/register', {
      headers: freshAddress(),
      data: { email: OWNER, password: PASSWORD, name: 'Aleksander Owner' },
    }),
  );
  const mail = await waitForEmail(OWNER, /Potwierdź adres/);
  const token = /token=([^\s&]+)/.exec(mail.text)?.[1];
  await json(
    await api.post('/v1/auth/verify-email', { data: { token: decodeURIComponent(token!) } }),
  );
  const login = await json<{ accessToken: string }>(
    await api.post('/v1/auth/login', {
      headers: freshAddress(),
      data: { email: OWNER, password: PASSWORD, clientType: 'mobile' },
    }),
  );
  const owner = { Authorization: `Bearer ${login.accessToken}` };
  const org = await json<{ id: string }>(
    await api.post('/v1/organizations', { headers: owner, data: { name: NAME } }),
  );
  const location = await json<{ id: string; slug: string }>(
    await api.post(`/v1/organizations/${org.id}/locations`, {
      headers: owner,
      data: {
        name: NAME,
        addressLine: 'ul. Dzika 3',
        city: 'Aleksandrów Kujawski',
        postalCode: '87-700',
        minLeadMinutes: 0,
        onlineBookingEnabled: true,
        bookingTerms: '# Regulamin\n\nWizyta jest bezpłatna do odwołania.',
        privacyPolicy: `# Prywatność\n\nAdministratorem danych jest ${NAME}.`,
      },
    }),
  );
  const base = `/v1/organizations/${org.id}/locations/${location.id}`;
  const service = await json<{ id: string }>(
    await api.post(`${base}/services`, {
      headers: owner,
      data: { name: 'Konturowanie', durationMinutes: 15, priceGrosze: 3000 },
    }),
  );
  const kasia = await json<{ id: string }>(
    await api.post(`${base}/staff`, {
      headers: owner,
      data: { displayName: 'Kasia', serviceIds: [service.id] },
    }),
  );
  await json(
    await api.put(`${base}/staff/${kasia.id}/working-hours`, {
      headers: owner,
      data: {
        days: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
          weekday,
          intervals: [{ start: '00:00', end: '24:00' }],
        })),
      },
    }),
  );
  const vacation = async () => {
    const page = await json<{ todayHours: { date: string } }>(
      await api.get(`/v1/public/locations/${location.slug}`),
    );
    const today = page.todayHours.date;
    const [y, m, d] = today.split('-').map(Number) as [number, number, number];
    const tomorrow = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
    await json(
      await api.post(`${base}/staff/${kasia.id}/time-off`, {
        headers: owner,
        data: { start: `${today}T00:00`, end: `${tomorrow}T00:00`, note: 'Urlop' },
      }),
    );
  };
  return { slug: location.slug, vacation };
}

test('"Otwarte teraz" on the salon page and in the client app', async ({ browser, request }) => {
  const { slug, vacation } = await salonWithKasia(request);
  const phone = await browser.newContext({
    viewport: PHONE,
    isMobile: true,
    locale: 'pl-PL',
    timezoneId: 'Europe/Warsaw',
  });
  try {
    const client = await phone.newPage();
    // Task 364: every salon card of the home page has the line.
    await client.goto('/pl');
    const featured = client.locator('.home-featured li');
    await expect(featured.first()).toBeVisible();
    await expect(client.locator('.home-featured .open-status')).toHaveCount(await featured.count());
    await featured.first().scrollIntoViewIfNeeded();
    await shot(client, '364-home-open-now');

    // Task 363: the card in the catalogue.
    await client.goto(`/pl/salons?q=${encodeURIComponent(NAME)}`);
    const card = client.getByRole('article', { name: NAME });
    await expect(card.locator('.open-status')).toHaveText('Otwarte · do północy');
    await shot(client, '363-catalogue-open-now');

    await client.goto(`/pl/b/${slug}`);
    const status = client.locator('.open-status');
    await expect(status).toHaveText('Otwarte · do północy');
    await expect(status).toHaveAttribute('data-open', 'true');
    await shot(client, '362-booking-open-now');

    const clientApp = await serveApp('mobile-client');
    try {
      const app = await phone.newPage();
      await app.goto(clientApp.url);
      await app.getByRole('button', { name: 'Znajdź salon' }).click();
      await expect(app.getByRole('heading', { name: 'Znajdź salon' })).toBeVisible();
      await app.getByLabel('Czego szukasz? Usługa, salon, miasto lub ulica').fill(NAME);
      const appCard = app.getByRole('article', { name: NAME });
      await expect(appCard.getByLabel('Otwarte · do północy')).toBeVisible();
      await shot(app, '363a-client-app-catalogue-open-now');
      await appCard.getByRole('button', { name: 'Zobacz salon' }).click();
      // The catalogue stays under the salon page: the line of the salon page itself.
      const line = app.getByTestId('salon-open-status');
      await expect(line).toBeVisible();
      await expect(line).toHaveAttribute('aria-label', 'Otwarte · do północy');
      await line.scrollIntoViewIfNeeded();
      await shot(app, '362a-client-app-open-now');
    } finally {
      clientApp.server.close();
    }

    // A vacation for the whole of today: closed, the weekly table does not change.
    await vacation();
    await client.reload();
    await expect(status).toHaveText('Zamknięte · otwarcie: jutro, 00:00');
    await expect(status).toHaveAttribute('data-open', 'false');
    await client.locator('.opening-hours summary').click();
    await expect(client.locator('.opening-hours summary')).toContainText('dziś nieczynne');
    await shot(client, '362b-booking-closed-today');
    await client.goto(`/pl/salons?q=${encodeURIComponent(NAME)}`);
    await expect(card.locator('.open-status')).toHaveText('Zamknięte');
    await expect(card.locator('.open-status')).toHaveAttribute('data-open', 'false');
  } finally {
    await phone.close();
  }
});
