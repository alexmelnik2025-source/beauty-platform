import {
  expect,
  test,
  type APIRequestContext,
  type APIResponse,
  type Page,
} from '@playwright/test';
import { waitForEmail } from './mailpit';
import { serveApp } from './mobile-app';

/**
 * Task 70b: the price list as the client sees it (as on Booksy). Under "Strzyżenie męskie" one
 * line per price and length: "Kasia — 75 zł · 45min", "Marek, Tomek — 90 zł · 45min" and
 * "Ola — 90 zł · 1g" (Ola's own length); "Broda" costs the same with everyone — one line
 * "Wszyscy specjaliści". "Umów" on the two-specialist line opens the times of both
 * ("Dowolny" in the circles over the calendar), and the visit goes to one of them, never to
 * Kasia; a circle there or under the service gives one specialist's times. "Mówi po" keeps the
 * lines of the specialists who speak the language. Screenshots 83–83c; the same in the client
 * app (task 70c), screenshots 83d–83e. The catalogue card's "Usługi od 60,00 zł" (task 91),
 * screenshots 91–91a.
 */

const PASSWORD = 'e2e-password-123';
const run = Date.now().toString(36);
const PHONE = { width: 390, height: 844 };
const salonName = (who: string) => `Wiersz Barber ${who} ${run}`;

const shot = (page: Page, name: string) => page.screenshot({ path: `e2e/screenshots/${name}.png` });

async function json<T>(res: APIResponse): Promise<T> {
  expect(res.ok(), `${res.url()} → ${res.status()} ${await res.text()}`).toBeTruthy();
  return (res.status() === 204 ? undefined : await res.json()) as T;
}

async function salonWithPriceRows(api: APIRequestContext, who: string): Promise<string> {
  const OWNER = `rows-${who}-${run}@example.com`;
  const NAME = salonName(who);
  await json(
    await api.post('/v1/auth/register', {
      // An address of its own: sign-ups are limited to 10 an hour per address.
      headers: { 'x-forwarded-for': who === 'app' ? '203.0.113.184' : '203.0.113.183' },
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
        addressLine: 'ul. Wolska 12',
        // First in the app's catalogue, which lists salons by city.
        city: 'Aleksandrów Łódzki',
        postalCode: '95-070',
        onlineBookingEnabled: true,
        bookingTerms: '# Regulamin\n\nWizyta jest bezpłatna do odwołania.',
        privacyPolicy: `# Prywatność\n\nAdministratorem danych jest ${NAME}.`,
      },
    }),
  );
  const base = `/v1/organizations/${org.id}/locations/${location.id}`;
  const haircut = await json<{ id: string }>(
    await api.post(`${base}/services`, {
      headers: owner,
      data: { name: 'Strzyżenie męskie', durationMinutes: 45, priceGrosze: 9000 },
    }),
  );
  const beard = await json<{ id: string }>(
    await api.post(`${base}/services`, {
      headers: owner,
      data: { name: 'Broda', durationMinutes: 30, priceGrosze: 6000 },
    }),
  );
  const ids: Record<string, string> = {};
  for (const [name, languages] of [
    ['Kasia', ['pl']],
    ['Marek', ['pl']],
    ['Tomek', ['pl']],
    ['Ola', ['pl', 'en']],
  ] as const) {
    const staff = await json<{ id: string }>(
      await api.post(`${base}/staff`, {
        headers: owner,
        data: { displayName: name, languages, serviceIds: [haircut.id, beard.id] },
      }),
    );
    ids[name] = staff.id;
    await json(
      await api.put(`${base}/staff/${staff.id}/working-hours`, {
        headers: owner,
        data: {
          days: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
            weekday,
            intervals: [{ start: '08:00', end: '21:00' }],
          })),
        },
      }),
    );
  }
  await json(
    await api.put(`${base}/services/${haircut.id}/staff-prices`, {
      headers: owner,
      data: { prices: [{ staffId: ids.Kasia, priceGrosze: 7500 }] },
    }),
  );
  await json(
    await api.put(`${base}/services/${haircut.id}/staff-durations`, {
      headers: owner,
      data: { durations: [{ staffId: ids.Ola, durationMinutes: 60 }] },
    }),
  );
  return location.slug;
}

test('the price list shows a line per price and books the specialists of that line', async ({
  browser,
  request,
}) => {
  const slug = await salonWithPriceRows(request, 'web');
  const phone = await browser.newContext({
    viewport: PHONE,
    isMobile: true,
    locale: 'pl-PL',
    timezoneId: 'Europe/Warsaw',
    extraHTTPHeaders: { 'x-forwarded-for': '203.0.113.83' },
  });
  const client = await phone.newPage();
  await client.goto(`/pl/b/${slug}`);

  const haircut = client.locator('.service-card', { hasText: 'Strzyżenie męskie' });
  const rows = haircut.locator('.price-rows li');
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText('Kasia');
  await expect(rows.nth(0)).toContainText(/75,00\s*zł · 45min/);
  await expect(rows.nth(1)).toContainText('Marek, Tomek');
  await expect(rows.nth(1)).toContainText(/90,00\s*zł · 45min/);
  await expect(rows.nth(2)).toContainText('Ola');
  await expect(rows.nth(2)).toContainText(/90,00\s*zł · 1g/);
  // The specialists' circles under the service.
  await expect(haircut.locator('.service-team .avatar')).toHaveCount(4);
  // The same price with everyone: one line.
  const beard = client.locator('.service-card', { hasText: 'Broda' });
  await expect(beard.locator('.price-rows li')).toHaveCount(1);
  await expect(beard.locator('.price-rows li')).toContainText('Wszyscy specjaliści');
  await expect(beard.locator('.price-rows li')).toContainText(/60,00\s*zł · 30min/);
  await shot(client, '83-booking-price-rows');

  // "Mówi po: angielski" leaves only Ola's line.
  await client.getByRole('button', { name: 'Mówi po: angielski' }).click();
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('Ola');
  await expect(rows.first()).toContainText('EN');
  await shot(client, '83a-booking-price-rows-language');
  await client.getByRole('button', { name: 'Wszyscy', exact: true }).click();
  await expect(rows).toHaveCount(3);

  // "Umów" on "Marek, Tomek": both in the circles, "Dowolny" picked; the visit goes to one of them.
  await client.getByRole('button', { name: 'Umów: Marek, Tomek' }).click();
  const circles = client.locator('.row-staff button');
  await expect(circles).toHaveCount(3);
  await expect(circles.nth(0)).toHaveText(/Dowolny/);
  await expect(circles.nth(0)).toHaveAttribute('aria-pressed', 'true');
  await expect(circles.nth(1)).toHaveText(/Marek/);
  await expect(circles.nth(2)).toHaveText(/Tomek/);
  await shot(client, '83b-booking-row-specialists');
  await client.locator('.day-strip button').nth(1).click();
  await client.locator('.times button').first().click();
  await expect(client.locator('.summary')).toContainText(/Marek|Tomek/);
  await expect(client.locator('.summary')).not.toContainText('Kasia');
  await expect(client.locator('.summary')).toContainText('90,00');

  // Only Tomek: his circle over the calendar.
  await client.goto(`/pl/b/${slug}`);
  await client.getByRole('button', { name: 'Umów: Marek, Tomek' }).click();
  await client.locator('.row-staff button', { hasText: 'Tomek' }).click();
  await expect(client.locator('.row-staff button', { hasText: 'Tomek' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await client.locator('.day-strip button').nth(1).click();
  await client.locator('.times button').first().click();
  await expect(client.locator('.summary')).toContainText('Tomek');

  // Kasia's circle under the service: straight to her times, her price.
  await client.goto(`/pl/b/${slug}`);
  await haircut.getByRole('button', { name: 'Kasia — wolne terminy' }).click();
  await expect(client.locator('.row-staff')).toHaveCount(0);
  await client.locator('.day-strip button').nth(1).click();
  await shot(client, '83c-booking-one-specialist-times');
  await client.locator('.times button').first().click();
  await expect(client.locator('.summary')).toContainText('Kasia');
  await expect(client.locator('.summary')).toContainText('75,00');

  // Task 91: the catalogue card says what the salon costs at least (Broda, 60 zł).
  await client.goto('/pl/salons');
  const card = client.getByRole('article', { name: salonName('web') });
  await expect(card).toContainText(/Usługi od 60,00\s*zł/);
  await card.scrollIntoViewIfNeeded();
  await shot(client, '91-catalogue-price-from');
  await phone.close();
});

test('the client app shows the price lines and books the specialists of a line', async ({
  browser,
  request,
}) => {
  await salonWithPriceRows(request, 'app');
  const clientApp = await serveApp('mobile-client');
  const phone = await browser.newContext({
    viewport: PHONE,
    isMobile: true,
    locale: 'pl-PL',
    timezoneId: 'Europe/Warsaw',
    extraHTTPHeaders: { 'x-forwarded-for': '203.0.113.84' },
  });
  try {
    const app = await phone.newPage();
    await app.goto(clientApp.url);
    // The app opens on "My visits" sign-in; the catalogue needs no account.
    await app.getByRole('button', { name: 'Znajdź salon' }).click();
    await expect(app.getByRole('heading', { name: 'Znajdź salon' })).toBeVisible();
    await app.getByLabel('Szukaj: nazwa, miasto, ulica').fill(salonName('app'));
    // Task 91: the card says what the salon costs at least (Broda, 60 zł).
    await expect(app.getByRole('article', { name: salonName('app') })).toContainText(
      /Usługi od 60,00\s*zł/,
    );
    await shot(app, '91a-client-app-catalogue-price-from');
    await app
      .getByRole('article', { name: salonName('app') })
      .getByRole('button', { name: 'Zobacz salon' })
      .click();
    // The salon page: who does it for how much.
    await expect(app.getByText('Marek, Tomek', { exact: true })).toBeVisible();
    await app.getByRole('button', { name: 'Umów wizytę' }).click();
    await expect(app.getByRole('heading', { name: 'Wybierz usługę' })).toBeVisible();
    await expect(app.getByRole('button', { name: /^Umów: Kasia, 75,00/ })).toBeVisible();
    await expect(
      app.getByRole('button', { name: /^Umów: Wszyscy specjaliści, 60,00/ }),
    ).toBeVisible();
    await shot(app, '83d-client-app-price-rows');
    // "Marek, Tomek": both over the times, "Dowolny" first; the visit goes to one of them.
    await app.getByRole('button', { name: /^Umów: Marek, Tomek,/ }).click();
    await expect(app.getByRole('heading', { name: 'Wybierz termin' })).toBeVisible();
    await expect(app.getByRole('button', { name: 'Dowolny', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await app.getByRole('button', { name: 'Tomek', exact: true }).click();
    await expect(app.getByRole('button', { name: 'Tomek', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await app.getByRole('button', { name: 'Dowolny', exact: true }).click();
    await shot(app, '83e-client-app-row-specialists');
    const time = app.getByRole('button', { name: /^\d{2}:\d{2}$/ }).first();
    await expect(time).toBeVisible();
    await time.click();
    await expect(app.getByRole('heading', { name: 'Twoje dane' })).toBeVisible();
    await expect(app.getByText(/Strzyżenie męskie · (Marek|Tomek) ·/)).toBeVisible();
  } finally {
    await phone.close();
    clientApp.server.close();
  }
});
