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
 * Task 368: "Klienci widzą teraz" above today's calendar in the cabinet. Kasia works around the
 * clock: clients see "Otwarte · do północy". Not on other days. A vacation for today, and after a
 * reload the owner sees what clients see — closed until tomorrow, "nieczynne" today. Screenshots
 * 368, 368a. At the end online booking is switched off again, so the salon does not show up in
 * the catalogue of the specs that follow.
 */

const PASSWORD = 'e2e-password-123';
const run = Date.now().toString(36);
const OWNER = `cabinet-clients-now-${run}@example.com`;
const NAME = `Klienci Teraz ${run}`;
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

test('the cabinet shows the salon as clients see it now', async ({ browser, request }) => {
  const owner = await verifiedUser(request, OWNER, 'Aleksander Owner');
  const org = await json<{ id: string }>(
    await request.post('/v1/organizations', { headers: owner, data: { name: NAME } }),
  );
  const location = await json<{ id: string; slug: string }>(
    await request.post(`/v1/organizations/${org.id}/locations`, {
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
  try {
    const service = await json<{ id: string }>(
      await request.post(`${base}/services`, {
        headers: owner,
        data: { name: 'Strzyżenie męskie', durationMinutes: 45, priceGrosze: 9000 },
      }),
    );
    const kasia = await json<{ id: string }>(
      await request.post(`${base}/staff`, {
        headers: owner,
        data: { displayName: 'Kasia', serviceIds: [service.id] },
      }),
    );
    await json(
      await request.put(`${base}/staff/${kasia.id}/working-hours`, {
        headers: owner,
        data: {
          days: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
            weekday,
            intervals: [{ start: '00:00', end: '24:00' }],
          })),
        },
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

    const line = page.getByTestId('clients-now');
    await expect(line).toHaveAccessibleName('Klienci widzą teraz: Otwarte · do północy');
    await expect(line).toContainText('dziś dla klientów: 00:00–24:00');
    await shot(page, '368-cabinet-clients-now');

    // Not on other days: it is about now.
    await page.getByRole('button', { name: 'Następny dzień' }).click();
    await expect(line).toHaveCount(0);
    await page.getByRole('button', { name: 'Dziś', exact: true }).first().click();
    await expect(line).toBeVisible();

    // A vacation for the whole of today: after a reload, closed until tomorrow.
    const salon = await json<{ todayHours: { date: string } }>(
      await request.get(`/v1/public/locations/${location.slug}`),
    );
    const today = salon.todayHours.date;
    const [y, m, d] = today.split('-').map(Number) as [number, number, number];
    const tomorrow = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
    await json(
      await request.post(`${base}/staff/${kasia.id}/time-off`, {
        headers: owner,
        data: { start: `${today}T00:00`, end: `${tomorrow}T00:00`, note: 'Urlop' },
      }),
    );
    await page.reload();
    await expect(line).toHaveAccessibleName(
      'Klienci widzą teraz: Zamknięte · otwarcie: jutro, 00:00',
    );
    await expect(line).toContainText('dziś dla klientów: nieczynne');
    await shot(page, '368a-cabinet-clients-now-closed');
    await context.close();
  } finally {
    // booking.spec.ts expects its salon to be the only one in the catalogue: online booking off.
    const current = await json<{ version: number }>(await request.get(base, { headers: owner }));
    await json(
      await request.patch(base, {
        headers: owner,
        data: { version: current.version, onlineBookingEnabled: false },
      }),
    );
  }
});
