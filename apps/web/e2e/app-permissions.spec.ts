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
 * Tasks 330–331: "Uprawnienia" in the business app (web preview of apps/mobile-business),
 * opened from "Zespół". The owner makes the category "Starszy barber" (sees client contacts),
 * gives it to Kasia with one personal exception (sees prices and her results), then deletes
 * the category — Kasia falls back to the default rights. Screenshots 330, 331, 331a.
 */

const PASSWORD = 'e2e-password-123';
const run = Date.now().toString(36);
const OWNER = `app-rights-owner-${run}@example.com`;
const KASIA = `app-rights-kasia-${run}@example.com`;
const PHONE = { width: 390, height: 844 };
// An address of this test only (sign-ups and codes are limited per address).
const OWNER_IP = { 'x-forwarded-for': '198.51.100.99' };

const shot = (page: Page, name: string) => page.screenshot({ path: `e2e/screenshots/${name}.png` });

async function json<T>(res: APIResponse): Promise<T> {
  expect(res.ok(), `${res.url()} → ${res.status()} ${await res.text()}`).toBeTruthy();
  return (res.status() === 204 ? undefined : await res.json()) as T;
}

async function verifiedUser(api: APIRequestContext, email: string, name: string) {
  await json(
    await api.post('/v1/auth/register', {
      headers: OWNER_IP,
      data: { email, password: PASSWORD, name },
    }),
  );
  const mail = await waitForEmail(email, /Potwierdź adres/);
  const token = /token=([^\s&]+)/.exec(mail.text)?.[1];
  expect(token, 'verification link').toBeTruthy();
  await json(
    await api.post('/v1/auth/verify-email', {
      headers: OWNER_IP,
      data: { token: decodeURIComponent(token!) },
    }),
  );
  const login = await json<{ accessToken: string }>(
    await api.post('/v1/auth/login', {
      headers: OWNER_IP,
      data: { email, password: PASSWORD, clientType: 'mobile' },
    }),
  );
  return { Authorization: `Bearer ${login.accessToken}` };
}

type Member = {
  user: { email: string };
  staffCategoryId: string | null;
  overrides: Record<string, boolean>;
  permissions: Record<string, boolean>;
};

test('business app: the owner sets what a specialist may do', async ({ browser, request }) => {
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
  const profile = await json<{ id: string }>(
    await request.post(`${base}/staff`, { headers: owner, data: { displayName: 'Kasia' } }),
  );
  await json(
    await request.post(`/v1/organizations/${org.id}/invitations`, {
      headers: owner,
      data: { email: KASIA, role: 'staff', locationIds: [location.id], staffMemberId: profile.id },
    }),
  );
  const invitation = await waitForEmail(KASIA, /Zaproszenie/);
  const inviteToken = /\/invite\/(\S+)/.exec(invitation.text)![1]!;
  const kasia = await verifiedUser(request, KASIA, 'Kasia Nowak');
  await json(await request.post(`/v1/invitations/${inviteToken}/accept`, { headers: kasia }));

  const membersNow = async () =>
    (
      await json<Member[]>(
        await request.get(`/v1/organizations/${org.id}/members`, { headers: owner }),
      )
    ).find((m) => m.user.email === KASIA)!;

  const businessApp = await serveApp('mobile-business');
  try {
    const context = await browser.newContext({
      viewport: PHONE,
      locale: 'pl-PL',
      timezoneId: 'Europe/Warsaw',
      isMobile: true,
      extraHTTPHeaders: OWNER_IP,
    });
    const phone = await context.newPage();
    await phone.goto(businessApp.url);
    await phone.getByLabel('E-mail lub telefon').fill(OWNER);
    await phone.getByRole('button', { name: 'Wyślij kod' }).click();
    const code = await waitForEmail(OWNER, /Kod logowania do aplikacji salonu/);
    await phone.getByLabel('Kod', { exact: true }).fill(/\b(\d{6})\b/.exec(code.text)![1]!);
    await phone.getByRole('button', { name: 'Zaloguj się' }).click();
    await expect(phone.getByRole('button', { name: 'Dziś' })).toBeVisible();

    await phone.getByRole('button', { name: 'Zespół' }).click();
    await expect(phone.getByRole('heading', { name: 'Zespół', exact: true })).toBeVisible();
    await phone.getByRole('button', { name: 'Uprawnienia', exact: true }).click();
    await expect(phone.getByRole('heading', { name: 'Uprawnienia', exact: true })).toBeVisible();
    await expect(phone.getByText('Kasia Nowak')).toBeVisible();

    // ── 331: a category ────────────────────────────────────────────────────
    await phone.getByRole('button', { name: '+ Nowa kategoria' }).click();
    await phone.getByLabel('Nazwa (np. Starszy barber)').fill('Starszy barber');
    await phone.getByRole('checkbox', { name: 'Widzi telefon i e-mail klienta' }).click();
    await expect(phone.getByRole('checkbox', { name: 'Dodaje swoje wizyty' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await shot(phone, '331-business-app-rights-category');
    await phone.getByRole('button', { name: 'Zapisz', exact: true }).click();
    await expect(phone.getByText('Kategoria zapisana.')).toBeVisible();
    await expect(phone.getByText('osób: 0')).toBeVisible();

    // ── 330: Kasia gets the category and one exception ─────────────────────
    await phone.getByRole('button', { name: 'Zmień: Kasia Nowak' }).click();
    await phone.getByRole('button', { name: 'Starszy barber', exact: true }).click();
    await phone.getByRole('radio', { name: 'Widzi ceny i swoje wyniki: Tak' }).click();
    await shot(phone, '330-business-app-rights-person');
    await phone.getByRole('button', { name: 'Zapisz', exact: true }).click();
    await expect(phone.getByText('Uprawnienia zapisane.', { exact: false })).toBeVisible();
    await expect(phone.getByText('osób: 1')).toBeVisible();
    await expect(
      phone.getByText('Wyjątki dla tej osoby: Widzi ceny i swoje wyniki — Tak'),
    ).toBeVisible();

    const withCategory = await membersNow();
    expect(withCategory.staffCategoryId).toBeTruthy();
    expect(withCategory.overrides).toEqual({ viewOwnEarnings: true });
    expect(withCategory.permissions).toMatchObject({
      viewClientContacts: true,
      viewOwnEarnings: true,
      viewClientNotes: false,
    });

    // ── 331: the category is deleted — Kasia has the defaults again ────────
    await phone.getByRole('button', { name: 'Usuń kategorię: Starszy barber' }).click();
    await phone.getByRole('button', { name: 'Tak, usuń' }).click();
    await expect(phone.getByText('Kategoria usunięta.')).toBeVisible();
    await expect(phone.getByText('Uprawnienia domyślne')).toBeVisible();
    await shot(phone, '331a-business-app-rights-deleted');
    await context.close();
  } finally {
    businessApp.server.close();
  }

  const after = await membersNow();
  expect(after.staffCategoryId).toBeNull();
  expect(after.permissions).toMatchObject({ viewClientContacts: false, viewOwnEarnings: true });
});
