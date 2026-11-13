import {
  expect,
  test,
  type APIRequestContext,
  type APIResponse,
  type Page,
} from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { freshAddress } from './addresses';
import { waitForEmail } from './mailpit';
import { serveApp } from './mobile-app';

/**
 * Task 378: "Najlepiej oceniane" in the catalogue. Two salons of one owner: "Gwiazdy … Alfa"
 * without reviews and "Gwiazdy … Beta" with two five-star reviews. In the usual order Alfa is
 * first; with the chip on, Beta (★ 5) goes first — on the site (screenshot 378) and in the
 * client app (378a). The file name sorts after booking.spec.ts and price-rows.spec.ts, which count
 * every salon in the catalogue (the specs run one after another, by name).
 * Task 379: "★ Najlepiej oceniane" on the home page (379) and on the client app's start screen
 * (379a) opens the catalogue with the chip on.
 */

const PASSWORD = 'e2e-password-123';
const run = Date.now().toString(36);
const PHONE = { width: 390, height: 844 };
const PREFIX = `Gwiazdy ${run}`;
const OWNER = `best-rated-${run}@example.com`;

const shot = (page: Page, name: string) => page.screenshot({ path: `e2e/screenshots/${name}.png` });

async function json<T>(res: APIResponse): Promise<T> {
  expect(res.ok(), `${res.url()} → ${res.status()} ${await res.text()}`).toBeTruthy();
  return (res.status() === 204 ? undefined : await res.json()) as T;
}

/** A finished visit with the client's review, written straight into the database. */
function reviewedVisit(locationId: string, phone: string, rating: number) {
  const url = (process.env.DATABASE_URL ?? '').replace(/\?.*$/, '');
  execFileSync('psql', [
    url,
    '-v',
    'ON_ERROR_STOP=1',
    '-c',
    `WITH s AS (
       SELECT l.id AS location_id, l.organization_id, st.id AS staff_id, sv.id AS service_id
       FROM location l JOIN staff_member st ON st.location_id = l.id JOIN service sv ON sv.location_id = l.id
       WHERE l.id = '${locationId}' LIMIT 1),
     c AS (
       INSERT INTO customer (id, organization_id, name, phone, updated_at)
       SELECT gen_random_uuid(), organization_id, 'Gość', '${phone}', now() FROM s RETURNING id),
     a AS (
       INSERT INTO appointment (id, location_id, staff_id, service_id, customer_id, status, source,
         start_at, end_at, blocked_until, price_grosze, duration_minutes, buffer_minutes, updated_at)
       SELECT gen_random_uuid(), s.location_id, s.staff_id, s.service_id, c.id, 'completed', 'online',
         now() - interval '2 days', now() - interval '2 days' + interval '30 minutes',
         now() - interval '2 days' + interval '30 minutes', 5000, 30, 0, now()
       FROM s, c RETURNING id, location_id, staff_id)
     INSERT INTO visit_review (id, appointment_id, location_id, staff_id, rating, updated_at)
     SELECT gen_random_uuid(), id, location_id, staff_id, ${rating}, now() FROM a`,
  ]);
}

async function signIn(api: APIRequestContext): Promise<Record<string, string>> {
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
  return { Authorization: `Bearer ${login.accessToken}` };
}

/** A bookable salon; returns its location id. */
async function salon(
  api: APIRequestContext,
  owner: Record<string, string>,
  name: string,
): Promise<{ id: string; base: string }> {
  const org = await json<{ id: string }>(
    await api.post('/v1/organizations', { headers: owner, data: { name } }),
  );
  const location = await json<{ id: string }>(
    await api.post(`/v1/organizations/${org.id}/locations`, {
      headers: owner,
      data: {
        name,
        addressLine: 'ul. Gwiaździsta 7',
        city: 'Aleksandrów Kujawski',
        postalCode: '87-700',
        onlineBookingEnabled: true,
        bookingTerms: '# Regulamin\n\nWizyta jest bezpłatna do odwołania.',
        privacyPolicy: `# Prywatność\n\nAdministratorem danych jest ${name}.`,
      },
    }),
  );
  const base = `/v1/organizations/${org.id}/locations/${location.id}`;
  const service = await json<{ id: string }>(
    await api.post(`${base}/services`, {
      headers: owner,
      data: { name: 'Strzyżenie', durationMinutes: 30, priceGrosze: 5000 },
    }),
  );
  await json(
    await api.post(`${base}/staff`, {
      headers: owner,
      data: { displayName: 'Kasia', serviceIds: [service.id] },
    }),
  );
  return { id: location.id, base };
}

test('"Najlepiej oceniane" puts the best stars first, on the site and in the client app', async ({
  browser,
  request,
}) => {
  const owner = await signIn(request);
  await salon(request, owner, `${PREFIX} Alfa`);
  const beta = await salon(request, owner, `${PREFIX} Beta`);
  await json(
    await request.put(`${beta.base}/review-settings`, {
      headers: owner,
      data: { version: 0, enabled: true, requestHours: 2 },
    }),
  );
  reviewedVisit(beta.id, '+48511300001', 5);
  reviewedVisit(beta.id, '+48511300002', 5);

  const phone = await browser.newContext({
    viewport: PHONE,
    isMobile: true,
    locale: 'pl-PL',
    timezoneId: 'Europe/Warsaw',
  });
  try {
    const client = await phone.newPage();
    await client.goto(`/pl/salons?q=${encodeURIComponent(PREFIX)}`);
    const names = client.locator('.directory-salon h2');
    await expect(names).toHaveText([`${PREFIX} Alfa`, `${PREFIX} Beta`]);
    const chip = client.getByRole('button', { name: '★ Najlepiej oceniane' });
    await expect(chip).toHaveAttribute('aria-pressed', 'false');
    await chip.click();
    await expect(chip).toHaveAttribute('aria-pressed', 'true');
    await expect(names).toHaveText([`${PREFIX} Beta`, `${PREFIX} Alfa`]);
    await shot(client, '378-catalogue-best-rated');
    // The chip can be opened from a link too.
    await client.goto(`/pl/salons?q=${encodeURIComponent(PREFIX)}&sort=rating`);
    await expect(names).toHaveText([`${PREFIX} Beta`, `${PREFIX} Alfa`]);
    // Task 379: from the home page.
    await client.goto('/pl');
    const homeLink = client.getByRole('link', { name: '★ Najlepiej oceniane' });
    await homeLink.scrollIntoViewIfNeeded();
    await shot(client, '379-home-best-rated');
    await homeLink.click();
    await client.waitForURL(/\/pl\/salons\?sort=rating/);
    await expect(client.getByRole('button', { name: '★ Najlepiej oceniane' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    const clientApp = await serveApp('mobile-client');
    try {
      // Task 379: from the start screen, with the chip on.
      const start = await phone.newPage();
      await start.goto(clientApp.url);
      const startButton = start.getByRole('button', { name: '★ Najlepiej oceniane' });
      await expect(startButton).toBeVisible();
      await shot(start, '379a-client-app-start-best-rated');
      await startButton.click();
      await expect(start.getByRole('heading', { name: 'Znajdź salon' })).toBeVisible();
      await expect(start.getByRole('button', { name: '★ Najlepiej oceniane' })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      await start.close();

      const app = await phone.newPage();
      await app.goto(clientApp.url);
      await app.getByRole('button', { name: 'Znajdź salon' }).click();
      await expect(app.getByRole('heading', { name: 'Znajdź salon' })).toBeVisible();
      await app.getByLabel('Czego szukasz? Usługa, salon, miasto lub ulica').fill(PREFIX);
      const cards = app.getByRole('article', { name: new RegExp(`^${PREFIX}`) });
      await expect(cards).toHaveCount(2);
      const appChip = app.getByRole('button', { name: '★ Najlepiej oceniane' });
      await appChip.click();
      await expect(appChip).toHaveAttribute('aria-pressed', 'true');
      await expect(cards.first()).toHaveAttribute('aria-label', `${PREFIX} Beta`);
      await shot(app, '378a-client-app-best-rated');
    } finally {
      clientApp.server.close();
    }
  } finally {
    await phone.close();
  }
});
