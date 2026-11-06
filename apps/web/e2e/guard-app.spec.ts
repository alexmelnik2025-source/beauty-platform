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
 * Task 207: "Ochrona przed odwołaniami" in the business app (web preview of
 * apps/mobile-business). Jan missed two visits; the salon's rule "2 no-shows → pay first" was
 * set in the cabinet (here via the API). The owner switches the protection on from the phone,
 * sees Jan with the cost of the missed visits, lifts the block with a note and switches the
 * protection off again. Screenshots 207–207b.
 */

const PASSWORD = 'e2e-password-123';
const run = Date.now().toString(36);
const OWNER = `guard-app-owner-${run}@example.com`;
const PHONE = { width: 390, height: 844 };
const FIVE_MINUTES = 5 * 60_000;

const shot = (page: Page, name: string) =>
  page.screenshot({ path: `e2e/screenshots/${name}.png`, fullPage: true });

async function json<T>(res: APIResponse): Promise<T> {
  expect(res.ok(), `${res.url()} → ${res.status()} ${await res.text()}`).toBeTruthy();
  return (res.status() === 204 ? undefined : await res.json()) as T;
}

async function salonWithMissedVisits(
  api: APIRequestContext,
): Promise<{ owner: Record<string, string>; base: string }> {
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
  return { owner, base };
}

test('the owner runs cancellation protection from the business app (task 207)', async ({
  browser,
  request,
}) => {
  const { owner, base } = await salonWithMissedVisits(request);
  await json(
    await request.put(`${base}/cancellation-guard`, {
      headers: owner,
      data: {
        version: 0,
        enabled: false,
        maxChanges: null,
        windowHours: 720,
        lateCancelMinutes: null,
        maxNoShows: 2,
        action: 'prepay',
      },
    }),
  );

  const businessApp = await serveApp('mobile-business');
  try {
    const context = await browser.newContext({
      viewport: PHONE,
      locale: 'pl-PL',
      isMobile: true,
      // Its own address: the API limits sign-ins per address and the suite signs in many times.
      extraHTTPHeaders: freshAddress(),
    });
    const app = await context.newPage();
    await app.goto(businessApp.url);
    await app.getByLabel('E-mail lub telefon').fill(OWNER);
    await app.getByRole('button', { name: 'Wyślij kod' }).click();
    const mail = await waitForEmail(OWNER, /Kod logowania do aplikacji salonu/);
    await app.getByLabel('Kod', { exact: true }).fill(/\b(\d{6})\b/.exec(mail.text)![1]!);
    await app.getByRole('button', { name: 'Zaloguj się' }).click();
    await expect(app.getByRole('button', { name: 'Dziś' })).toBeVisible();

    await app.getByRole('button', { name: 'Ochrona przed odwołaniami' }).click();
    await expect(app.getByRole('heading', { name: 'Ochrona przed odwołaniami' })).toBeVisible();
    await expect(app.getByText('Ochrona wyłączona', { exact: true })).toBeVisible();
    await expect(app.getByText('• Nieobecności: 2')).toBeVisible();
    await expect(
      app.getByText('Co wtedy: Najpierw zapłata za nieodbyte wizyty w salonie'),
    ).toBeVisible();
    await expect(app.getByText('Ochrona jest wyłączona — nikt nie jest oznaczony.')).toBeVisible();

    // ── Switched on: Jan is marked, with what the missed visits cost ───
    await app.getByRole('button', { name: 'Włącz ochronę' }).click();
    await expect(app.getByText('Ochrona jest włączona.')).toBeVisible();
    await expect(app.getByText('Ochrona włączona', { exact: true })).toBeVisible();
    await expect(app.getByText('Jan Nowak')).toBeVisible();
    await expect(app.getByText(/^nieobecności: 2 · Nieodbyte wizyty: 180,00\s?zł$/)).toBeVisible();
    await shot(app, '207-business-app-guard');
    const on = await json<{ enabled: boolean; maxNoShows: number | null; action: string }>(
      await request.get(`${base}/cancellation-guard`, { headers: owner }),
    );
    expect(on).toMatchObject({ enabled: true, maxNoShows: 2, action: 'prepay' });

    // ── Jan paid in the salon: the block is lifted with a note ─────────
    await app.getByRole('button', { name: 'Zdejmij blokadę: Jan Nowak' }).click();
    await expect(app.getByText(/Zdjąć blokadę\?/)).toBeVisible();
    await app.getByLabel('Notatka (np. „zapłacił 150 zł”)').fill('Zapłacił 180 zł');
    await shot(app, '207a-business-app-guard-release');
    await app.getByRole('button', { name: 'Tak, zdejmij' }).click();
    await expect(app.getByText('Zdjęto blokadę.')).toBeVisible();
    await expect(app.getByText('Nikt nie jest teraz oznaczony.')).toBeVisible();
    const marked = await json<{ items: unknown[] }>(
      await request.get(`${base}/cancellation-guard/clients`, { headers: owner }),
    );
    expect(marked.items).toEqual([]);

    // ── Switched off again, after a question ───────────────────────────
    await app.getByRole('button', { name: 'Wyłącz ochronę' }).click();
    await expect(app.getByText(/Wyłączyć ochronę\?/)).toBeVisible();
    await shot(app, '207b-business-app-guard-off');
    await app.getByRole('button', { name: 'Tak, wyłącz' }).click();
    await expect(app.getByText('Ochrona jest wyłączona.')).toBeVisible();
    const off = await json<{ enabled: boolean }>(
      await request.get(`${base}/cancellation-guard`, { headers: owner }),
    );
    expect(off.enabled).toBe(false);
    await context.close();
  } finally {
    businessApp.server.close();
  }
});
