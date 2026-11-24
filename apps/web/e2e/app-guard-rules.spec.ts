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
 * Task 349: "Zmień zasady" in "Ochrona przed odwołaniami" of the business app (web preview of
 * apps/mobile-business). Switching on without rules points to "Zmień zasady"; the owner sets
 * "3 in 14 days" and "2 no-shows", "Tylko telefonicznie", fixes a wrong number and switches the
 * protection on. Screenshot 349.
 */

const PASSWORD = 'e2e-password-123';
const run = Date.now().toString(36);
const OWNER = `app-guard-rules-owner-${run}@example.com`;
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

test('business app: the owner sets the cancellation protection rules', async ({
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

    await openBusinessMenu(phone, 'Ochrona przed odwołaniami');
    await phone.addStyleTag({ content: '* { -webkit-text-size-adjust: 130% !important; }' });
    await expect(phone.getByText('Żadna zasada nie jest ustawiona.')).toBeVisible();
    await phone.getByRole('button', { name: 'Włącz ochronę' }).click();
    await expect(
      phone.getByText('Najpierw ustaw co najmniej jedną zasadę — „Zmień zasady”.'),
    ).toBeVisible();

    await phone.getByRole('button', { name: 'Zmień zasady', exact: true }).click();
    await phone.getByRole('checkbox', { name: 'Częste odwołania i przeniesienia' }).click();
    const lateRule = phone.getByRole('checkbox', { name: 'Późne odwołanie' });
    await lateRule.click();
    await phone.getByRole('checkbox', { name: 'Nieobecności' }).click();
    const action = phone.getByRole('radio', { name: 'Tylko telefonicznie' });
    await action.click();
    await expect(action).toBeChecked();

    const save = phone.getByRole('button', { name: 'Zapisz zasady' });
    for (const [label, invalid, message, valid] of [
      [
        'Ile odwołań lub przeniesień (1–50)',
        '',
        'Odwołania i przeniesienia: liczba od 1 do 50.',
        '3',
      ],
      ['W ciągu ilu dni (1–365)', '-1', 'Okres: od 1 do 365 dni.', '14'],
      ['Mniej niż ile minut przed wizytą', 'abc', 'Późne odwołanie: od 1 do 10 080 minut.', '120'],
      ['Ile nieobecności (1–20)', '25', 'Nieobecności: liczba od 1 do 20.', '2'],
    ] as const) {
      const field = phone.getByRole('textbox', { name: label, exact: true });
      await field.fill(invalid);
      await save.click();
      await expect(field).toHaveAttribute('aria-invalid', 'true');
      await expect(field).toHaveAccessibleDescription(`! ${message}`);
      await expect(field.locator('..').getByRole('alert')).toHaveText(`! ${message}`);
      await expect(field).toHaveCSS('border-top-color', 'rgb(179, 38, 30)');
      await field.fill(valid);
      await expect(field).toHaveAttribute('aria-invalid', 'false');
      await expect(phone.getByRole('alert')).toHaveCount(0);
    }

    for (const control of await phone
      .locator('input, [role="checkbox"], [role="radio"], [role="button"]')
      .all()) {
      await expect(control).toHaveAccessibleName(/\S/);
      const bounds = await control.boundingBox();
      expect(bounds?.width).toBeGreaterThanOrEqual(44);
      expect(bounds?.height).toBeGreaterThanOrEqual(44);
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(PHONE.width);
    }
    await lateRule.click();
    await shot(phone, '349-business-app-guard-rules');
    await phone.getByRole('button', { name: 'Zapisz zasady' }).click();
    await expect(phone.getByText('Zasady ochrony zapisane.')).toBeVisible();
    await expect(phone.getByText('• Odwołania lub przeniesienia: 3 w ciągu 14 dni')).toBeVisible();
    await expect(phone.getByText('• Nieobecności: 2')).toBeVisible();
    await expect(phone.getByText('Co wtedy: Tylko telefonicznie')).toBeVisible();

    await phone.getByRole('button', { name: 'Włącz ochronę' }).click();
    await expect(phone.getByText('Ochrona jest włączona.')).toBeVisible();
    await context.close();
  } finally {
    businessApp.server.close();
  }

  const saved = await json<Record<string, unknown>>(
    await request.get(`/v1/organizations/${org.id}/locations/${location.id}/cancellation-guard`, {
      headers: owner,
    }),
  );
  expect(saved).toMatchObject({
    enabled: true,
    maxChanges: 3,
    windowHours: 14 * 24,
    lateCancelMinutes: null,
    maxNoShows: 2,
    action: 'phone_only',
  });
});
