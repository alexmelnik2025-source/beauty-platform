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
 * Task 92: "Zespół" in the business app (web preview of apps/mobile-business). The owner gives
 * a specialist access from the phone — email + phone, the specialist signs in with a code and
 * is in the team at once; invites a manager and cancels it; removes the specialist again.
 * Screenshots 92–92c.
 */

const PASSWORD = 'e2e-password-123';
const run = Date.now().toString(36);
const OWNER = `team-app-owner-${run}@example.com`;
const KASIA = `team-app-kasia-${run}@example.com`;
const ANIA = `team-app-ania-${run}@example.com`;
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

/** The business app's sign-in: email → code from Mailpit → the day calendar. */
async function signInToApp(app: Page, url: string, email: string) {
  await app.goto(url);
  await app.getByLabel('E-mail lub telefon').fill(email);
  await app.getByRole('button', { name: 'Wyślij kod' }).click();
  const mail = await waitForEmail(email, /Kod logowania do aplikacji salonu/);
  await app.getByLabel('Kod', { exact: true }).fill(/\b(\d{6})\b/.exec(mail.text)![1]!);
  await app.getByRole('button', { name: 'Zaloguj się' }).click();
  await expect(app.getByRole('button', { name: 'Dziś' })).toBeVisible();
}

test('the owner gives access from the business app: invite, cancel, remove (task 92)', async ({
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
  for (const displayName of ['Kasia Nowak', 'Marek Wiśniewski']) {
    await json(
      await request.post(`/v1/organizations/${org.id}/locations/${location.id}/staff`, {
        headers: owner,
        data: { displayName },
      }),
    );
  }

  const businessApp = await serveApp('mobile-business');
  try {
    // ── The owner: "Zespół" → "Zaproś: Kasia Nowak" → email + phone ─────
    const ownerContext = await browser.newContext({
      viewport: PHONE,
      locale: 'pl-PL',
      isMobile: true,
      // Sign-ins from this test's own address too, so other tests keep their login limit.
      extraHTTPHeaders: ADDRESS,
    });
    const app = await ownerContext.newPage();
    await signInToApp(app, businessApp.url, OWNER);
    await app.getByRole('button', { name: 'Zespół' }).click();
    await expect(app.getByRole('heading', { name: 'Zespół', exact: true })).toBeVisible();
    await expect(app.getByText('Bez konta')).toHaveCount(2);
    await expect(app.getByText(`Właściciel · ${OWNER}`)).toBeVisible();
    await app.getByRole('button', { name: 'Zaproś: Kasia Nowak' }).click();
    await expect(app.getByRole('heading', { name: 'Zaproś: Kasia Nowak' })).toBeVisible();
    await app.getByLabel('E-mail', { exact: true }).fill(KASIA);
    await app.getByLabel('Telefon (opcjonalnie)').fill('600 100 200');
    await shot(app, '92-business-app-team-invite');
    await app.getByRole('button', { name: 'Wyślij zaproszenie' }).click();
    await expect(app.getByText(`Zaproszenie wysłane na ${KASIA}.`)).toBeVisible();
    await expect(
      app.getByText(`Zaproszenie wysłane, czeka · ${KASIA} · +48600100200`),
    ).toBeVisible();

    // ── A manager: "+ Zaproś nową osobę" → role "Menedżer" ─────────────────
    await app.getByRole('button', { name: '+ Zaproś nową osobę' }).click();
    await app.getByLabel('E-mail', { exact: true }).fill(ANIA);
    await app.getByRole('button', { name: 'Menedżer' }).click();
    await app.getByRole('button', { name: 'Wyślij zaproszenie' }).click();
    await expect(app.getByText(`Zaproszenie wysłane na ${ANIA}.`)).toBeVisible();
    await expect(app.getByRole('heading', { name: 'Zaproszenia czekają' })).toBeVisible();
    await expect(app.getByText(ANIA, { exact: true })).toBeVisible();
    await shot(app, '92b-business-app-team-invited');
    await app.getByRole('button', { name: `Anuluj zaproszenie: ${ANIA}` }).click();
    await expect(app.getByText('Zaproszenie anulowane.')).toBeVisible();
    await expect(app.getByText(ANIA, { exact: true })).toHaveCount(0);

    // ── Kasia: the invitation email, then the app with a code — no password ──
    const invitation = await waitForEmail(KASIA, /Zaproszenie/);
    expect(invitation.text).toContain('lub numerem +48600100200');
    const kasiaContext = await browser.newContext({
      viewport: PHONE,
      locale: 'pl-PL',
      isMobile: true,
      // Sign-ins from this test's own address too, so other tests keep their login limit.
      extraHTTPHeaders: ADDRESS,
    });
    const kasia = await kasiaContext.newPage();
    await signInToApp(kasia, businessApp.url, KASIA);
    // A specialist does not manage the team.
    await expect(kasia.getByRole('button', { name: 'Zespół' })).toHaveCount(0);
    await kasiaContext.close();

    // ── The owner sees her access and removes her again ───────────────────
    await app.getByRole('button', { name: '‹ Wróć' }).click();
    await app.getByRole('button', { name: 'Zespół' }).click();
    await expect(app.getByText(`Ma dostęp · ${KASIA}`)).toBeVisible();
    await app.getByRole('button', { name: 'Usuń z zespołu: Kasia Nowak' }).click();
    await expect(app.getByText(/Usunąć: Kasia Nowak\?/)).toBeVisible();
    await shot(app, '92c-business-app-team-remove');
    await app.getByRole('button', { name: 'Tak, usuń' }).click();
    await expect(app.getByText('Usunięto z zespołu.')).toBeVisible();
    await expect(app.getByText(`Ma dostęp · ${KASIA}`)).toHaveCount(0);
    await ownerContext.close();
  } finally {
    businessApp.server.close();
  }
});
