import {
  expect,
  test,
  type APIRequestContext,
  type APIResponse,
  type Page,
} from '@playwright/test';
import { waitForEmail } from './mailpit';

/**
 * Owner test T8: the owner invites a specialist with an email AND a phone number; the staff
 * card says the invitation waits; the specialist opens the link and joins with a one-time code
 * from the email — no password, no sign-up. Screenshots 54–57.
 */

const PASSWORD = 'e2e-password-123';
const run = Date.now().toString(36);
const OWNER = `invite-owner-${run}@example.com`;
const KASIA = `invite-kasia-${run}@example.com`;
const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1440, height: 900 };

const shot = (page: Page, name: string) => page.screenshot({ path: `e2e/screenshots/${name}.png` });

async function json<T>(res: APIResponse): Promise<T> {
  expect(res.ok(), `${res.url()} → ${res.status()} ${await res.text()}`).toBeTruthy();
  return (res.status() === 204 ? undefined : await res.json()) as T;
}

async function verifiedUser(api: APIRequestContext, email: string, name: string) {
  await json(await api.post('/v1/auth/register', { data: { email, password: PASSWORD, name } }));
  const mail = await waitForEmail(email, /Potwierdź adres/);
  const token = /token=([^\s&]+)/.exec(mail.text)?.[1];
  expect(token, 'verification link').toBeTruthy();
  await json(
    await api.post('/v1/auth/verify-email', { data: { token: decodeURIComponent(token!) } }),
  );
  const login = await json<{ accessToken: string }>(
    await api.post('/v1/auth/login', { data: { email, password: PASSWORD, clientType: 'mobile' } }),
  );
  return { Authorization: `Bearer ${login.accessToken}` };
}

test('the owner invites a specialist by email and phone; they join with a code (T8)', async ({
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
  await json(
    await request.post(`/v1/organizations/${org.id}/locations/${location.id}/staff`, {
      headers: owner,
      data: { displayName: 'Kasia Nowak' },
    }),
  );

  // ── The owner: staff card → "Zaproś" → email + phone ─────────────────
  const ownerContext = await browser.newContext({ viewport: DESKTOP, locale: 'pl-PL' });
  const page = await ownerContext.newPage();
  await page.goto('/pl/login');
  await page.getByLabel('E-mail').fill(OWNER);
  await page.getByLabel('Hasło').fill(PASSWORD);
  await page.getByRole('button', { name: 'Zaloguj się' }).click();
  await page.waitForURL(/\/pl\/app\/calendar/);
  await page.goto('/pl/app/team');
  const kasiaRow = page.getByRole('button', { name: /Kasia Nowak/ });
  await expect(kasiaRow).toContainText('Bez konta');
  await kasiaRow.click();
  await page.getByRole('dialog').getByRole('button', { name: 'Zaproś', exact: true }).click();
  const form = page.getByRole('dialog');
  await expect(form.getByRole('heading', { name: 'Zaproś do zespołu' })).toBeVisible();
  await form.getByLabel('E-mail').fill(KASIA);
  await form.getByLabel('Telefon').fill('+48 600 100 200');
  await shot(page, '54-owner-invite-email-phone');
  await form.getByRole('button', { name: 'Zaproś', exact: true }).click();
  await expect(page.getByText(`Zaproszenie wysłane na ${KASIA}.`, { exact: true })).toBeVisible();
  await expect(page.getByText(`${KASIA} · +48600100200 · Specjalista`)).toBeVisible();

  // The staff card no longer says "no account": the invitation waits.
  await page.getByRole('button', { name: 'Specjaliści' }).click();
  await expect(kasiaRow).toContainText('Zaproszenie wysłane, czeka');
  await kasiaRow.click();
  await expect(page.getByRole('dialog')).toContainText(
    `Zaproszenie wysłane na ${KASIA}. Czeka, aż osoba zaloguje się kodem.`,
  );
  await expect(page.getByRole('dialog')).toContainText('+48600100200');
  await expect(
    page.getByRole('dialog').getByRole('button', { name: 'Wyślij zaproszenie ponownie' }),
  ).toBeVisible();
  await shot(page, '55-owner-staff-invited');

  // ── The email: a code, no password and no sign-up ─────────────────────
  const invitation = await waitForEmail(KASIA, /Zaproszenie/);
  expect(invitation.text).toContain('zaloguj się kodem');
  expect(invitation.text).toContain('lub numerem +48600100200');
  expect(invitation.text).not.toContain('załóż konto');
  const path = /(\/pl\/invite\/\S+)/.exec(invitation.text)![1]!;

  // ── Kasia on her phone: the link → code from the email → in the team ──
  const kasiaContext = await browser.newContext({
    viewport: PHONE,
    locale: 'pl-PL',
    isMobile: true,
  });
  const kasia = await kasiaContext.newPage();
  await kasia.goto(path);
  await expect(kasia.getByRole('heading', { name: 'Zaproszenie do zespołu' })).toBeVisible();
  await expect(kasia.getByText('Nie potrzebujesz hasła ani zakładania konta')).toBeVisible();
  await expect(kasia.getByRole('link', { name: 'Załóż konto' })).toHaveCount(0);
  await kasia.getByRole('button', { name: 'Wyślij kod' }).click();
  await expect(kasia.getByRole('status')).toContainText(`Wysłaliśmy kod na ${KASIA}`);
  const codeMail = await waitForEmail(KASIA, /Kod logowania/);
  const code = /Kod: (\d{6})/.exec(codeMail.text)![1]!;
  await kasia.getByLabel('Kod z e-maila').fill(code);
  await shot(kasia, '56-staff-invite-code');
  await kasia.getByRole('button', { name: 'Dołącz do zespołu' }).click();
  await expect(kasia.getByText('Jesteś w zespole.')).toBeVisible();
  await kasia.getByRole('link', { name: 'Kalendarz' }).click();
  await kasia.waitForURL(/\/pl\/app\/calendar/);
  await shot(kasia, '57-staff-joined-calendar');

  // The owner sees the account linked to the profile.
  await page.reload();
  await expect(page.getByRole('button', { name: /Kasia Nowak/ })).toContainText(KASIA);

  await kasiaContext.close();
  await ownerContext.close();
});
