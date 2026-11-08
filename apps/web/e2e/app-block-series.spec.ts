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
 * Task 342: a weekly block in the business app (web preview of apps/mobile-business). The owner
 * blocks tomorrow 12:00–13:00 for the whole salon, every week for 3 weeks, sees "Co tydzień" at
 * the block and removes the whole series again. Screenshots 342, 342a.
 */

const PASSWORD = 'e2e-password-123';
const run = Date.now().toString(36);
const OWNER = `app-block-series-owner-${run}@example.com`;
const PHONE = { width: 390, height: 844 };
// An address of its own for sign-up and sign-in (reserved for tests, RFC 2544).
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

/** The salon's date (Warsaw) n days from now, YYYY-MM-DD. */
const warsawDate = (days: number) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Warsaw' }).format(
    new Date(Date.now() + days * 86_400_000),
  );

type Block = { date: string; time: string; seriesId: string | null; deleted: boolean };

test('business app: the owner blocks time every week and removes the whole series', async ({
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
  const blocksUrl = `/v1/organizations/${org.id}/locations/${location.id}/time-blocks?from=${warsawDate(
    1,
  )}&to=${warsawDate(30)}`;
  const live = async () =>
    (await json<Block[]>(await request.get(blocksUrl, { headers: owner }))).filter(
      (b) => !b.deleted,
    );

  const businessApp = await serveApp('mobile-business');
  try {
    const context = await browser.newContext({
      viewport: PHONE,
      locale: 'pl-PL',
      timezoneId: 'Europe/Warsaw',
      isMobile: true,
      extraHTTPHeaders: ADDRESS,
    });
    const phone = await context.newPage();
    await phone.goto(businessApp.url);
    await phone.getByLabel('E-mail lub telefon').fill(OWNER);
    await phone.getByRole('button', { name: 'Wyślij kod' }).click();
    const code = await waitForEmail(OWNER, /Kod logowania do aplikacji salonu/);
    await phone.getByLabel('Kod', { exact: true }).fill(/\b(\d{6})\b/.exec(code.text)![1]!);
    await phone.getByRole('button', { name: 'Zaloguj się' }).click();
    await expect(phone.getByRole('button', { name: 'Dziś' })).toBeVisible();

    // Tomorrow, so a new block starts at 12:00.
    await phone.getByRole('button', { name: 'Następny dzień' }).click();
    await phone.getByRole('button', { name: '+ Zablokuj czas' }).click();
    await expect(phone.getByRole('heading', { name: 'Zablokuj czas' })).toBeVisible();
    await expect(phone.getByLabel('Od 12:00')).toBeVisible();
    await phone.getByRole('button', { name: 'Powtarzaj co tydzień' }).click();
    await expect(phone.getByText('tygodnie: 8')).toBeVisible();
    for (let i = 0; i < 5; i++) {
      await phone.getByRole('button', { name: 'Tydzień mniej' }).click();
    }
    await expect(phone.getByText('tygodnie: 3')).toBeVisible();
    await phone.getByLabel('Powód (np. przerwa)').fill('Szkolenie');
    await shot(phone, '342-business-app-weekly-block');
    await phone.getByRole('button', { name: 'Zablokuj', exact: true }).click();
    await expect(phone.getByText('Zablokowano 3 razy, co tydzień.')).toBeVisible();
    await expect(phone.getByText('12:00–13:00 · Cały salon')).toBeVisible();
    await expect(phone.getByText('Co tydzień', { exact: true })).toBeVisible();

    const made = await live();
    expect(made.map((b) => [b.date, b.time])).toEqual([
      [warsawDate(1), '12:00'],
      [warsawDate(8), '12:00'],
      [warsawDate(15), '12:00'],
    ]);
    expect(new Set(made.map((b) => b.seriesId)).size).toBe(1);
    expect(made[0]!.seriesId).not.toBeNull();

    // ── The whole series goes, after a question ────────────────────────
    await phone.getByRole('button', { name: 'Usuń całą serię 12:00–13:00' }).click();
    await expect(
      phone.getByText('Odblokować ten czas we wszystkich tygodniach serii?'),
    ).toBeVisible();
    await shot(phone, '342a-business-app-weekly-block-remove');
    await phone.getByRole('button', { name: 'Tak, usuń serię' }).click();
    await expect(phone.getByText('Seria odblokowana.')).toBeVisible();
    await expect(phone.getByText('12:00–13:00 · Cały salon')).toHaveCount(0);
    await context.close();
  } finally {
    businessApp.server.close();
  }

  expect(await live()).toEqual([]);
});
