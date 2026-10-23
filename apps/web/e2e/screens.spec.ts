import { expect, test, type Browser, type Page } from '@playwright/test';
import { waitForEmail } from './mailpit';
import {
  bookOnline,
  expectNoSidewaysScroll,
  json,
  signIn,
  verifiedUser,
  warsawDate,
  warsawInstant,
} from './seed';

/**
 * The visual set: every screen on the device it is made for, captured from the
 * running app. Mobile = 390×844 (9:19.5, portrait), Desktop = 1440×900 (16:10).
 * Files: e2e/screenshots/set/<user>-<device>-<nn>-<screen>.png
 * Every phone screen is also checked for sideways page scrolling.
 */

const run = Date.now().toString(36);
const OWNER = `studio-owner-${run}@example.com`;
const KASIA = `studio-kasia-${run}@example.com`;
const MOBILE = {
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
};
const DESKTOP = { viewport: { width: 1440, height: 900 } };

async function context(browser: Browser, device: typeof MOBILE | typeof DESKTOP) {
  return browser.newContext({ ...device, locale: 'pl-PL', timezoneId: 'Europe/Warsaw' });
}

const shot = async (page: Page, name: string, mobile: boolean) => {
  if (mobile) await expectNoSidewaysScroll(page, name);
  await page.screenshot({ path: `e2e/screenshots/set/${name}.png` });
};

test('visual set: owner (desktop + mobile), staff (mobile), client (mobile + desktop)', async ({
  browser,
  request,
}) => {
  test.setTimeout(240_000);

  // ── A salon with a full day ────────────────────────────────────────────
  const owner = await verifiedUser(request, OWNER, 'Aleksandra Nowak');
  const org = await json<{ id: string }>(
    await request.post('/v1/organizations', { headers: owner, data: { name: 'Studio GESTALT' } }),
  );
  const location = await json<{ id: string; slug: string; version: number }>(
    await request.post(`/v1/organizations/${org.id}/locations`, {
      headers: owner,
      data: {
        name: 'Studio GESTALT',
        addressLine: 'ul. Mokotowska 12',
        city: 'Warszawa',
        postalCode: '00-561',
        phone: '+48221234567',
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
  const hair = await json<{ id: string }>(
    await request.post(`${base}/service-categories`, { headers: owner, data: { name: 'Włosy' } }),
  );
  const nails = await json<{ id: string }>(
    await request.post(`${base}/service-categories`, {
      headers: owner,
      data: { name: 'Paznokcie', sortOrder: 1 },
    }),
  );
  const svc: Record<string, string> = {};
  for (const [key, name, durationMinutes, priceGrosze, categoryId, color, description] of [
    [
      'women',
      'Strzyżenie damskie',
      60,
      18000,
      hair.id,
      '#7A2E8E',
      'Mycie, strzyżenie i stylizacja',
    ],
    ['men', 'Strzyżenie męskie', 45, 9000, hair.id, '#1F3A93', null],
    ['color', 'Koloryzacja', 120, 35000, hair.id, '#B23A48', 'Cena od, zależy od długości włosów'],
    ['nails', 'Manicure hybrydowy', 75, 14000, nails.id, '#00796B', null],
  ] as const) {
    svc[key] = (
      await json<{ id: string }>(
        await request.post(`${base}/services`, {
          headers: owner,
          data: {
            name,
            durationMinutes,
            priceGrosze,
            categoryId,
            color,
            ...(description ? { description } : {}),
          },
        }),
      )
    ).id;
  }
  const staff: Record<string, string> = {};
  for (const [name, services, bio] of [
    ['Kasia', ['women', 'men', 'color'], 'Koloryzacja i strzyżenia damskie'],
    ['Ola', ['women', 'men'], null],
    ['Marta', ['nails'], 'Manicure i pielęgnacja dłoni'],
    ['Alex', ['men'], null],
  ] as const) {
    const created = await json<{ id: string }>(
      await request.post(`${base}/staff`, {
        headers: owner,
        data: {
          displayName: name,
          serviceIds: services.map((s) => svc[s]),
          ...(bio ? { bio } : {}),
        },
      }),
    );
    await json(
      await request.put(`${base}/staff/${created.id}/working-hours`, {
        headers: owner,
        data: {
          days: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
            weekday,
            intervals: [{ start: '09:00', end: '19:00' }],
          })),
        },
      }),
    );
    staff[name] = created.id;
  }

  // Tomorrow's day: visits booked by the salon, a break, one online booking.
  const day = warsawDate(1);
  const visits: [string, string, string, string, string][] = [
    ['Kasia', 'color', '09:00', 'Natalia Wiśniewska', '+48601111111'],
    ['Kasia', 'women', '15:30', 'Olena Kovalenko', '+48602222222'],
    ['Ola', 'women', '10:00', 'Zofia Lewandowska', '+48603333333'],
    ['Ola', 'men', '14:15', 'Piotr Zieliński', '+48604444444'],
    ['Marta', 'nails', '09:30', 'Julia Kamińska', '+48605555555'],
    ['Marta', 'nails', '11:00', 'Iryna Bondarenko', '+48606666666'],
    ['Marta', 'nails', '14:00', 'Ewa Szymańska', '+48607777777'],
    ['Alex', 'men', '10:30', 'Tomasz Wójcik', '+48608888888'],
    ['Alex', 'men', '12:00', 'Michał Dąbrowski', '+48609999999'],
    ['Alex', 'men', '16:45', 'Andrii Melnyk', '+48600000001'],
  ];
  for (const [who, service, time, name, phone] of visits) {
    await json(
      await request.post(`${base}/appointments`, {
        headers: owner,
        data: {
          serviceId: svc[service],
          staffId: staff[who],
          start: warsawInstant(day, time),
          customer: { name, phone },
        },
      }),
    );
  }
  await json(
    await request.post(`${base}/time-blocks`, {
      headers: owner,
      data: {
        staffId: staff.Ola,
        start: warsawInstant(day, '12:30'),
        end: warsawInstant(day, '13:30'),
        reason: 'Przerwa',
      },
    }),
  );

  // Kasia joins with her own account (for the staff screens).
  await json(
    await request.post(`/v1/organizations/${org.id}/invitations`, {
      headers: owner,
      data: { email: KASIA, role: 'staff', locationIds: [location.id], staffMemberId: staff.Kasia },
    }),
  );
  const invitation = await waitForEmail(KASIA, /Zaproszenie/);
  const kasia = await verifiedUser(request, KASIA, 'Kasia Nowicka');
  await json(
    await request.post(`/v1/invitations/${/\/invite\/(\S+)/.exec(invitation.text)![1]}/accept`, {
      headers: kasia,
    }),
  );
  await json(
    await request.post(`/v1/organizations/${org.id}/staff-categories`, {
      headers: owner,
      data: { name: 'Stylistka', permissions: { viewClientNotes: true } },
    }),
  );
  await bookOnline(request, location.slug, svc.women!, staff.Kasia!, warsawInstant(day, '12:00'), {
    name: 'Anna Kowalska',
    phone: '+48600100200',
    email: `anna-${run}@example.com`,
  });

  const calendarUrl = `/pl/app/calendar?date=${day}`;

  // ── A. Owner — Desktop ────────────────────────────────────────────────
  {
    const ctx = await context(browser, DESKTOP);
    const page = await ctx.newPage();
    await signIn(page, OWNER);
    await page.goto(calendarUrl);
    await expect(page.getByRole('button', { name: /Natalia Wiśniewska/ })).toBeVisible();
    await page.locator('.cal-scroll').evaluate((el) => (el.scrollTop = 80));
    await shot(page, 'A-owner-desktop-01-calendar', false);
    await page.getByRole('button', { name: /Anna Kowalska/ }).click();
    await expect(page.getByRole('dialog')).toContainText('Online');
    await shot(page, 'A-owner-desktop-02-appointment', false);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Nowa wizyta', exact: true }).click();
    await shot(page, 'A-owner-desktop-03-new-appointment', false);
    await page.getByRole('dialog').getByRole('button', { name: 'Zablokuj czas' }).click();
    await shot(page, 'A-owner-desktop-04-block-time', false);
    await page.keyboard.press('Escape');
    await page.goto('/pl/app/clients');
    await expect(page.getByText('Zofia Lewandowska')).toBeVisible();
    await shot(page, 'A-owner-desktop-05-clients', false);
    await page.getByRole('button', { name: /Anna Kowalska/ }).click();
    await expect(page.getByRole('dialog')).toContainText('Wizyty');
    await shot(page, 'A-owner-desktop-06-client-card', false);
    await page.keyboard.press('Escape');
    await page.goto('/pl/app/services');
    await expect(page.getByText('Manicure hybrydowy')).toBeVisible();
    await shot(page, 'A-owner-desktop-07-services', false);
    await page.getByRole('button', { name: /Koloryzacja/ }).click();
    await shot(page, 'A-owner-desktop-08-service-form', false);
    await page.keyboard.press('Escape');
    await page.goto('/pl/app/team');
    await expect(page.getByRole('button', { name: /Marta/ })).toBeVisible();
    await shot(page, 'A-owner-desktop-09-team', false);
    await page.getByRole('button', { name: /Marta/ }).click();
    await expect(page.getByRole('dialog')).toContainText('Godziny pracy');
    await shot(page, 'A-owner-desktop-10-staff-hours', false);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Dostęp i uprawnienia' }).click();
    await expect(page.getByText('Kasia Nowicka')).toBeVisible();
    await shot(page, 'A-owner-desktop-11-access', false);
    await page.getByRole('button', { name: /Kasia Nowicka/ }).click();
    await shot(page, 'A-owner-desktop-12-permissions', false);
    await page.keyboard.press('Escape');
    await page.goto('/pl/app/notifications');
    await expect(page.getByText('Nowa rezerwacja online').first()).toBeVisible();
    await shot(page, 'A-owner-desktop-13-notifications', false);
    await page.goto('/pl/app/settings');
    await expect(page.getByLabel('Link dla klientów')).toBeVisible();
    await shot(page, 'A-owner-desktop-14-settings', false);
    await ctx.close();
  }

  // ── A. Owner — Mobile ─────────────────────────────────────────────────
  {
    const ctx = await context(browser, MOBILE);
    const page = await ctx.newPage();
    await signIn(page, OWNER);
    await page.goto(calendarUrl);
    await expect(page.getByRole('button', { name: /Natalia Wiśniewska/ })).toBeVisible();
    await shot(page, 'A-owner-mobile-01-calendar', true);
    await page.getByRole('button', { name: /Natalia Wiśniewska/ }).click();
    await expect(page.getByRole('dialog')).toContainText('Koloryzacja');
    await shot(page, 'A-owner-mobile-02-appointment', true);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Nowa wizyta', exact: true }).click();
    await shot(page, 'A-owner-mobile-03-new-appointment', true);
    await page.keyboard.press('Escape');
    for (const [path, name, check] of [
      ['clients', 'A-owner-mobile-04-clients', 'Zofia Lewandowska'],
      ['notifications', 'A-owner-mobile-05-notifications', 'Nowa rezerwacja online'],
      ['more', 'A-owner-mobile-06-more', 'Usługi'],
      ['services', 'A-owner-mobile-07-services', 'Manicure hybrydowy'],
      ['team', 'A-owner-mobile-08-team', 'Marta'],
      ['settings', 'A-owner-mobile-10-settings', 'Rezerwacje online'],
    ] as const) {
      await page.goto(`/pl/app/${path}`);
      await expect(page.getByText(check).filter({ visible: true }).first()).toBeVisible();
      await shot(page, name, true);
      if (path === 'team') {
        await page.getByRole('button', { name: /Marta/ }).click();
        await expect(page.getByRole('dialog')).toContainText('Godziny pracy');
        await page.getByRole('dialog').getByText('Godziny pracy').scrollIntoViewIfNeeded();
        await shot(page, 'A-owner-mobile-09-staff-hours', true);
        await page.keyboard.press('Escape');
      }
    }
    await ctx.close();
  }

  // ── B. Staff (Kasia) — Mobile ─────────────────────────────────────────
  {
    const ctx = await context(browser, MOBILE);
    const page = await ctx.newPage();
    await signIn(page, KASIA);
    await page.goto(calendarUrl);
    await expect(page.getByRole('button', { name: /Natalia Wiśniewska/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /Zofia Lewandowska/ })).toHaveCount(0);
    await shot(page, 'B-staff-mobile-01-calendar', true);
    await page.getByRole('button', { name: /Anna Kowalska/ }).click();
    await expect(page.getByRole('dialog')).toContainText('Kontakt widoczny tylko z uprawnieniem');
    await shot(page, 'B-staff-mobile-02-appointment', true);
    await page.getByRole('dialog').getByRole('button', { name: 'Przenieś', exact: true }).click();
    await shot(page, 'B-staff-mobile-03-move', true);
    await page.keyboard.press('Escape');
    await page.goto('/pl/app/notifications');
    await expect(page.getByText('Nowa rezerwacja online').first()).toBeVisible();
    await shot(page, 'B-staff-mobile-04-notifications', true);
    await page.goto('/pl/app/schedule');
    await expect(page.getByText('09:00–19:00').first()).toBeVisible();
    await shot(page, 'B-staff-mobile-05-schedule', true);
    await page.goto('/pl/app/more');
    await expect(page.getByText('Mój grafik').filter({ visible: true }).first()).toBeVisible();
    await expect(page.getByText('Klienci')).toHaveCount(0);
    await shot(page, 'B-staff-mobile-06-more', true);
    await ctx.close();
  }

  // ── C. Client — Mobile, then Desktop ─────────────────────────────────
  for (const [device, mobile, label] of [
    [MOBILE, true, 'mobile'],
    [DESKTOP, false, 'desktop'],
  ] as const) {
    const ctx = await context(browser, device);
    const page = await ctx.newPage();
    const email = `client-${label}-${run}@example.com`;
    await page.goto(`/pl/b/${location.slug}`);
    await expect(page.getByRole('heading', { name: 'Studio GESTALT' })).toBeVisible();
    await shot(page, `C-client-${label}-01-services`, mobile);
    await page.getByRole('button', { name: /Strzyżenie damskie/ }).click();
    await shot(page, `C-client-${label}-02-staff`, mobile);
    await page.getByRole('button', { name: /Dowolny specjalista/ }).click();
    await expect(page.locator('.times button').first()).toBeVisible();
    await shot(page, `C-client-${label}-03-time`, mobile);
    await page.locator('.times button').first().click();
    await page
      .getByLabel('Imię i nazwisko')
      .fill(label === 'mobile' ? 'Marek Nowak' : 'Oksana Shevchenko');
    await page.getByLabel('Telefon').fill('600 300 400');
    await page.getByLabel('E-mail').fill(email);
    await page.getByLabel(/Akceptuję zasady/).check();
    await shot(page, `C-client-${label}-04-details`, mobile);
    await page.getByRole('button', { name: 'Wyślij kod' }).click();
    const code = /\b(\d{6})\b/.exec((await waitForEmail(email, /Kod potwierdzenia/)).text)![1]!;
    await page.getByLabel('Kod z e-maila').fill(code);
    await shot(page, `C-client-${label}-05-code`, mobile);
    await page.getByRole('button', { name: 'Potwierdź wizytę' }).click();
    await expect(page.getByRole('heading', { name: 'Do zobaczenia!' })).toBeVisible();
    await shot(page, `C-client-${label}-06-done`, mobile);
    await page.getByRole('link', { name: 'Zmień lub odwołaj wizytę' }).click();
    await expect(page.getByText('Potwierdzona')).toBeVisible();
    await shot(page, `C-client-${label}-07-manage`, mobile);
    await ctx.close();
  }
});
