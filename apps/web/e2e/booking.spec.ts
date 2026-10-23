import {
  expect,
  test,
  type APIRequestContext,
  type APIResponse,
  type Page,
} from '@playwright/test';
import { clearMailbox, waitForEmail } from './mailpit';

/**
 * The main scenario end to end, through the real web app, API, database and email:
 * a client books on a phone and confirms with the emailed code → the appointment is
 * in the salon's calendar and in the staff member's own calendar → the emails went out.
 * Screenshots of every step go to e2e/screenshots (CI uploads them).
 */

const PASSWORD = 'e2e-password-123';
const run = Date.now().toString(36);
const OWNER = `owner-${run}@example.com`;
const KASIA = `kasia-${run}@example.com`;
const CLIENT = `anna-${run}@example.com`;
const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1440, height: 900 };

const shot = (page: Page, name: string) => page.screenshot({ path: `e2e/screenshots/${name}.png` });

async function json<T>(res: APIResponse): Promise<T> {
  expect(res.ok(), `${res.url()} → ${res.status()} ${await res.text()}`).toBeTruthy();
  return (res.status() === 204 ? undefined : await res.json()) as T;
}

/** Registers, confirms the email from Mailpit and signs in (mobile client: token in body). */
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

async function signIn(page: Page, email: string) {
  await page.goto('/pl/login');
  await page.getByLabel('E-mail').fill(email);
  await page.getByLabel('Hasło').fill(PASSWORD);
  await page.getByRole('button', { name: 'Zaloguj się' }).click();
  await page.waitForURL(/\/pl\/app\/calendar/);
}

const day = (offset: number) =>
  new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

test('a client books online; the visit is in the salon and staff calendars; emails go out', async ({
  browser,
  request,
}) => {
  await clearMailbox();

  // ── The salon, set up through the API ──────────────────────────────────
  const owner = await verifiedUser(request, OWNER, 'Aleksander Owner');
  const org = await json<{ id: string }>(
    await request.post('/v1/organizations', { headers: owner, data: { name: 'GESTALT' } }),
  );
  const location = await json<{ id: string; slug: string; version: number }>(
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
  await json(
    await request.patch(base, {
      headers: owner,
      data: { version: location.version, onlineBookingEnabled: true, minLeadMinutes: 30 },
    }),
  );
  const category = await json<{ id: string }>(
    await request.post(`${base}/service-categories`, { headers: owner, data: { name: 'Włosy' } }),
  );
  const services: { id: string }[] = [];
  for (const [name, durationMinutes, priceGrosze, color] of [
    ['Strzyżenie męskie', 45, 9000, '#1F3A93'],
    ['Strzyżenie + broda', 75, 14000, '#7A2E8E'],
    ['Broda', 30, 6000, '#2E7D32'],
  ] as const) {
    services.push(
      await json(
        await request.post(`${base}/services`, {
          headers: owner,
          data: {
            name,
            durationMinutes,
            priceGrosze,
            bufferMinutes: 0,
            categoryId: category.id,
            color,
          },
        }),
      ),
    );
  }
  const staffIds: string[] = [];
  for (const displayName of ['Kasia', 'Ola', 'Alex']) {
    const staff = await json<{ id: string }>(
      await request.post(`${base}/staff`, {
        headers: owner,
        data: { displayName, serviceIds: services.map((s) => s.id) },
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
    staffIds.push(staff.id);
  }

  // Kasia gets her own account by invitation.
  await json(
    await request.post(`/v1/organizations/${org.id}/invitations`, {
      headers: owner,
      data: { email: KASIA, role: 'staff', locationIds: [location.id], staffMemberId: staffIds[0] },
    }),
  );
  const invitation = await waitForEmail(KASIA, /Zaproszenie/);
  const inviteToken = /\/invite\/(\S+)/.exec(invitation.text)![1]!;
  const kasia = await verifiedUser(request, KASIA, 'Kasia Nowak');
  await json(await request.post(`/v1/invitations/${inviteToken}/accept`, { headers: kasia }));

  // ── The client books on a phone ────────────────────────────────────────
  const phone = await browser.newContext({ viewport: PHONE, locale: 'pl-PL', isMobile: true });
  const client = await phone.newPage();
  await client.goto(`/pl/b/${location.slug}`);
  await expect(client.getByRole('heading', { name: 'Gestalt Barbershop' })).toBeVisible();
  await shot(client, '01-client-services');

  await client.getByRole('button', { name: /Strzyżenie męskie/ }).click();
  await shot(client, '02-client-staff');
  await client.getByRole('button', { name: /Kasia/ }).click();
  await expect(client.locator('.times button').first()).toBeVisible();
  await shot(client, '03-client-times');
  await client.locator('.times button').first().click();

  await expect(client.getByText(/Termin czeka na Ciebie/)).toBeVisible();
  await client.getByLabel('Imię i nazwisko').fill('Anna Kowalska');
  await client.getByLabel('Telefon').fill('600 100 200');
  await client.getByLabel('E-mail').fill(CLIENT);
  await client.getByLabel(/Akceptuję zasady/).check();
  await shot(client, '04-client-details');
  await client.getByRole('button', { name: 'Wyślij kod' }).click();

  const codeMail = await waitForEmail(CLIENT, /Kod potwierdzenia/);
  const code = /\b(\d{6})\b/.exec(codeMail.text)![1]!;
  await client.getByLabel('Kod z e-maila').fill(code);
  await shot(client, '05-client-code');
  await client.getByRole('button', { name: 'Potwierdź wizytę' }).click();
  await expect(client.getByRole('heading', { name: 'Do zobaczenia!' })).toBeVisible();
  await shot(client, '06-client-done');

  // ── Emails ─────────────────────────────────────────────────────────────
  const confirmation = await waitForEmail(CLIENT, /Wizyta potwierdzona/);
  expect(confirmation.text).toContain('Strzyżenie męskie');
  expect(confirmation.text).toContain('Kasia');
  await waitForEmail(OWNER, /Nowa rezerwacja online/);
  await waitForEmail(KASIA, /Nowa rezerwacja online/);

  // The "manage" link from the email works.
  const manageLink = /(\/pl\/m\/\S+)/.exec(confirmation.text)![1]!;
  await client.goto(manageLink);
  await expect(client.getByText('Potwierdzona')).toBeVisible();
  await shot(client, '07-client-manage');

  // The booked day, as the salon's API sees it.
  const calendar = await json<{
    appointments: { date: string; time: string; customer: { name: string } | null }[];
  }>(
    await request.get(`${base}/calendar`, {
      headers: owner,
      params: { from: day(-1), to: day(21) },
    }),
  );
  const visit = calendar.appointments.find((a) => a.customer?.name === 'Anna Kowalska');
  expect(visit, 'appointment in the salon calendar').toBeTruthy();

  // ── The owner's calendar on a computer ────────────────────────────────
  const desk = await browser.newContext({ viewport: DESKTOP, locale: 'pl-PL' });
  const ownerPage = await desk.newPage();
  await signIn(ownerPage, OWNER);
  await ownerPage.goto(`/pl/app/calendar?date=${visit!.date}`);
  const booked = ownerPage.getByRole('button', { name: /Anna Kowalska/ });
  await expect(booked).toBeVisible();
  await shot(ownerPage, '08-owner-calendar');
  await booked.click();
  await expect(ownerPage.getByRole('dialog')).toContainText('+48600100200');
  await shot(ownerPage, '09-owner-appointment');
  await ownerPage.keyboard.press('Escape');

  // The owner books a walk-in for Ola through the form.
  await ownerPage
    .getByRole('button', { name: /Nowa wizyta/ })
    .first()
    .click();
  const dialog = ownerPage.getByRole('dialog');
  await dialog.getByLabel('Usługa').selectOption(services[2]!.id);
  await dialog.getByLabel('Specjalista').selectOption(staffIds[1]!);
  await dialog.getByLabel('Data').fill(visit!.date);
  await dialog.getByLabel('Godzina').fill('20:00');
  await dialog.getByLabel('Imię i nazwisko').fill('Jan Kowalski');
  await dialog.getByLabel('Telefon').fill('+48 600 200 300');
  await shot(ownerPage, '10-owner-new-appointment');
  await dialog.getByRole('button', { name: 'Zapisz wizytę' }).click();
  await expect(ownerPage.getByRole('button', { name: /Jan Kowalski/ })).toBeVisible();
  await shot(ownerPage, '11-owner-calendar-after');

  // The other sections of the cabinet.
  await ownerPage.goto('/pl/app/services');
  await expect(ownerPage.getByText('Strzyżenie + broda').first()).toBeVisible();
  await shot(ownerPage, '15-owner-services');
  await ownerPage.goto('/pl/app/team');
  await expect(ownerPage.getByRole('button', { name: /Kasia/ })).toBeVisible();
  await shot(ownerPage, '16-owner-team');
  await ownerPage.getByRole('button', { name: /Ola/ }).click();
  await expect(ownerPage.getByRole('dialog')).toContainText('Godziny pracy');
  await shot(ownerPage, '17-owner-staff-hours');
  await ownerPage.keyboard.press('Escape');
  await ownerPage.getByRole('button', { name: 'Dostęp i uprawnienia' }).click();
  await expect(ownerPage.getByText('Kasia Nowak')).toBeVisible();
  await ownerPage.getByRole('button', { name: /Kasia Nowak/ }).click();
  await expect(ownerPage.getByRole('dialog')).toContainText('Widzi telefon i e-mail klienta');
  await shot(ownerPage, '18-owner-permissions');
  await ownerPage.keyboard.press('Escape');
  await ownerPage.goto('/pl/app/clients');
  await ownerPage.getByRole('button', { name: /Anna Kowalska/ }).click();
  await expect(ownerPage.getByRole('dialog')).toContainText('Strzyżenie męskie');
  await shot(ownerPage, '19-owner-client');
  await ownerPage.keyboard.press('Escape');
  await ownerPage.goto('/pl/app/notifications');
  await expect(ownerPage.getByText('Nowa rezerwacja online').first()).toBeVisible();
  await shot(ownerPage, '20-owner-notifications');
  await ownerPage.goto('/pl/app/settings');
  await expect(ownerPage.getByLabel('Link dla klientów')).toHaveValue(
    new RegExp(`/pl/b/${location.slug}$`),
  );
  await shot(ownerPage, '21-owner-settings');

  // The owner's calendar on a phone.
  const ownerPhone = await browser.newContext({ viewport: PHONE, locale: 'pl-PL', isMobile: true });
  const ownerMobile = await ownerPhone.newPage();
  await signIn(ownerMobile, OWNER);
  await ownerMobile.goto(`/pl/app/calendar?date=${visit!.date}`);
  await expect(ownerMobile.getByRole('button', { name: /Anna Kowalska/ })).toBeVisible();
  await shot(ownerMobile, '12-owner-calendar-phone');

  // ── Kasia's own calendar on her phone: the visit, but not the client's phone ──
  const staffPhone = await browser.newContext({ viewport: PHONE, locale: 'pl-PL', isMobile: true });
  const kasiaPage = await staffPhone.newPage();
  await signIn(kasiaPage, KASIA);
  await kasiaPage.goto(`/pl/app/calendar?date=${visit!.date}`);
  const own = kasiaPage.getByRole('button', { name: /Anna Kowalska/ });
  await expect(own).toBeVisible();
  await expect(kasiaPage.getByRole('button', { name: /Jan Kowalski/ })).toHaveCount(0);
  await shot(kasiaPage, '13-staff-calendar-phone');
  await own.click();
  const staffDialog = kasiaPage.getByRole('dialog');
  await expect(staffDialog).toContainText('Anna Kowalska');
  await expect(staffDialog).toContainText('Kontakt widoczny tylko z uprawnieniem');
  await expect(staffDialog).not.toContainText('600100200');
  await shot(kasiaPage, '14-staff-appointment-phone');
  await kasiaPage.keyboard.press('Escape');

  // Staff: no client list; notifications and their own schedule.
  await expect(kasiaPage.locator('.bottom-nav')).not.toContainText('Klienci');
  await kasiaPage.goto('/pl/app/notifications');
  await expect(kasiaPage.getByText('Nowa rezerwacja online').first()).toBeVisible();
  await shot(kasiaPage, '22-staff-notifications-phone');
  await kasiaPage.goto('/pl/app/schedule');
  await expect(kasiaPage.getByText('08:00–21:00').first()).toBeVisible();
  await shot(kasiaPage, '23-staff-schedule-phone');
});
