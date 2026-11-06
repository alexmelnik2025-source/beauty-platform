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
 * Task 208: "Wiadomości do klientów" in the business app (web preview of apps/mobile-business).
 * The owner moves the reminder to 2 hours before, holds a freed time 15 minutes for the first
 * person on the waiting list and switches "Pora na kolejną wizytę" on after 30 days with the
 * salon's own words. Screenshots 208–208a.
 */

const PASSWORD = 'e2e-password-123';
const run = Date.now().toString(36);
const OWNER = `messages-app-owner-${run}@example.com`;
const PHONE = { width: 390, height: 844 };
// An address of its own for sign-up and sign-in (reserved for tests, RFC 2544): the API allows 10 sign-ups an hour from one.
const n = Math.floor(Math.random() * 65_536);
const ADDRESS = { 'x-forwarded-for': `198.19.${n >> 8}.${n & 255}` };

const shot = (page: Page, name: string) => page.screenshot({ path: `e2e/screenshots/${name}.png` });

async function json<T>(res: APIResponse): Promise<T> {
  expect(res.ok(), `${res.url()} → ${res.status()} ${await res.text()}`).toBeTruthy();
  return (res.status() === 204 ? undefined : await res.json()) as T;
}

async function verifiedUser(api: APIRequestContext, email: string, name: string) {
  await json(
    await api.post('/v1/auth/register', {
      headers: ADDRESS,
      data: { email, password: PASSWORD, name },
    }),
  );
  const mail = await waitForEmail(email, /Potwierdź adres/);
  const token = /token=([^\s&]+)/.exec(mail.text)?.[1];
  expect(token, 'verification link').toBeTruthy();
  await json(
    await api.post('/v1/auth/verify-email', {
      headers: ADDRESS,
      data: { token: decodeURIComponent(token!) },
    }),
  );
  const login = await json<{ accessToken: string }>(
    await api.post('/v1/auth/login', {
      headers: ADDRESS,
      data: { email, password: PASSWORD, clientType: 'mobile' },
    }),
  );
  return { Authorization: `Bearer ${login.accessToken}` };
}

test('the owner sets the messages to clients in the business app (task 208)', async ({
  browser,
  request,
}) => {
  const owner = await verifiedUser(request, OWNER, 'Aleksander Owner');
  const org = await json<{ id: string }>(
    await request.post('/v1/organizations', { headers: owner, data: { name: 'GESTALT' } }),
  );
  const location = await json<{ id: string }>(
    await request.post(`/v1/organizations/${org.id}/locations`, {
      headers: owner,
      data: {
        name: 'Gestalt Barbershop',
        addressLine: 'ul. Józefa Bema 91',
        city: 'Warszawa',
        postalCode: '01-233',
      },
    }),
  );
  const base = `/v1/organizations/${org.id}/locations/${location.id}`;

  const businessApp = await serveApp('mobile-business');
  try {
    const context = await browser.newContext({
      viewport: PHONE,
      locale: 'pl-PL',
      isMobile: true,
      // Sign-ins from this test's own address too, so other tests keep their login limit.
      extraHTTPHeaders: ADDRESS,
    });
    const app = await context.newPage();
    await app.goto(businessApp.url);
    await app.getByLabel('E-mail lub telefon').fill(OWNER);
    await app.getByRole('button', { name: 'Wyślij kod' }).click();
    const mail = await waitForEmail(OWNER, /Kod logowania do aplikacji salonu/);
    await app.getByLabel('Kod', { exact: true }).fill(/\b(\d{6})\b/.exec(mail.text)![1]!);
    await app.getByRole('button', { name: 'Zaloguj się' }).click();
    await expect(app.getByRole('button', { name: 'Dziś' })).toBeVisible();

    await app.getByRole('button', { name: 'Wiadomości do klientów' }).click();
    await expect(app.getByRole('heading', { name: 'Wiadomości do klientów' })).toBeVisible();
    // The salon's defaults: a reminder 24 hours before, nothing held, no "next visit" email.
    await expect(app.getByRole('button', { name: '24 godz. przed', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await app.getByRole('button', { name: 'Zapisz' }).click();
    await expect(app.getByText('Nic się nie zmieniło.')).toBeVisible();

    await app.getByRole('button', { name: '2 godz. przed', exact: true }).click();
    await app.getByRole('button', { name: '15 min', exact: true }).click();
    await app.getByLabel('Wysyłaj klientom przypomnienie „Pora na kolejną wizytę?”').click();
    await app.getByRole('button', { name: 'Zapisz' }).click();
    await expect(app.getByText('Wpisz liczbę dni od 7 do 365.')).toBeVisible();
    await app.getByLabel('Ile dni po ostatniej wizycie (7–365)').fill('30');
    await app.getByLabel('Własny tekst (nieobowiązkowo)').fill('Dawno Cię nie było — wpadnij!');
    await shot(app, '208-business-app-messages');
    await app.getByRole('button', { name: 'Zapisz' }).click();
    await expect(app.getByText('Zapisano.')).toBeVisible();

    const saved = await json<{
      reminderHoursBefore: number;
      waitlistHoldMinutes: number;
      rebookReminderDays: number;
      rebookReminderText: string | null;
    }>(await request.get(base, { headers: owner }));
    expect(saved).toMatchObject({
      reminderHoursBefore: 2,
      waitlistHoldMinutes: 15,
      rebookReminderDays: 30,
      rebookReminderText: 'Dawno Cię nie było — wpadnij!',
    });

    // ── Opened again: the saved choices; "next visit" switched off keeps nothing to send ──
    await app.getByRole('button', { name: '‹ Wróć' }).click();
    await app.getByRole('button', { name: 'Wiadomości do klientów' }).click();
    await expect(app.getByLabel('Ile dni po ostatniej wizycie (7–365)')).toHaveValue('30');
    await shot(app, '208a-business-app-messages-saved');
    await app.getByLabel('Wysyłaj klientom przypomnienie „Pora na kolejną wizytę?”').click();
    await app.getByRole('button', { name: 'Zapisz' }).click();
    await expect(app.getByText('Zapisano.')).toBeVisible();
    const off = await json<{ rebookReminderDays: number }>(
      await request.get(base, { headers: owner }),
    );
    expect(off.rebookReminderDays).toBe(0);
    await context.close();
  } finally {
    businessApp.server.close();
  }
});
