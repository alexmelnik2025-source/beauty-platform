import {
  expect,
  test,
  type APIRequestContext,
  type APIResponse,
  type Page,
} from '@playwright/test';
import { waitForEmail } from './mailpit';
import { openBusinessMenu, serveApp } from './mobile-app';

/**
 * Task 341: "Ustawienia opinii" in "Opinie" of the business app (web preview of
 * apps/mobile-business). The owner switches collecting reviews on and chooses when the client is
 * asked (3 hours after the visit); the save button waits for a change. Screenshot 341.
 */

const PASSWORD = 'e2e-password-123';
const run = Date.now().toString(36);
const OWNER = `app-review-settings-owner-${run}@example.com`;
const PHONE = { width: 320, height: 844 };
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

test('business app: the owner configures reviews and answers a long review at 320 px', async ({
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
  const settingsUrl = `/v1/organizations/${org.id}/locations/${location.id}/review-settings`;

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

    const reviewsPath = `/v1/organizations/${org.id}/locations/${location.id}/reviews`;
    let releaseList!: () => void;
    const holdList = new Promise<void>((resolve) => {
      releaseList = resolve;
    });
    await phone.route(
      (url) => url.pathname === reviewsPath,
      async (route) => {
        await holdList;
        await route.continue();
      },
      { times: 1 },
    );
    const loading = phone.getByRole('progressbar', { name: 'Ładowanie…' });
    const empty = phone.getByText('Brak opinii.', { exact: true });
    try {
      await openBusinessMenu(phone, 'Opinie');
      await expect(loading).toBeVisible();
      await expect(empty).toHaveCount(0);
    } finally {
      releaseList();
    }
    await expect(empty).toBeVisible();
    await expect(loading).toHaveCount(0);
    await expect(phone.getByText('Ustawienia opinii')).toBeVisible();
    await expect(phone.getByRole('button', { name: 'Nie zbieraj' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    // The owner sees the switch here, not the "turn it on in the panel" note.
    await expect(phone.getByText(/włącza je w panelu salonu/)).toHaveCount(0);

    await phone.getByRole('button', { name: 'Zbieraj opinie' }).click();
    await phone.getByRole('button', { name: 'Poproś po 3 godz. od końca wizyty' }).click();
    await shot(phone, '341-business-app-review-settings');
    await phone.getByRole('button', { name: 'Zapisz ustawienia' }).click();
    await expect(phone.getByText('Ustawienia opinii zapisane.')).toBeVisible();
    await expect(phone.getByRole('button', { name: 'Zapisz ustawienia' })).toBeDisabled();
    await phone.getByRole('button', { name: '‹ Wróć' }).click();
    const review = {
      id: 'long-review',
      rating: 4,
      text: `Bardzo dobre strzyżenie. ${'Najserdeczniej'.repeat(20)} polecam!`,
      staffName: 'Kasia',
      serviceName: 'Strzyżenie',
      customerName: 'Anna',
      visitStartAt: '2026-11-20T10:00:00Z',
      reply: null,
    };
    await phone.route(
      (url) => url.pathname === reviewsPath,
      (route) =>
        route.fulfill({
          json: {
            enabled: true,
            count: 1,
            average: 4,
            stars: [0, 0, 0, 1, 0],
            unanswered: 1,
            staff: [],
            services: [],
            items: [review],
            nextBefore: null,
          },
        }),
    );
    const replies: string[] = [];
    await phone.route(
      (url) => url.pathname === `${reviewsPath}/${review.id}/reply`,
      (route) => {
        const { text } = route.request().postDataJSON() as { text: string };
        replies.push(text);
        return route.fulfill({ json: { ...review, reply: text } });
      },
    );
    await openBusinessMenu(phone, 'Opinie');
    await phone.getByRole('button', { name: 'Bez odpowiedzi (1)' }).click();
    await phone.addStyleTag({
      content:
        '[dir="auto"], textarea { font-size: 32px !important; line-height: 1.4 !important; }',
    });
    const words = phone.getByText(review.text, { exact: true });
    await expect(words).toBeVisible();
    await expect(words).toHaveCSS('font-size', '32px');
    expect(
      await words.evaluate((el) => {
        const range = document.createRange();
        range.selectNodeContents(el);
        const lines = Array.from(range.getClientRects());
        const bounds = el.getBoundingClientRect();
        return (
          lines.length > 1 &&
          bounds.left >= 0 &&
          bounds.right <= 320 &&
          lines.every(
            (line) =>
              line.left >= bounds.left - 1 &&
              line.right <= bounds.right + 1 &&
              line.bottom <= bounds.bottom + 1,
          )
        );
      }),
    ).toBe(true);
    await expect(phone.getByRole('img', { name: 'Oceny klientów: ★ 4/5' })).toBeVisible();
    await phone.getByRole('button', { name: 'Odpowiedz', exact: true }).click();
    const field = phone.getByRole('textbox', { name: 'Odpowiedź salonu' });
    const publish = phone.getByRole('button', { name: 'Opublikuj odpowiedź' });
    await field.fill('   ');
    await publish.click();
    await expect(field).toHaveAttribute('aria-invalid', 'true');
    await expect(field).toHaveAccessibleDescription('! Odpowiedz');
    await expect(field).toHaveCSS('border-top-color', 'rgb(179, 38, 30)');
    await expect(phone.getByRole('alert')).toHaveText('! Odpowiedz');
    await field.fill('  Dziękujemy za opinię!  ');
    await expect(field).toHaveAttribute('aria-invalid', 'false');
    await expect(phone.getByRole('alert')).toHaveCount(0);
    await publish.click();
    await expect(empty).toBeVisible();
    await expect(phone.getByRole('button', { name: 'Bez odpowiedzi (0)' })).toBeVisible();
    expect(replies).toEqual(['Dziękujemy za opinię!']);
    await context.close();
  } finally {
    businessApp.server.close();
  }

  const saved = await json<{ enabled: boolean; requestHours: number; version: number }>(
    await request.get(settingsUrl, { headers: owner }),
  );
  expect(saved).toMatchObject({ enabled: true, requestHours: 3 });
  expect(saved.version).toBeGreaterThan(0);
});
