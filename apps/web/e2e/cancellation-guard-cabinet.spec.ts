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
 * Task 161c: "Ochrona przed odwołaniami" in the cabinet. Jan missed two visits (entered by the
 * salon via the API); the owner turns the protection on with "2 no-shows → pay first", sees Jan
 * with the cost of the missed visits and lifts the block; the client card keeps the history
 * (part 2) and so does the business app (part 3). Screenshots 161e–161h; 665 — a number out of
 * range is said under its field.
 */

const PASSWORD = 'e2e-password-123';
const run = Date.now().toString(36);
const OWNER = `guard-cabinet-owner-${run}@example.com`;
const FIVE_MINUTES = 5 * 60_000;

const shot = (page: Page, name: string) =>
  page.screenshot({ path: `e2e/screenshots/${name}.png`, fullPage: true });

async function json<T>(res: APIResponse): Promise<T> {
  expect(res.ok(), `${res.url()} → ${res.status()} ${await res.text()}`).toBeTruthy();
  return (res.status() === 204 ? undefined : await res.json()) as T;
}

async function salonWithMissedVisits(api: APIRequestContext): Promise<void> {
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
    await api.post('/v1/organizations', { headers: owner, data: { name: 'Guard Barber' } }),
  );
  const location = await json<{ id: string }>(
    await api.post(`/v1/organizations/${org.id}/locations`, {
      headers: owner,
      data: {
        name: 'Guard Barber',
        addressLine: 'ul. Józefa Bema 91',
        city: 'Warszawa',
        postalCode: '01-233',
      },
    }),
  );
  const base = `/v1/organizations/${org.id}/locations/${location.id}`;
  const service = await json<{ id: string }>(
    await api.post(`${base}/services`, {
      headers: owner,
      data: { name: 'Strzyżenie męskie', durationMinutes: 30, priceGrosze: 9000, bufferMinutes: 0 },
    }),
  );
  const staff = await json<{ id: string }>(
    await api.post(`${base}/staff`, {
      headers: owner,
      data: { displayName: 'Kasia', serviceIds: [service.id] },
    }),
  );
  // Two visits earlier today that Jan did not come to.
  let customerId: string | undefined;
  for (const hoursAgo of [2, 1]) {
    const start = new Date(
      Math.floor((Date.now() - hoursAgo * 3_600_000) / FIVE_MINUTES) * FIVE_MINUTES,
    );
    const visit = await json<{ id: string; version: number; customer: { id: string } }>(
      await api.post(`${base}/appointments`, {
        headers: owner,
        data: {
          serviceId: service.id,
          staffId: staff.id,
          start: start.toISOString(),
          allowOutsideHours: true,
          alreadyHappened: true,
          ...(customerId
            ? { customerId }
            : {
                customer: {
                  name: 'Jan Nowak',
                  phone: '+48600700800',
                  email: `jan-${run}@example.com`,
                },
              }),
        },
      }),
    );
    customerId = visit.customer.id;
    await json(
      await api.post(`${base}/appointments/${visit.id}/status`, {
        headers: owner,
        data: { version: visit.version, status: 'no_show' },
      }),
    );
  }
}

test('the owner turns on cancellation protection and lifts a client’s block', async ({
  browser,
  request,
}) => {
  await salonWithMissedVisits(request);
  // Its own address: the API limits sign-ins per address and the suite signs in many times.
  const desk = await browser.newContext({
    locale: 'pl-PL',
    timezoneId: 'Europe/Warsaw',
    extraHTTPHeaders: freshAddress(),
  });
  const owner = await desk.newPage();
  await owner.goto('/pl/login');
  await owner.getByLabel('E-mail').fill(OWNER);
  await owner.getByLabel('Hasło').fill(PASSWORD);
  await owner.getByRole('button', { name: 'Zaloguj się' }).click();
  await owner.waitForURL(/\/pl\/app\/calendar/);
  await owner.getByRole('link', { name: 'Ochrona przed odwołaniami' }).first().click();
  await expect(owner.getByRole('heading', { name: 'Ochrona przed odwołaniami' })).toBeVisible();
  await expect(owner.getByText('Ochrona jest wyłączona — nikt nie jest oznaczony.')).toBeVisible();

  await owner.getByLabel('Włącz ochronę').check();
  await owner.getByRole('button', { name: 'Zapisz' }).click();
  await expect(owner.getByText('Zaznacz co najmniej jedną zasadę.')).toBeVisible();

  // Task 665: errors at the field — ticking a rule takes "tick a rule" away, and a number out
  // of range is said under its own field (red frame, "!"), not in a line above the form.
  await owner.getByLabel('Nieobecności („Nie przyszedł”)').check();
  await expect(owner.getByText('Zaznacz co najmniej jedną zasadę.')).toHaveCount(0);
  const noShows = owner.getByLabel('Ile razy');
  await noShows.fill('25');
  await owner.getByRole('button', { name: 'Zapisz' }).click();
  await expect(owner.getByText('Wpisz liczbę od 1 do 20.')).toBeVisible();
  await expect(noShows).toHaveAttribute('aria-invalid', 'true');
  await shot(owner, '665-guard-number-error');
  await noShows.fill('2');
  await expect(owner.getByText('Wpisz liczbę od 1 do 20.')).toHaveCount(0);
  await owner.getByLabel('Najpierw zapłata za nieodbyte wizyty w salonie').check();
  // Task 828 (owner's rule: errors where the action is): a refused save is said under "Zapisz",
  // not in a box at the top of the page; what was typed stays, and any edit takes it away.
  const guardUrl = (url: URL) => url.pathname.endsWith('/cancellation-guard');
  await owner.route(guardUrl, (route) =>
    route.request().method() === 'PUT'
      ? route.fulfill({
          status: 429,
          json: { error: { code: 'RATE_LIMITED', message: 'slow down' } },
        })
      : route.fallback(),
  );
  await owner.getByRole('button', { name: 'Zapisz' }).click();
  await expect(owner.locator('#guard-save-error')).toHaveText('Zbyt wiele prób. Odczekaj chwilę.');
  await expect(owner.getByRole('button', { name: 'Zapisz' })).toHaveAccessibleDescription(
    'Zbyt wiele prób. Odczekaj chwilę.',
  );
  await expect(owner.locator('.page .alert')).toHaveCount(0);
  await expect(noShows).toHaveValue('2');
  await owner.getByRole('button', { name: 'Zapisz' }).scrollIntoViewIfNeeded();
  await shot(owner, '828-guard-save-error');
  await owner.unroute(guardUrl);
  await owner.getByRole('button', { name: 'Zapisz' }).click();
  await expect(owner.getByText('Zapisano ochronę przed odwołaniami.')).toBeVisible();
  await expect(owner.getByText('Jan Nowak')).toBeVisible();
  await expect(owner.getByText('nieobecności: 2')).toBeVisible();
  await expect(owner.getByText(/Nieodbyte wizyty: 180,00/)).toBeVisible();
  await shot(owner, '161e-owner-cancellation-guard');

  await owner.getByRole('button', { name: 'Zdejmij blokadę: Jan Nowak' }).click();
  const sheet = owner.getByRole('dialog');
  await sheet.getByLabel(/Notatka/).fill('Zapłacił 180 zł');
  await shot(owner, '161f-owner-guard-release');
  // Task 794 (owner's rule: errors where the action is): a refused release is said in the sheet,
  // under "Tak, zdejmij" — the page behind it is not seen; the note stays.
  const releaseUrl = (url: URL) => url.pathname.endsWith('/release');
  await owner.route(releaseUrl, (route) =>
    route.fulfill({ status: 429, json: { error: { code: 'RATE_LIMITED', message: 'slow down' } } }),
  );
  const releaseYes = sheet.getByRole('button', { name: 'Tak, zdejmij' });
  await releaseYes.click();
  await expect(sheet.locator('#guard-release-error')).toHaveText(
    'Zbyt wiele prób. Odczekaj chwilę.',
  );
  await expect(releaseYes).toHaveAccessibleDescription(/Zbyt wiele prób\. Odczekaj chwilę\.$/);
  await expect(sheet.getByLabel(/Notatka/)).toHaveValue('Zapłacił 180 zł');
  await expect(owner.locator('.alert', { hasText: 'Zbyt wiele prób' })).toHaveCount(0);
  await shot(owner, '794-guard-release-error');
  await owner.unroute(releaseUrl);
  await releaseYes.click();
  await expect(owner.getByText('Zdjęto blokadę.')).toBeVisible();
  await expect(owner.getByText('Nikt nie jest teraz oznaczony.')).toBeVisible();

  // Part 2: the same in the client card — not marked any more, the history kept with the note.
  await owner.goto('/pl/app/clients');
  await owner.getByRole('button', { name: /Jan Nowak/ }).click();
  const card = owner.getByRole('region', { name: 'Ochrona przed odwołaniami' });
  await card.scrollIntoViewIfNeeded();
  await expect(card).toContainText('Klient nie jest teraz oznaczony.');
  await expect(card.getByText('Nie przyszedł(a)')).toHaveCount(2);
  await expect(card).toContainText('Zdjęto blokadę · Zapłacił 180 zł');
  await shot(owner, '161g-owner-client-card-guard');
  await desk.close();

  // Part 3: the client card of the business app (web preview of apps/mobile-business).
  const businessApp = await serveApp('mobile-business');
  const pocket = await browser.newContext({
    viewport: { width: 390, height: 844 },
    locale: 'pl-PL',
    isMobile: true,
    extraHTTPHeaders: freshAddress(),
  });
  try {
    const app = await pocket.newPage();
    await app.goto(businessApp.url);
    await app.getByLabel('E-mail lub telefon').fill(OWNER);
    await app.getByRole('button', { name: 'Wyślij kod' }).click();
    const mail = await waitForEmail(OWNER, /Kod logowania do aplikacji salonu/);
    await app.getByLabel('Kod', { exact: true }).fill(/\b(\d{6})\b/.exec(mail.text)![1]!);
    await app.getByRole('button', { name: 'Zaloguj się' }).click();
    await app.getByRole('tab', { name: 'Klienci', exact: true }).click();
    await app.getByRole('button', { name: 'Karta klienta: Jan Nowak', exact: true }).click();
    await expect(app.getByRole('heading', { name: 'Jan Nowak' })).toBeVisible();
    await expect(app.getByText('Ochrona przed odwołaniami')).toBeVisible();
    await expect(app.getByText('Klient nie jest teraz oznaczony.')).toBeVisible();
    await expect(app.getByText(/Zdjęto blokadę · Zapłacił 180 zł/)).toBeVisible();
    await shot(app, '161h-business-app-client-guard');
  } finally {
    businessApp.server.close();
    await pocket.close();
  }
});
