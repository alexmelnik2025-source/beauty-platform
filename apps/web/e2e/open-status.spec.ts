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
      await app
        .getByRole('article', { name: NAME })
        .getByRole('button', { name: 'Zobacz salon' })
        .click();
      const line = app.getByLabel('Otwarte · do północy');
      await expect(line).toBeVisible();
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
  } finally {
    await phone.close();
  }
});
