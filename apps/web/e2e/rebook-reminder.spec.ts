import { createHmac } from 'node:crypto';
import { expect, test, type APIResponse, type Page } from '@playwright/test';
import { freshAddress } from './addresses';
import { waitForEmail } from './mailpit';

/**
 * Task 165c: "time for your next visit". The owner switches it on in "Ustawienia" with the
 * number of days and the salon's own words (screenshot 165c); the client who agreed to the
 * salon's messages opens the "unsubscribe" link of such an email and stops them with one
 * click (screenshot 165c-a). The reminder itself (who gets it and when) is tested in the API.
 */

const PASSWORD = 'e2e-password-123';
const run = Date.now().toString(36);
const OWNER = `rebook-owner-${run}@example.com`;
const CLIENT = `rebook-client-${run}@example.com`;
const SALON = `Pora Barber ${run}`;
const DESKTOP = { width: 1280, height: 900 };
const PHONE = { width: 390, height: 844 };
/** The CI value (.github/workflows/ci.yml); the link is signed with it like the API does. */
const SECRET = process.env.JWT_ACCESS_SECRET ?? 'ci-only-secret-not-used-anywhere-else-0123456789';

const shot = (page: Page, name: string) => page.screenshot({ path: `e2e/screenshots/${name}.png` });

async function json<T>(res: APIResponse): Promise<T> {
  expect(res.ok(), `${res.url()} → ${res.status()} ${await res.text()}`).toBeTruthy();
  return (res.status() === 204 ? undefined : await res.json()) as T;
}

/** The same signed link as apps/api/src/booking/rebook-reminder.ts makes. */
function unsubscribeToken(customerId: string): string {
  const sig = createHmac('sha256', SECRET)
    .update(`unsubscribe:${customerId}`)
    .digest()
    .subarray(0, 18)
    .toString('base64url');
  return `${customerId}.${sig}`;
}

test('the owner sets up "time for the next visit"; the client unsubscribes in one click', async ({
  browser,
  request,
}) => {
  const ownerIp = freshAddress();
  await json(
    await request.post('/v1/auth/register', {
      headers: ownerIp,
      data: { email: OWNER, password: PASSWORD, name: 'Aleksander Owner' },
    }),
  );
  const mail = await waitForEmail(OWNER, /Potwierdź adres/);
  const verify = /token=([^\s&]+)/.exec(mail.text)?.[1];
  await json(
    await request.post('/v1/auth/verify-email', {
      data: { token: decodeURIComponent(verify!) },
    }),
  );
  const login = await json<{ accessToken: string }>(
    await request.post('/v1/auth/login', {
      headers: ownerIp,
      data: { email: OWNER, password: PASSWORD, clientType: 'mobile' },
    }),
  );
  const owner = { Authorization: `Bearer ${login.accessToken}` };
  const org = await json<{ id: string }>(
    await request.post('/v1/organizations', { headers: owner, data: { name: SALON } }),
  );
  const location = await json<{ id: string; slug: string }>(
    await request.post(`/v1/organizations/${org.id}/locations`, {
      headers: owner,
      data: {
        name: SALON,
        addressLine: 'ul. Józefa Bema 91',
        city: 'Warszawa',
        postalCode: '01-233',
        onlineBookingEnabled: true,
        bookingTerms: '# Regulamin\n\nWizyta jest bezpłatna do odwołania.',
        privacyPolicy: '# Prywatność\n\nAdministratorem danych jest salon.',
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
  const staff = await json<{ id: string }>(
    await request.post(`${base}/staff`, {
      headers: owner,
      data: { displayName: 'Kasia', serviceIds: [service.id] },
    }),
  );
  await json(
    await request.put(`${base}/staff/${staff.id}/working-hours`, {
      headers: owner,
      data: {
        days: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
          weekday,
          intervals: [{ start: '08:00', end: '21:00' }],
        })),
      },
    }),
  );

  // ── The owner switches it on in "Ustawienia" ─────────────────────────
  const desk = await browser.newContext({
    viewport: DESKTOP,
    locale: 'pl-PL',
    extraHTTPHeaders: ownerIp,
  });
  const cabinet = await desk.newPage();
  await cabinet.goto('/pl/login');
  await cabinet.getByLabel('E-mail').fill(OWNER);
  await cabinet.getByLabel('Hasło').fill(PASSWORD);
  await cabinet.getByRole('button', { name: 'Zaloguj się' }).click();
  await cabinet.waitForURL(/\/pl\/app\//);
  await cabinet.goto('/pl/app/settings');
  const section = cabinet.getByRole('region', { name: 'Pora na kolejną wizytę' });
  await section.getByRole('checkbox', { name: /Pora na kolejną wizytę\?/ }).check();
  await expect(section.getByLabel('Ile dni po ostatniej wizycie')).toHaveValue('28');
  await section.getByLabel('Ile dni po ostatniej wizycie').fill('35');
  await section
    .getByLabel('Własny tekst (nieobowiązkowo)')
    .fill('Dawno Cię nie było — wpadnij na odświeżenie fade!');
  await section.scrollIntoViewIfNeeded();
  await shot(cabinet, '165c-owner-rebook-settings');
  await cabinet.getByRole('button', { name: 'Zapisz', exact: true }).click();
  await expect(cabinet.getByText('Zapisano').first()).toBeVisible();
  const saved = await json<{ rebookReminderDays: number; rebookReminderText: string | null }>(
    await request.get(base, { headers: owner }),
  );
  expect(saved.rebookReminderDays).toBe(35);
  expect(saved.rebookReminderText).toBe('Dawno Cię nie było — wpadnij na odświeżenie fade!');
  await desk.close();

  // ── A client who agreed to the salon's messages ──────────────────────
  const clientIp = freshAddress();
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const free = await json<{ slots: { start: string }[] }>(
    await request.get(`/v1/public/locations/${location.slug}/availability`, {
      headers: clientIp,
      params: { serviceId: service.id, staffId: staff.id, from: tomorrow, to: tomorrow },
    }),
  );
  const hold = await json<{ holdId: string; holdToken: string }>(
    await request.post(`/v1/public/locations/${location.slug}/holds`, {
      headers: clientIp,
      data: { serviceId: service.id, staffId: staff.id, start: free.slots[0]!.start },
    }),
  );
  await json(
    await request.post(`/v1/public/holds/${hold.holdId}/code`, {
      headers: clientIp,
      data: {
        holdToken: hold.holdToken,
        name: 'Piotr Zieliński',
        phone: '+48 600 300 200',
        email: CLIENT,
        locale: 'pl',
        acceptTerms: true,
        marketingConsent: true,
      },
    }),
  );
  const codeMail = await waitForEmail(CLIENT, /Kod potwierdzenia/);
  await json(
    await request.post(`/v1/public/holds/${hold.holdId}/confirm`, {
      headers: clientIp,
      data: { holdToken: hold.holdToken, code: /\b(\d{6})\b/.exec(codeMail.text)![1] },
    }),
  );
  const clients = await json<{ id: string }[]>(
    await request.get(`/v1/organizations/${org.id}/customers`, {
      headers: owner,
      params: { search: CLIENT },
    }),
  );
  const customerId = clients[0]!.id;

  // ── "Wypisz się" from the email ───────────────────────────────────────
  const phone = await browser.newContext({
    viewport: PHONE,
    locale: 'pl-PL',
    extraHTTPHeaders: clientIp,
  });
  const client = await phone.newPage();
  await client.goto(`/pl/u/${encodeURIComponent(unsubscribeToken(customerId))}`);
  await expect(client.getByRole('heading', { name: 'Wiadomości od salonu' })).toBeVisible();
  await client.getByRole('button', { name: 'Wypisz się' }).click();
  await expect(
    client.getByText(`Gotowe — ${SALON} nie będzie już wysyłać Ci takich wiadomości.`),
  ).toBeVisible();
  await shot(client, '165c-a-client-unsubscribed');
  const card = await json<{ marketingConsent: boolean | null }>(
    await request.get(`/v1/organizations/${org.id}/customers/${customerId}`, { headers: owner }),
  );
  expect(card.marketingConsent).toBe(false);

  // A changed link does nothing.
  await client.goto(`/pl/u/${customerId}.nope`);
  await client.getByRole('button', { name: 'Wypisz się' }).click();
  await expect(client.getByRole('alert')).toBeVisible();
  await phone.close();
});
