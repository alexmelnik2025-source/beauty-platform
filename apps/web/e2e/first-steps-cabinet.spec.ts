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
 * Task 353: "Pierwsze kroki" above the cabinet's calendar. The salon has only a service: four
 * steps are left, "Zrób to" at the specialist leads to "Zespół"; once the specialist, her hours,
 * the texts and online booking are there, the card is gone. Screenshot 353.
 */

const PASSWORD = 'e2e-password-123';
const run = Date.now().toString(36);
const OWNER = `first-steps-owner-${run}@example.com`;
const DESKTOP = { width: 1440, height: 900 };

const shot = (page: Page, name: string) => page.screenshot({ path: `e2e/screenshots/${name}.png` });

async function json<T>(res: APIResponse): Promise<T> {
  expect(res.ok(), `${res.url()} → ${res.status()} ${await res.text()}`).toBeTruthy();
  return (res.status() === 204 ? undefined : await res.json()) as T;
}

async function verifiedUser(api: APIRequestContext, email: string, name: string) {
  await json(
    await api.post('/v1/auth/register', {
      headers: freshAddress(),
      data: { email, password: PASSWORD, name },
    }),
  );
  const mail = await waitForEmail(email, /Potwierdź adres/);
  const token = /token=([^\s&]+)/.exec(mail.text)?.[1];
  expect(token, 'verification link').toBeTruthy();
  await json(
    await api.post('/v1/auth/verify-email', { data: { token: decodeURIComponent(token!) } }),
  );
  const login = await json<{ accessToken: string }>(
    await api.post('/v1/auth/login', {
      headers: freshAddress(),
      data: { email, password: PASSWORD, clientType: 'mobile' },
    }),
  );
  return { Authorization: `Bearer ${login.accessToken}` };
}

test('the cabinet shows what the salon still needs for online booking', async ({
  browser,
  request,
}) => {
  const owner = await verifiedUser(request, OWNER, 'Aleksander Owner');
  const org = await json<{ id: string }>(
    await request.post('/v1/organizations', { headers: owner, data: { name: 'GESTALT' } }),
  );
  const location = await json<{ id: string; version: number }>(
    await request.post(`/v1/organizations/${org.id}/locations`, {
      headers: owner,
      data: {
        // A name of its own: this salon ends up taking online bookings, so it is in the public
        // catalogue (booking.spec.ts expects one "Gestalt Barbershop" there).
        name: 'First Steps Cabinet Barbershop',
        addressLine: 'ul. Józefa Bema 91',
        city: 'Warszawa',
        postalCode: '01-233',
      },
    }),
  );
  const base = `/v1/organizations/${org.id}/locations/${location.id}`;
  const service = await json<{ id: string }>(
    await request.post(`${base}/services`, {
      headers: owner,
      data: { name: 'Strzyżenie męskie', durationMinutes: 45, priceGrosze: 9000 },
    }),
  );

  const context = await browser.newContext({
    viewport: DESKTOP,
    locale: 'pl-PL',
    timezoneId: 'Europe/Warsaw',
    extraHTTPHeaders: freshAddress(),
  });
  const page = await context.newPage();
  await page.goto('/pl/login');
  await page.getByLabel('E-mail').fill(OWNER);
  await page.getByLabel('Hasło').fill(PASSWORD);
  await page.getByRole('button', { name: 'Zaloguj się' }).click();
  await page.waitForURL(/\/pl\/app\/calendar/);

  const card = page.getByRole('region', { name: 'Pierwsze kroki' });
  await expect(card).toBeVisible();
  await expect(card.getByText('Do rezerwacji online zostało kroków: 4.')).toBeVisible();
  await expect(card.getByText(/Dodaj usługę z ceną i czasem — zrobione/)).toBeVisible();
  await expect(card.getByRole('link', { name: /^Zrób to:/ })).toHaveCount(4);
  await shot(page, '353-cabinet-first-steps');

  await card.getByRole('link', { name: 'Zrób to: Dodaj specjalistę, który ją wykonuje' }).click();
  await page.waitForURL(/\/pl\/app\/team/);

  // The rest is set (here through the API): Kasia with the service and hours, texts, online.
  const kasia = await json<{ id: string }>(
    await request.post(`${base}/staff`, {
      headers: owner,
      data: { displayName: 'Kasia', serviceIds: [service.id] },
    }),
  );
  await json(
    await request.put(`${base}/staff/${kasia.id}/working-hours`, {
      headers: owner,
      data: { days: [{ weekday: 2, intervals: [{ start: '10:00', end: '18:00' }] }] },
    }),
  );
  const online = await json<{ version: number }>(
    await request.patch(base, {
      headers: owner,
      data: {
        version: location.version,
        onlineBookingEnabled: true,
        bookingTerms: '# Regulamin rezerwacji\n\nRezerwacja jest bezpłatna.',
        privacyPolicy: '# Polityka prywatności\n\nAdministratorem danych jest GESTALT.',
      },
    }),
  );
  await page.goto('/pl/app/calendar');
  await expect(page.getByRole('button', { name: 'Dziś' }).first()).toBeVisible();
  await page.waitForLoadState('networkidle');
  await expect(page.getByRole('region', { name: 'Pierwsze kroki' })).toHaveCount(0);
  await context.close();
  // Off again: other tests count the salons of the public catalogue.
  await json(
    await request.patch(base, {
      headers: owner,
      data: { version: online.version, onlineBookingEnabled: false },
    }),
  );
});
