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
 * Task Q2 (part 5): a link opens the client app (web preview of apps/mobile-client) at a salon.
 * (The file name keeps this after booking.spec.ts, which counts the salons of the catalogue.)
 * With `?service=…` the booking starts straight at the specialists of that service; with
 * `?service=…&staff=…` — at the free times of that specialist; a plain salon link opens the
 * salon's page. Screenshots Q2-app-link-staff, Q2-app-link-time, Q2-app-link-salon.
 */

const PASSWORD = 'e2e-password-123';
const run = Date.now().toString(36);
const PHONE = { width: 390, height: 844 };
const NAME = `Link Do Aplikacji ${run}`;
const OWNER = `app-deep-link-${run}@example.com`;

const shot = (page: Page, name: string) => page.screenshot({ path: `e2e/screenshots/${name}.png` });

async function json<T>(res: APIResponse): Promise<T> {
  expect(res.ok(), `${res.url()} → ${res.status()} ${await res.text()}`).toBeTruthy();
  return (res.status() === 204 ? undefined : await res.json()) as T;
}

async function onlineSalon(
  api: APIRequestContext,
): Promise<{ slug: string; serviceId: string; staffId: string }> {
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
        addressLine: 'ul. Józefa Bema 91',
        city: 'Warszawa',
        postalCode: '01-233',
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
      data: { name: 'Strzyżenie męskie', durationMinutes: 45, priceGrosze: 9000 },
    }),
  );
  const staff = await json<{ id: string }>(
    await api.post(`${base}/staff`, {
      headers: owner,
      data: { displayName: 'Kasia', serviceIds: [service.id] },
    }),
  );
  // A second specialist: with one, the app would skip the "who" step (as the web page does).
  await json(
    await api.post(`${base}/staff`, {
      headers: owner,
      data: { displayName: 'Marek', serviceIds: [service.id] },
    }),
  );
  return { slug: location.slug, serviceId: service.id, staffId: staff.id };
}

test('a link opens the client app at the salon, service and specialist (task Q2)', async ({
  browser,
  request,
}) => {
  const { slug, serviceId, staffId } = await onlineSalon(request);
  const phone = await browser.newContext({ viewport: PHONE, isMobile: true, locale: 'pl-PL' });
  const clientApp = await serveApp('mobile-client');
  try {
    const app = await phone.newPage();
    // The salon's booking page link with the service: straight to "who".
    await app.goto(`${clientApp.url}/pl/b/${slug}?service=${serviceId}`);
    await expect(app.getByRole('heading', { name: 'Wybierz specjalistę' })).toBeVisible();
    await expect(app.getByRole('button', { name: /Kasia/ })).toBeVisible();
    await expect(app.getByRole('button', { name: /Marek/ })).toBeVisible();
    await shot(app, 'Q2-app-link-staff');

    // With the specialist too: straight to the free times.
    await app.goto(`${clientApp.url}/pl/b/${slug}?service=${serviceId}&staff=${staffId}`);
    await expect(app.getByRole('heading', { name: 'Wybierz termin' })).toBeVisible();
    await shot(app, 'Q2-app-link-time');

    // The salon's short link alone: its page.
    await app.goto(`${clientApp.url}/s/${slug}?utm_source=qr`);
    await expect(app.getByRole('heading', { name: NAME })).toBeVisible();
    await expect(app.getByRole('button', { name: 'Umów wizytę' })).toBeVisible();
    await shot(app, 'Q2-app-link-salon');

    // Any other address: the app starts as usual.
    await app.goto(`${clientApp.url}/pl/salons`);
    await expect(app.getByRole('button', { name: 'Znajdź salon' })).toBeVisible();
  } finally {
    await phone.close();
    clientApp.server.close();
  }
});
