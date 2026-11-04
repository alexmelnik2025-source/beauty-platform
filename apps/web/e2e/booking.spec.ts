import {
  expect,
  test,
  type APIRequestContext,
  type APIResponse,
  type Locator,
  type Page,
} from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { clearMailbox, listTo, waitForEmail } from './mailpit';
import { serveApp } from './mobile-app';
import { waitForSmsCode } from './sms-log';

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
const CLIENT2 = `ola-${run}@example.com`;
const CLIENT3 = `piotr-${run}@example.com`;
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

/**
 * A picture like one from a phone camera, drawn in the browser: `width`×`height`
 * pixels, as PNG or JPEG, for the file pickers of the cabinet.
 */
async function testPhoto(page: Page, name: string, width: number, height: number) {
  const type = name.endsWith('.png') ? 'image/png' : 'image/jpeg';
  const base64 = await page.evaluate(
    ({ width, height, type }) => {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d')!;
      const gradient = ctx.createLinearGradient(0, 0, width, height);
      gradient.addColorStop(0, '#1d1d1b');
      gradient.addColorStop(1, '#c8a46a');
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, width, height);
      ctx.fillStyle = '#ffffff';
      ctx.font = `${Math.round(height / 6)}px sans-serif`;
      ctx.fillText('GESTALT', width / 10, height / 2);
      return canvas.toDataURL(type, 0.95).split(',')[1]!;
    },
    { width, height, type },
  );
  return { name, mimeType: type, buffer: Buffer.from(base64, 'base64') };
}

/** Pixel size of a shown picture once it has loaded. */
const naturalSize = (img: Locator) =>
  img.evaluate(async (el) => {
    const image = el as HTMLImageElement;
    await image.decode();
    return [image.naturalWidth, image.naturalHeight];
  });

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
      data: {
        version: location.version,
        onlineBookingEnabled: true,
        // Longer than the 2-hour change deadline: the first free time can always be changed
        // online, whatever time of day the test runs.
        minLeadMinutes: 180,
        languages: ['pl', 'uk', 'ru'],
        description: 'Barbershop na Woli.\nKawa i parking dla klientów.',
        // Where the salon is on the catalogue map.
        latitude: 52.2325,
        longitude: 20.9563,
      },
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
  for (const [displayName, languages, specialties] of [
    ['Kasia', ['pl', 'uk'], ['barber', 'hairdresser']],
    ['Ola', ['pl'], ['barber']],
    ['Alex', ['pl', 'en'], []],
  ] as const) {
    const staff = await json<{ id: string }>(
      await request.post(`${base}/staff`, {
        headers: owner,
        data: { displayName, languages, specialties, serviceIds: services.map((s) => s.id) },
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

  // ── The catalogue: found by spoken language, opened from the list ──────
  const finder = await browser.newContext({ viewport: PHONE, locale: 'pl-PL', isMobile: true });
  const visitor = await finder.newPage();
  await visitor.goto('/pl');
  await visitor.getByRole('link', { name: 'Znajdź salon' }).click();
  await expect(visitor.getByRole('heading', { name: 'Znajdź salon' })).toBeVisible();
  const card = visitor.getByRole('article', { name: 'Gestalt Barbershop' });
  await expect(card).toBeVisible();
  await expect(visitor.getByText('Znalezione salony: 1')).toBeVisible();
  await expect(visitor.getByRole('img', { name: 'Mapa salonów' })).toBeVisible();
  // Only Alex speaks English, and that is enough to find the salon.
  await visitor.getByRole('button', { name: 'angielski' }).click();
  await expect(visitor.getByRole('button', { name: 'angielski' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(card.getByRole('note')).toHaveAttribute(
    'aria-label',
    'Mówimy po: polski, ukraiński, rosyjski, angielski',
  );
  await card.getByRole('button', { name: 'Pokaż na mapie' }).click();
  await shot(visitor, '00a-catalogue');
  // Nobody speaks Belarusian there (yet).
  await visitor.getByRole('button', { name: 'białoruski' }).click();
  await expect(visitor.getByText('Nie ma jeszcze salonów z tym językiem.')).toBeVisible();
  await visitor.getByRole('button', { name: 'Wszystkie języki' }).click();
  await card.getByRole('link', { name: 'Umów wizytę' }).click();
  await expect(visitor).toHaveURL(new RegExp(`/pl/b/${location.slug}$`));
  await expect(visitor.getByRole('heading', { name: 'Gestalt Barbershop' })).toBeVisible();
  await finder.close();

  // ── The client books on a phone ────────────────────────────────────────
  const phone = await browser.newContext({ viewport: PHONE, locale: 'pl-PL', isMobile: true });
  const client = await phone.newPage();
  await client.goto(`/pl/b/${location.slug}`);
  await expect(client.getByRole('heading', { name: 'Gestalt Barbershop' })).toBeVisible();
  // Languages of the salon under the address.
  await expect(
    client.getByRole('note', { name: 'Mówimy po: polski, ukraiński, rosyjski' }),
  ).toBeVisible();
  // Salon profile: description, map link, opening hours from the team's schedules.
  await expect(client.getByText('Kawa i parking dla klientów.')).toBeVisible();
  await expect(client.getByRole('link', { name: 'Pokaż na mapie' })).toHaveAttribute(
    'href',
    'https://www.google.com/maps/search/?api=1&query=' +
      encodeURIComponent('ul. Józefa Bema 91, 01-233 Warszawa'),
  );
  await expect(client.locator('.opening-hours summary')).toContainText(
    'Godziny otwarcia · dziś 08:00–21:00',
  );
  await client.locator('.opening-hours summary').click();
  await expect(client.locator('.opening-hours tr')).toHaveCount(7);
  await expect(client.getByRole('rowheader', { name: 'poniedziałek' })).toBeVisible();
  await expect(client.locator('.opening-hours tr[data-today] td')).toHaveText('08:00–21:00');
  await shot(client, '00-client-salon-profile');
  await client.locator('.opening-hours summary').click();
  await shot(client, '01-client-services');

  await client.getByRole('button', { name: /Strzyżenie męskie/ }).click();
  // Each specialist with their own languages.
  await expect(client.getByRole('button', { name: /Kasia/ })).toContainText('UA');
  await expect(client.getByRole('button', { name: /Alex/ })).toContainText('EN');
  // And what they do: the main specialty first.
  await expect(client.getByRole('button', { name: /Kasia/ }).locator('.c-specialty')).toHaveText(
    'Barber, Fryzjer',
  );
  await expect(client.getByRole('button', { name: /Alex/ }).locator('.c-specialty')).toHaveCount(0);
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
  // Moving asks first: a tap on a time only proposes it, "Nie" keeps the old time (owner test T11).
  await client.getByRole('button', { name: 'Zmień termin' }).click();
  await client.locator('.times button').first().click();
  const moveConfirm = client.getByRole('alertdialog');
  await expect(moveConfirm).toContainText('Przenieść wizytę na');
  await shot(client, '07a-client-move-confirm');
  await moveConfirm.getByRole('button', { name: 'Nie', exact: true }).click();
  await expect(moveConfirm).toBeHidden();
  await expect(client.getByText('Termin zmieniony.')).toBeHidden();
  await client.goto(manageLink);
  await expect(client.getByText('Potwierdzona')).toBeVisible();

  // ── "My visits": the client signs in with an emailed code, no password ──
  await client.goto('/pl/c');
  await client.getByLabel('E-mail').fill(CLIENT);
  await client.getByRole('button', { name: 'Wyślij kod' }).click();
  const loginMail = await waitForEmail(CLIENT, /Kod logowania/);
  const loginCode = /\b(\d{6})\b/.exec(loginMail.text)![1]!;
  await client.getByLabel('Kod z e-maila').fill(loginCode);
  await shot(client, '07b-client-visits-code');
  await client.getByRole('button', { name: 'Zaloguj się' }).click();
  const visitRow = client.getByRole('link', { name: /Strzyżenie męskie/ });
  await expect(visitRow).toContainText('Gestalt Barbershop');
  await expect(visitRow).toContainText('Kasia');
  await shot(client, '07c-client-visits');
  await client.getByRole('button', { name: 'Historia' }).click();
  await expect(client.getByText('Tu pojawią się Twoje wcześniejsze wizyty.')).toBeVisible();
  await client.getByRole('button', { name: 'Nadchodzące' }).click();
  await client.getByRole('link', { name: /Strzyżenie męskie/ }).click();
  await expect(client.getByText('Potwierdzona')).toBeVisible();
  await expect(client.getByRole('button', { name: 'Zmień termin' })).toBeVisible();
  await shot(client, '07d-client-visit');
  // "Book again" opens the booking page at the times of the same service and staff member.
  await client.getByRole('link', { name: 'Umów ponownie' }).click();
  await expect(client.locator('.times button').first()).toBeVisible();
  await shot(client, '07e-client-book-again');
  // The session survives a reload (httpOnly cookie).
  await client.goto('/pl/c');
  await expect(client.getByText(`Zalogowano jako ${CLIENT}`)).toBeVisible();
  // "My visits" installs as its own app, separate from the salon cabinet.
  const visitsManifestHref = await client.locator('link[rel="manifest"]').getAttribute('href');
  expect(visitsManifestHref).toBe('/manifests/visits-pl.webmanifest');
  const visitsManifest = await (await client.request.get(visitsManifestHref!)).json();
  expect(visitsManifest).toMatchObject({
    id: '/c',
    name: 'GESTALT · Wizyty',
    start_url: '/pl/c',
    display: 'standalone',
  });
  await expect(client.getByRole('button', { name: 'Zainstaluj aplikację' })).toBeVisible();
  await shot(client, '07f-client-install-app');

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

  // Owner's test 03.11 (T6): a client came without a booking yesterday — the visit is entered
  // afterwards, straight away as "came" and "paid".
  const yesterday = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Warsaw' }).format(
    Date.now() - 24 * 60 * 60_000,
  );
  await ownerPage
    .getByRole('button', { name: /Nowa wizyta/ })
    .first()
    .click();
  const walkIn = ownerPage.getByRole('dialog');
  await walkIn.getByLabel('Usługa').selectOption(services[2]!.id);
  await walkIn.getByLabel('Specjalista').selectOption(staffIds[1]!);
  await walkIn.getByLabel('Data').fill(yesterday);
  await walkIn.getByLabel('Godzina').fill('10:00');
  await walkIn.getByLabel('Imię i nazwisko').fill('Piotr Wiśniewski');
  await walkIn.getByLabel('Telefon').fill('+48 600 200 301');
  await expect(walkIn.getByTestId('walk-in-note')).toContainText('zapisana jako odbyta');
  await walkIn.getByLabel(/Klient już zapłacił/).check();
  await shot(ownerPage, '52-owner-walk-in-past');
  await walkIn.getByRole('button', { name: 'Zapisz wizytę' }).click();
  await expect(walkIn).toBeHidden();
  await ownerPage.goto(`/pl/app/calendar?date=${yesterday}`);
  await ownerPage.getByRole('button', { name: /Piotr Wiśniewski/ }).click();
  await expect(ownerPage.getByRole('dialog')).toContainText('Odbyła się');
  await expect(ownerPage.getByRole('dialog')).toContainText('Opłacon');
  await shot(ownerPage, '53-owner-walk-in-card');
  await ownerPage.keyboard.press('Escape');

  // The other sections of the cabinet.
  await ownerPage.goto('/pl/app/services');
  await expect(ownerPage.getByText('Strzyżenie + broda').first()).toBeVisible();
  await shot(ownerPage, '15-owner-services');
  // Owner's test 03.11 (T4): a double tap on «Zapisz» adds one service, not two;
  // (T2): an edit shows in the list at once, without reloading the page.
  await ownerPage.getByRole('button', { name: '+ Dodaj usługę' }).click();
  const serviceDialog = ownerPage.getByRole('dialog');
  await serviceDialog.getByLabel('Nazwa').fill('Golenie brzytwą');
  await serviceDialog.getByLabel('Cena (zł)').fill('60');
  await serviceDialog.getByRole('button', { name: 'Zapisz' }).dblclick();
  await expect(serviceDialog).toBeHidden();
  const shaveRow = ownerPage.getByRole('button', { name: /Golenie brzytwą/ });
  await expect(shaveRow).toHaveCount(1);
  // (T5): a new service is performed by everyone at once (clients can book it); when nobody
  // performs it, the list says clients cannot see it.
  await shaveRow.click();
  const who = ownerPage.getByRole('dialog').getByRole('group', { name: 'Kto wykonuje tę usługę?' });
  await expect(who.getByRole('checkbox')).toHaveCount(staffIds.length);
  for (const box of await who.getByRole('checkbox').all()) await expect(box).toBeChecked();
  await who.scrollIntoViewIfNeeded();
  await shot(ownerPage, '50-owner-service-who');
  for (const box of await who.getByRole('checkbox').all()) await box.uncheck();
  await expect(who).toContainText('Nikt jej nie wykonuje');
  await ownerPage.getByRole('dialog').getByRole('button', { name: 'Zapisz' }).click();
  await expect(ownerPage.getByRole('dialog')).toBeHidden();
  await expect(shaveRow).toContainText('Nikt jej nie wykonuje — klienci jej nie widzą');
  await shot(ownerPage, '51-owner-service-no-staff');
  await shaveRow.click();
  await ownerPage.getByRole('dialog').getByLabel('Dostępna do rezerwacji').uncheck();
  await ownerPage.getByRole('dialog').getByRole('button', { name: 'Zapisz' }).click();
  await expect(shaveRow).toContainText('Ukryta');
  await shot(ownerPage, '48-owner-service-saved-once');
  // (T3): a service that was never booked can be deleted, after a confirmation.
  await shaveRow.click();
  await ownerPage.getByRole('dialog').getByRole('button', { name: 'Usuń usługę' }).click();
  await shot(ownerPage, '49-owner-service-delete');
  await ownerPage.getByRole('dialog').getByRole('button', { name: 'Tak, usuń' }).click();
  await expect(shaveRow).toHaveCount(0);
  await ownerPage.goto('/pl/app/team');
  await expect(ownerPage.getByRole('button', { name: /Kasia/ })).toBeVisible();
  await shot(ownerPage, '16-owner-team');
  await ownerPage.getByRole('button', { name: /Ola/ }).click();
  await expect(ownerPage.getByRole('dialog')).toContainText('Godziny pracy');
  await expect(
    ownerPage.getByRole('dialog').getByRole('button', { name: 'PL polski' }),
  ).toHaveAttribute('aria-pressed', 'true');
  await expect(
    ownerPage.getByRole('dialog').getByRole('button', { name: 'EN angielski' }),
  ).toHaveAttribute('aria-pressed', 'false');
  await shot(ownerPage, '17-owner-staff-hours');
  // Ola's photo: a tall phone picture is made smaller in the browser, saved at once.
  const olaDialog = ownerPage.getByRole('dialog');
  await olaDialog
    .getByLabel('Dodaj zdjęcie')
    .setInputFiles(await testPhoto(ownerPage, 'ola.png', 1200, 1600));
  const olaPhoto = olaDialog.getByRole('img', { name: 'Zdjęcie: Ola' });
  await expect(olaPhoto).toBeVisible();
  expect(await naturalSize(olaPhoto)).toEqual([600, 800]);
  await expect(olaDialog.getByRole('button', { name: 'Usuń zdjęcie' })).toBeVisible();
  await shot(ownerPage, '33-owner-staff-photo');
  await ownerPage.keyboard.press('Escape');
  await expect(ownerPage.getByRole('button', { name: /Ola/ }).locator('img')).toBeVisible();
  const olaRow = (
    await json<{ id: string; photoUrl: string | null }[]>(
      await request.get(`${base}/staff`, { headers: owner }),
    )
  ).find((s) => s.id === staffIds[1]);
  expect(olaRow?.photoUrl).toMatch(/^\/v1\/public\/photos\/[0-9a-f-]{36}$/);
  const olaFile = await request.get(olaRow!.photoUrl!);
  expect(olaFile.headers()['content-type']).toBe('image/jpeg');
  // Alex's specialty: one from the list and the salon's own words.
  await ownerPage.getByRole('button', { name: /Alex/ }).click();
  const alexDialog = ownerPage.getByRole('dialog');
  await alexDialog.getByRole('button', { name: 'Masaż' }).click();
  await expect(alexDialog.getByRole('button', { name: 'Masaż' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await alexDialog.getByLabel(/Inna specjalizacja/).fill('Trycholog');
  await alexDialog.locator('.specialty-picker').scrollIntoViewIfNeeded();
  await shot(ownerPage, '38-owner-staff-specialty');
  await alexDialog.getByRole('button', { name: 'Zapisz', exact: true }).click();
  await expect(ownerPage.getByRole('dialog')).toBeHidden();
  await expect(ownerPage.getByRole('button', { name: /Alex/ })).toContainText('Masaż, Trycholog');
  const alexRow = (
    await json<{ id: string; specialties: string[]; customSpecialty: string | null }[]>(
      await request.get(`${base}/staff`, { headers: owner }),
    )
  ).find((s) => s.id === staffIds[2]);
  expect(alexRow?.specialties).toEqual(['massage']);
  expect(alexRow?.customSpecialty).toBe('Trycholog');
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
  // Languages of the salon: PL, UA, RU chosen; add BY and save.
  await expect(ownerPage.getByRole('button', { name: 'PL polski' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await ownerPage.getByRole('button', { name: 'BY białoruski' }).click();
  await expect(ownerPage.getByRole('button', { name: 'BY białoruski' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  // About the salon: shown on the booking page.
  await expect(ownerPage.getByLabel('O salonie')).toHaveValue(
    'Barbershop na Woli.\nKawa i parking dla klientów.',
  );
  await ownerPage.getByLabel('O salonie').fill('Barbershop na Woli. Zapraszamy!');
  await shot(ownerPage, '21-owner-settings');
  // Short link for Instagram and the booking button for the salon's own site.
  await expect(ownerPage.getByLabel('Krótki link')).toHaveValue(new RegExp(`/s/${location.slug}$`));
  await expect(ownerPage.getByLabel('Przycisk rezerwacji na Twoją stronę')).toHaveValue(
    new RegExp(`/embed\\.js" data-salon="${location.slug}" data-lang="pl"`),
  );
  await ownerPage.getByLabel('Krótki link').scrollIntoViewIfNeeded();
  await shot(ownerPage, '30-owner-share');
  // QR code of the short link: PNG and SVG downloads, printing only the QR card.
  const qrLink = new RegExp(`/s/${location.slug}\\?utm_source=qr$`);
  const qrCode = ownerPage.getByRole('img', { name: 'Kod QR rezerwacji' });
  await expect(qrCode).toBeVisible();
  await expect(qrCode.locator('svg title')).toHaveText(qrLink);
  const qrSide = await qrCode.evaluate((el) => {
    const box = el.querySelector('svg')?.getAttribute('viewBox')?.split(' ');
    return Number(box?.[2]);
  });
  // Version 1–40 is 21–177 modules plus the 4-module quiet zone on each side.
  expect((qrSide - 8 - 17) % 4).toBe(0);
  const [png] = await Promise.all([
    ownerPage.waitForEvent('download'),
    ownerPage.getByRole('button', { name: 'Pobierz PNG' }).click(),
  ]);
  expect(png.suggestedFilename()).toBe(`qr-${location.slug}.png`);
  const pngBytes = await readFile(await png.path());
  expect(pngBytes.subarray(1, 4).toString('latin1')).toBe('PNG');
  expect(pngBytes.readUInt32BE(16)).toBe(qrSide * 32); // width from the PNG header
  const [svgFile] = await Promise.all([
    ownerPage.waitForEvent('download'),
    ownerPage.getByRole('button', { name: 'Pobierz SVG' }).click(),
  ]);
  expect(svgFile.suggestedFilename()).toBe(`qr-${location.slug}.svg`);
  const svgText = await readFile(await svgFile.path(), 'utf8');
  expect(svgText).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  expect(svgText).toContain(`/s/${location.slug}?utm_source=qr</title>`);
  await ownerPage.evaluate(() => {
    const w = window as unknown as { printed: number };
    w.printed = 0;
    window.print = () => {
      w.printed++;
    };
  });
  await ownerPage.getByRole('button', { name: 'Drukuj' }).click();
  expect(await ownerPage.evaluate(() => (window as unknown as { printed: number }).printed)).toBe(
    1,
  );
  await ownerPage.emulateMedia({ media: 'print' });
  await expect(qrCode).toBeVisible();
  await expect(ownerPage.locator('.qr-print').getByText('Zeskanuj i umów wizytę')).toBeVisible();
  await expect(ownerPage.getByLabel('Krótki link')).toBeHidden();
  await shot(ownerPage, '32-owner-qr-print');
  await ownerPage.evaluate(() => window.dispatchEvent(new Event('afterprint')));
  await ownerPage.emulateMedia({ media: 'screen' });
  await expect(ownerPage.locator('html')).not.toHaveClass(/print-qr/);
  await expect(ownerPage.getByLabel('Krótki link')).toBeVisible();
  // The place on the catalogue map, pasted as Google Maps copies it.
  const place = ownerPage.getByLabel('Miejsce na mapie katalogu');
  await expect(place).toHaveValue('52.2325, 20.9563');
  await place.fill('ul. Bema 91');
  await ownerPage.locator('form.page').getByRole('button', { name: 'Zapisz' }).click();
  await expect(ownerPage.getByText('Wpisz dwie liczby oddzielone przecinkiem')).toBeVisible();
  await place.fill(' 52.23251, 20.95634 ');
  await ownerPage.locator('form.page').getByRole('button', { name: 'Zapisz' }).click();
  await expect(ownerPage.getByText('Zapisano')).toBeVisible();
  const savedLocation = await json<{
    languages: string[];
    description: string | null;
    latitude: number | null;
    longitude: number | null;
  }>(await request.get(base, { headers: owner }));
  expect([savedLocation.latitude, savedLocation.longitude]).toEqual([52.23251, 20.95634]);
  expect(savedLocation.languages).toEqual(['pl', 'uk', 'ru', 'be']);
  expect(savedLocation.description).toBe('Barbershop na Woli. Zapraszamy!');
  // Salon photos: two big pictures, shrunk before upload and saved at once; one removed.
  await expect(ownerPage.getByText('0 z 10', { exact: true })).toBeVisible();
  await ownerPage
    .getByLabel('Dodaj zdjęcia')
    .setInputFiles([
      await testPhoto(ownerPage, 'wnetrze.png', 4000, 3000),
      await testPhoto(ownerPage, 'fotel.jpg', 3000, 4000),
    ]);
  await expect(ownerPage.getByText('2 z 10', { exact: true })).toBeVisible();
  expect(await naturalSize(ownerPage.getByRole('img', { name: 'Zdjęcie salonu 1' }))).toEqual([
    1600, 1200,
  ]);
  expect(await naturalSize(ownerPage.getByRole('img', { name: 'Zdjęcie salonu 2' }))).toEqual([
    1200, 1600,
  ]);
  await ownerPage.getByRole('img', { name: 'Zdjęcie salonu 1' }).scrollIntoViewIfNeeded();
  await shot(ownerPage, '34-owner-salon-photos');
  await ownerPage.getByRole('button', { name: 'Usuń zdjęcie 1' }).click();
  await expect(ownerPage.getByText('1 z 10', { exact: true })).toBeVisible();
  const salonPhotos = await json<{ url: string; contentType: string; sizeBytes: number }[]>(
    await request.get(`${base}/photos`, { headers: owner }),
  );
  expect(salonPhotos).toHaveLength(1);
  expect(salonPhotos[0]!.contentType).toBe('image/jpeg');
  expect(salonPhotos[0]!.sizeBytes).toBeLessThan(3 * 1024 * 1024);
  // The photos stay after reloading the page.
  await ownerPage.reload();
  expect(await naturalSize(ownerPage.getByRole('img', { name: 'Zdjęcie salonu 1' }))).toEqual([
    1200, 1600,
  ]);

  // The owner's calendar on a phone.
  const ownerPhone = await browser.newContext({ viewport: PHONE, locale: 'pl-PL', isMobile: true });
  const ownerMobile = await ownerPhone.newPage();
  await signIn(ownerMobile, OWNER);
  await ownerMobile.goto(`/pl/app/calendar?date=${visit!.date}`);
  await expect(ownerMobile.getByRole('button', { name: /Anna Kowalska/ })).toBeVisible();
  await shot(ownerMobile, '12-owner-calendar-phone');

  // The cabinet can be installed as an app: manifest in the page's language, service worker.
  const manifestHref = await ownerMobile.locator('link[rel="manifest"]').getAttribute('href');
  expect(manifestHref).toBe('/manifests/salon-pl.webmanifest');
  const manifest = await (await ownerMobile.request.get(manifestHref!)).json();
  expect(manifest).toMatchObject({ id: '/app', start_url: '/pl/app', display: 'standalone' });
  expect((await ownerMobile.request.get('/sw.js')).ok()).toBe(true);
  await ownerMobile.goto('/pl/app/more');
  await expect(
    ownerMobile.getByRole('main').getByRole('button', { name: 'Zainstaluj aplikację' }),
  ).toBeVisible();
  await shot(ownerMobile, '12b-owner-install-app');

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

  // ── "Remember me": a second client books; the visit is already in "My visits" ──
  const olaPhone = await browser.newContext({ viewport: PHONE, locale: 'pl-PL', isMobile: true });
  const ola = await olaPhone.newPage();
  await ola.goto(`/pl/b/${location.slug}`);
  // The salon's photo under its name; a tap opens it full size, Escape closes it.
  const salonThumb = ola.getByRole('button', { name: 'Zdjęcie salonu 1' });
  await expect(salonThumb).toBeVisible();
  await expect(ola.getByRole('button', { name: /^Zdjęcie salonu \d+$/ })).toHaveCount(1);
  await shot(ola, '35-client-salon-photos');
  await salonThumb.click();
  const lightbox = ola.getByRole('dialog', { name: 'Zdjęcia salonu' });
  const bigPhoto = lightbox.getByRole('img', { name: 'Zdjęcie 1 z 1' });
  expect(await naturalSize(bigPhoto)).toEqual([1200, 1600]);
  await expect(lightbox.getByRole('button', { name: 'Następne zdjęcie' })).toHaveCount(0);
  await shot(ola, '36-client-salon-photo-open');
  await ola.keyboard.press('Escape');
  await expect(lightbox).toHaveCount(0);
  await expect(salonThumb).toBeFocused();
  await ola.getByRole('button', { name: /Strzyżenie męskie/ }).click();
  // Specialists with their photos; without a photo — initials.
  await expect(ola.getByRole('button', { name: /^Ola/ }).locator('img')).toBeVisible();
  expect(await naturalSize(ola.getByRole('button', { name: /^Ola/ }).locator('img'))).toEqual([
    600, 800,
  ]);
  await expect(ola.getByRole('button', { name: /^Kasia/ }).locator('img')).toHaveCount(0);
  await expect(ola.getByRole('button', { name: /^Kasia/ }).locator('.avatar')).toHaveText('K');
  await shot(ola, '37-client-staff-photos');
  await ola.getByRole('button', { name: /Kasia/ }).click();
  await ola.locator('.times button').last().click();
  await expect(ola.getByText(/Termin czeka na Ciebie/)).toBeVisible();
  await ola.getByLabel('Imię i nazwisko').fill('Ola Wiśniewska');
  await ola.getByLabel('Telefon').fill('600 300 400');
  await ola.getByLabel('E-mail').fill(CLIENT2);
  await ola.getByLabel(/Akceptuję zasady/).check();
  await ola.getByLabel(/Zapamiętaj mnie/).check();
  await shot(ola, '24-client-remember-me');
  await ola.getByRole('button', { name: 'Wyślij kod' }).click();
  const olaMail = await waitForEmail(CLIENT2, /Kod potwierdzenia/);
  await ola.getByLabel('Kod z e-maila').fill(/\b(\d{6})\b/.exec(olaMail.text)![1]!);
  await ola.getByRole('button', { name: 'Potwierdź wizytę' }).click();
  await expect(ola.getByText('Wizyta jest już w aplikacji')).toBeVisible();
  await shot(ola, '25-client-done-app');
  // No sign-in code needed: the booking code already confirmed the email.
  await ola.getByRole('link', { name: 'Zainstaluj aplikację' }).click();
  await expect(ola).toHaveURL(/\/pl\/c$/);
  await expect(ola.getByText(`Zalogowano jako ${CLIENT2}`)).toBeVisible();
  await expect(ola.getByRole('link', { name: /Strzyżenie męskie/ })).toHaveCount(1);
  await expect(ola.getByRole('button', { name: 'Zainstaluj aplikację' })).toBeVisible();
  await shot(ola, '26-client-visits-after-booking');
  // Next time the details are filled in; "not me" clears them.
  await ola.goto(`/pl/b/${location.slug}`);
  await ola.getByRole('button', { name: /Strzyżenie męskie/ }).click();
  await ola.getByRole('button', { name: /Kasia/ }).click();
  await ola.locator('.times button').last().click();
  await expect(ola.getByLabel('Imię i nazwisko')).toHaveValue('Ola Wiśniewska');
  await expect(ola.getByLabel('E-mail')).toHaveValue(CLIENT2);
  await expect(ola.getByLabel('Telefon')).toHaveValue('+48600300400');
  await expect(ola.getByLabel(/Zapamiętaj mnie/)).toBeChecked();
  await shot(ola, '27-client-details-remembered');
  await ola.getByRole('button', { name: 'To nie ja — wyczyść dane' }).click();
  await expect(ola.getByLabel('Imię i nazwisko')).toHaveValue('');
  await expect(ola.getByLabel(/Zapamiętaj mnie/)).not.toBeChecked();

  // ── The code by SMS instead of email (no gateway: the API logs the SMS) ──
  const piotrPhone = await browser.newContext({ viewport: PHONE, locale: 'pl-PL', isMobile: true });
  const piotr = await piotrPhone.newPage();
  await piotr.goto(`/pl/b/${location.slug}`);
  await piotr.getByRole('button', { name: /Strzyżenie męskie/ }).click();
  await piotr.getByRole('button', { name: /Alex/ }).click();
  await piotr.locator('.times button').first().click();
  await expect(piotr.getByText(/Termin czeka na Ciebie/)).toBeVisible();
  await piotr.getByLabel('Imię i nazwisko').fill('Piotr Zieliński');
  await piotr.getByLabel('Telefon').fill('600 500 600');
  await piotr.getByLabel('E-mail').fill(CLIENT3);
  await piotr.getByLabel(/Akceptuję zasady/).check();
  await expect(piotr.getByRole('button', { name: 'E-mail', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await piotr.getByRole('button', { name: 'SMS', exact: true }).click();
  await shot(piotr, '28-client-code-by-sms');
  await piotr.getByRole('button', { name: 'Wyślij kod' }).click();
  await expect(piotr.getByText('Wysłaliśmy SMS z 6 cyframi na +48600500600.')).toBeVisible();
  await piotr.getByLabel('Kod z SMS-a').fill(await waitForSmsCode('+48600500600'));
  await shot(piotr, '29-client-sms-code');
  await piotr.getByRole('button', { name: 'Potwierdź wizytę' }).click();
  await expect(piotr.getByRole('heading', { name: 'Do zobaczenia!' })).toBeVisible();
  // Details of the visit still come by email; the code did not.
  await waitForEmail(CLIENT3, /Wizyta potwierdzona/);
  expect((await listTo(CLIENT3)).some((m) => /Kod potwierdzenia/.test(m.Subject))).toBe(false);

  // ── Short link and the booking button on the salon's own site ─────────
  // The short link opens booking in the visitor's language and keeps utm_… parameters.
  const short = await request.get(`/s/${location.slug}?utm_source=instagram`, {
    maxRedirects: 0,
    headers: { 'accept-language': 'uk-UA,uk;q=0.9,en;q=0.8' },
  });
  expect(short.status()).toBe(307);
  expect(short.headers()['location']).toMatch(
    new RegExp(`/uk/b/${location.slug}\\?utm_source=instagram$`),
  );
  const anyone = await request.get(`/s/${location.slug}`, {
    maxRedirects: 0,
    headers: { 'accept-language': 'de-DE,de;q=0.9' },
  });
  expect(anyone.headers()['location']).toMatch(new RegExp(`/pl/b/${location.slug}$`));
  // Only the booking page may be shown in another site's frame.
  expect(
    (await request.get(`/pl/b/${location.slug}`)).headers()['x-frame-options'],
  ).toBeUndefined();
  expect((await request.get('/pl/login')).headers()['x-frame-options']).toBe('DENY');

  // A salon website on another address with the code from the cabinet.
  const web = new URL(process.env.WEB_URL ?? 'http://localhost:3000');
  const salonSite = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(
      `<!doctype html><html lang="pl"><meta name="viewport" content="width=device-width"><body><h1>Gestalt — strona salonu</h1>` +
        `<a href="#" data-bp-book>Zarezerwuj online</a>` +
        `<script src="${web.origin}/embed.js" data-salon="${location.slug}" data-lang="pl" async></script>` +
        `</body></html>`,
    );
  });
  await new Promise<void>((done) => salonSite.listen(0, '127.0.0.1', done));
  try {
    const visitor = await (await browser.newContext({ viewport: PHONE, isMobile: true })).newPage();
    await visitor.goto(`http://127.0.0.1:${(salonSite.address() as AddressInfo).port}/`);
    await visitor.getByRole('button', { name: 'Umów wizytę' }).click();
    const widget = visitor.frameLocator('iframe[title="Umów wizytę"]');
    await expect(widget.getByRole('heading', { name: 'Gestalt Barbershop' })).toBeVisible();
    await expect(widget.getByRole('button', { name: /Strzyżenie męskie/ })).toBeVisible();
    await shot(visitor, '31-salon-site-booking-window');
    await visitor.getByRole('button', { name: 'Zamknij' }).click();
    await expect(visitor.getByRole('dialog')).toBeHidden();
    // The salon's own link opens the same window.
    await visitor.getByRole('link', { name: 'Zarezerwuj online' }).click();
    await expect(widget.getByRole('heading', { name: 'Gestalt Barbershop' })).toBeVisible();
    await visitor.keyboard.press('Escape');
    await expect(visitor.getByRole('dialog')).toBeHidden();
  } finally {
    salonSite.close();
  }

  // ── Business app for iPhone and Android (web preview of apps/mobile-business) ──
  // Sign-in with a code, no password; one salon → straight to the day calendar.
  const now = await json<{
    appointments: {
      date: string;
      status: string;
      customer: { name: string; phone: string | null } | null;
    }[];
  }>(
    await request.get(`${base}/calendar`, {
      headers: owner,
      params: { from: day(-1), to: day(21) },
    }),
  );
  const annaVisit = now.appointments.find(
    (a) => a.customer?.name === 'Anna Kowalska' && a.status === 'confirmed',
  )!;
  expect(annaVisit.customer?.phone, 'the owner sees the client phone').toBeTruthy();
  const salonToday = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Warsaw' }).format(
    new Date(),
  );
  const daysAhead = Math.round((Date.parse(annaVisit.date) - Date.parse(salonToday)) / 86_400_000);

  const businessApp = await serveApp('mobile-business');
  try {
    const signInBusinessApp = async (email: string, name: string) => {
      const phone = await (
        await browser.newContext({ viewport: PHONE, locale: 'pl-PL', isMobile: true })
      ).newPage();
      await phone.goto(businessApp.url);
      await expect(phone.getByRole('heading', { name: 'Zaloguj się' })).toBeVisible();
      await phone.getByLabel('E-mail lub telefon').fill(email);
      await shot(phone, `${name}-sign-in`);
      await phone.getByRole('button', { name: 'Wyślij kod' }).click();
      await expect(phone.getByText(`Wysłaliśmy 6-cyfrowy kod na ${email}.`)).toBeVisible();
      const mail = await waitForEmail(email, /Kod logowania do aplikacji salonu/);
      await phone.getByLabel('Kod', { exact: true }).fill(/\b(\d{6})\b/.exec(mail.text)![1]!);
      await shot(phone, `${name}-code`);
      await phone.getByRole('button', { name: 'Zaloguj się' }).click();
      // Today first, then forward to the day of Anna's visit.
      await expect(phone.getByText('Gestalt Barbershop')).toBeVisible();
      await expect(phone.getByRole('button', { name: 'Dziś' })).toBeVisible();
      for (let i = 0; i < daysAhead; i++) {
        await phone.getByRole('button', { name: 'Następny dzień' }).click();
      }
      await expect(phone.getByText('Anna Kowalska').first()).toBeVisible();
      return phone;
    };

    // Kasia (specialist): her visit, but not the client's phone number.
    const kasiaApp = await signInBusinessApp(KASIA, '32-business-app-staff');
    await expect(kasiaApp.getByText(annaVisit.customer!.phone!)).toHaveCount(0);
    await shot(kasiaApp, '32-business-app-staff-day');
    // The visit card: service and specialist, but no contacts without the permission.
    await kasiaApp.getByText('Anna Kowalska').first().click();
    await expect(kasiaApp.getByText('Kontakt widoczny tylko z uprawnieniem')).toBeVisible();
    await expect(kasiaApp.getByText(annaVisit.customer!.phone!)).toHaveCount(0);
    await shot(kasiaApp, '32a-business-app-staff-visit');
    await kasiaApp.getByRole('button', { name: '‹ Wróć' }).click();
    await expect(kasiaApp.getByRole('button', { name: 'Dziś' })).toBeVisible();
    // Her own schedule: weekly hours and time off, read only for a specialist.
    await kasiaApp.getByRole('button', { name: 'Mój grafik' }).click();
    await expect(kasiaApp.getByRole('heading', { name: 'Mój grafik' })).toBeVisible();
    await expect(kasiaApp.getByText('poniedziałek', { exact: true })).toBeVisible();
    await expect(
      kasiaApp.getByText('Grafik zmienia właściciel lub menedżer salonu.'),
    ).toBeVisible();
    await expect(kasiaApp.getByRole('button', { name: 'Dodaj wolne' })).toHaveCount(0);
    await shot(kasiaApp, '32b-business-app-staff-schedule');
    await kasiaApp.getByRole('button', { name: '‹ Wróć' }).click();
    await expect(kasiaApp.getByRole('button', { name: 'Dziś' })).toBeVisible();
    // The refresh token is kept: opening the app again needs no new code.
    await kasiaApp.reload();
    await expect(kasiaApp.getByRole('button', { name: 'Dziś' })).toBeVisible();
    await kasiaApp.getByRole('button', { name: 'Wyloguj się' }).click();
    await expect(kasiaApp.getByRole('heading', { name: 'Zaloguj się' })).toBeVisible();

    // The owner sees the whole salon, with the client's phone.
    const ownerApp = await signInBusinessApp(OWNER, '33-business-app-owner');
    await expect(ownerApp.getByText(annaVisit.customer!.phone!).first()).toBeVisible();
    await shot(ownerApp, '33-business-app-owner-day');
    // The owner's visit card: call / SMS the client; "came" waits until the visit starts.
    await ownerApp.getByText('Anna Kowalska').first().click();
    await expect(
      ownerApp.getByRole('button', { name: `Zadzwoń ${annaVisit.customer!.phone!}` }),
    ).toBeVisible();
    await expect(ownerApp.getByText('Usługa', { exact: true })).toBeVisible();
    await expect(ownerApp.getByText(/można zaznaczyć, gdy wizyta się zacznie/)).toBeVisible();
    await shot(ownerApp, '33a-business-app-owner-visit');
    await ownerApp.getByRole('button', { name: '‹ Wróć' }).click();
    await expect(ownerApp.getByRole('button', { name: 'Dziś' })).toBeVisible();
  } finally {
    businessApp.server.close();
  }

  // ── Client app for iPhone and Android (web preview of apps/mobile-client) ──
  // The same "My visits" as on the web: the email the client books with → code, no password.
  const clientApp = await serveApp('mobile-client');
  try {
    const phone = await (
      await browser.newContext({ viewport: PHONE, locale: 'pl-PL', isMobile: true })
    ).newPage();
    await phone.goto(clientApp.url);
    await expect(phone.getByRole('heading', { name: 'Moje wizyty' })).toBeVisible();
    await phone.getByLabel('E-mail', { exact: true }).fill(CLIENT);
    await shot(phone, '58-client-app-sign-in');
    const visitCode = /Kod logowania do Twoich wizyt/;
    const codesBefore = (await listTo(CLIENT)).filter((m) => visitCode.test(m.Subject)).length;
    await phone.getByRole('button', { name: 'Wyślij kod' }).click();
    await expect(
      phone.getByText(`Wysłaliśmy 6-cyfrowy kod na ${CLIENT}.`, { exact: false }),
    ).toBeVisible();
    // Wait for the new code, not the one the web sign-in above used.
    await expect
      .poll(async () => (await listTo(CLIENT)).filter((m) => visitCode.test(m.Subject)).length)
      .toBeGreaterThan(codesBefore);
    const appCodeMail = await waitForEmail(CLIENT, visitCode);
    await phone.getByLabel('Kod z e-maila').fill(/\b(\d{6})\b/.exec(appCodeMail.text)![1]!);
    await shot(phone, '58a-client-app-code');
    await phone.getByRole('button', { name: 'Zaloguj się' }).click();
    // Upcoming visits in every salon: the booked haircut at Gestalt with Kasia.
    await expect(phone.getByText(`Zalogowano jako ${CLIENT}`)).toBeVisible();
    await expect(phone.getByText('Strzyżenie męskie').first()).toBeVisible();
    await expect(phone.getByText('Gestalt Barbershop').first()).toBeVisible();
    await expect(phone.getByText('u: Kasia').first()).toBeVisible();
    await expect(phone.getByText('Potwierdzona').first()).toBeVisible();
    await shot(phone, '58b-client-app-visits');
    await phone.getByRole('tab', { name: 'Historia' }).click();
    await expect(phone.getByRole('tab', { name: 'Historia', selected: true })).toBeVisible();
    await phone.waitForLoadState('networkidle');
    await shot(phone, '58c-client-app-history');
    // The session is kept on the phone: opening the app again needs no new code.
    await phone.reload();
    await expect(phone.getByText(`Zalogowano jako ${CLIENT}`)).toBeVisible();
    await phone.getByRole('button', { name: 'Wyloguj się' }).click();
    await expect(phone.getByRole('heading', { name: 'Moje wizyty' })).toBeVisible();
    await expect(phone.getByLabel('E-mail', { exact: true })).toBeVisible();
  } finally {
    clientApp.server.close();
  }
});
