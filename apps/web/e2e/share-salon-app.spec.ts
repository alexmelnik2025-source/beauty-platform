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
 * Task 151: "Poleć salon" in the client app (web preview of apps/mobile-client). The browser has
 * no share menu here, so the salon's booking link is copied and the app says so. Screenshot 151.
 * Task 357: "Pokaż kod QR" — the salon's QR code for a friend nearby; hidden again. Screenshot 357.
 */

const PASSWORD = 'e2e-password-123';
const run = Date.now().toString(36);
const PHONE = { width: 390, height: 844 };
const NAME = `Poleć Salon ${run}`;
const OWNER = `share-salon-${run}@example.com`;

const shot = (page: Page, name: string) => page.screenshot({ path: `e2e/screenshots/${name}.png` });

async function json<T>(res: APIResponse): Promise<T> {
  expect(res.ok(), `${res.url()} → ${res.status()} ${await res.text()}`).toBeTruthy();
  return (res.status() === 204 ? undefined : await res.json()) as T;
}

async function onlineSalon(api: APIRequestContext): Promise<string> {
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
  await json(
    await api.post(`${base}/staff`, {
      headers: owner,
      data: { displayName: 'Kasia', serviceIds: [service.id] },
    }),
  );
  return location.slug;
}

test('the client recommends a salon: its booking link is copied (task 151)', async ({
  browser,
  request,
}) => {
  const slug = await onlineSalon(request);
  const phone = await browser.newContext({
    viewport: PHONE,
    isMobile: true,
    locale: 'pl-PL',
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  // No share menu in this browser: the link goes to the clipboard.
  await phone.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, 'share', { value: undefined, configurable: true });
  });
  const clientApp = await serveApp('mobile-client');
  try {
    const app = await phone.newPage();
    await app.goto(clientApp.url);
    await app.getByRole('button', { name: 'Znajdź salon' }).click();
    await app.getByLabel('Czego szukasz? Usługa, salon, miasto lub ulica').fill(NAME);
    await app
      .getByRole('article', { name: NAME })
      .getByRole('button', { name: 'Zobacz salon' })
      .click();
    await expect(app.getByText('Kasia', { exact: true })).toBeVisible();
    await app.getByRole('button', { name: 'Poleć salon znajomym' }).click();
    await expect(app.getByText('Link skopiowany — wklej go znajomym.')).toBeVisible();
    const copied = await app.evaluate(() => navigator.clipboard.readText());
    expect(copied).toMatch(new RegExp(`/pl/b/${slug}$`));
    await shot(app, '151-client-app-share-salon');

    await app.getByRole('button', { name: 'Pokaż kod QR' }).click();
    const qr = app.getByRole('img', { name: 'Kod QR salonu' });
    await qr.scrollIntoViewIfNeeded();
    await expect(qr).toBeVisible();
    const box = await qr.boundingBox();
    expect(box!.width).toBeGreaterThan(150);
    expect(Math.abs(box!.width - box!.height)).toBeLessThan(1);
    await expect(app.getByText(/Niech znajomy zeskanuje/)).toBeVisible();
    await shot(app, '357-client-app-salon-qr');
    await app.getByRole('button', { name: 'Ukryj kod QR' }).click();
    await expect(qr).toHaveCount(0);
  } finally {
    clientApp.server.close();
    await phone.close();
  }
});
