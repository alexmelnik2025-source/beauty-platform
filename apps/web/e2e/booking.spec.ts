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
import { freshAddress } from './addresses';
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
/** Books in the client app without signing in first. */
const CLIENT4 = `marek-${run}@example.com`;
const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1440, height: 900 };

const shot = (page: Page, name: string) => page.screenshot({ path: `e2e/screenshots/${name}.png` });

async function json<T>(res: APIResponse): Promise<T> {
  expect(res.ok(), `${res.url()} → ${res.status()} ${await res.text()}`).toBeTruthy();
  return (res.status() === 204 ? undefined : await res.json()) as T;
}

/** Registers, confirms the email from Mailpit and signs in (mobile client: token in body). */
async function verifiedUser(api: APIRequestContext, email: string, name: string) {
  await json(
    await api.post('/v1/auth/register', {
      headers: freshAddress(),
      data: { email, password: PASSWORD, name },
    }),
  );
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
        // Online booking can be switched on only with the salon's own legal texts.
        bookingTerms:
          '# Regulamin rezerwacji\n\nRezerwacja jest bezpłatna. Zmiany do 2 godzin przed wizytą.',
        privacyPolicy: '# Polityka prywatności\n\nAdministratorem danych jest GESTALT.',
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
  // Task 12: everyone's nearest free time — today, tomorrow or the day it is.
  const nearestFree = /^(Dziś wolne od|Jutro wolne od|Najbliższy wolny termin: .+,) \d\d:\d\d$/;
  await expect(client.getByRole('button', { name: /Kasia/ }).locator('.c-free')).toHaveText(
    nearestFree,
  );
  await expect(
    client.getByRole('button', { name: /Dowolny specjalista/ }).locator('.c-free'),
  ).toHaveText(nearestFree);
  await shot(client, '02-client-staff');
  // Task 81: "Mówi po" — only the specialists who speak the language (PL is spoken by all: no chip).
  const speaks = client.getByRole('group', { name: 'Mówi po' });
  await expect(speaks.getByRole('button')).toHaveText(['Wszyscy', 'UA ukraiński', 'EN angielski']);
  await speaks.getByRole('button', { name: 'Mówi po: angielski' }).click();
  await expect(client.getByRole('button', { name: /Alex/ })).toBeVisible();
  await expect(client.getByRole('button', { name: /Kasia/ })).toHaveCount(0);
  await expect(client.getByRole('button', { name: /Dowolny specjalista/ })).toHaveCount(0);
  await shot(client, '02l-client-staff-speaks-en');
  await speaks.getByRole('button', { name: 'Wszyscy' }).click();
  await expect(client.getByRole('button', { name: /Kasia/ })).toBeVisible();
  await client.getByRole('button', { name: /Kasia/ }).click();
  await expect(client.locator('.times button').first()).toBeVisible();
  await shot(client, '03-client-times');
  await client.locator('.times button').first().click();

  await expect(client.getByText(/Termin czeka na Ciebie/)).toBeVisible();
  await client.getByLabel('Imię i nazwisko').fill('Anna Kowalska');
  // Launch task L5: the salon's country code comes first; another country replaces the code.
  const country = client.getByLabel('Kod kraju');
  await expect(country).toHaveValue('PL');
  await expect(country.locator('option').first()).toHaveText('Polska +48');
  await expect(client.getByLabel('Telefon')).toHaveValue('+48 ');
  await country.selectOption('UA');
  await expect(client.getByLabel('Telefon')).toHaveValue('+380 ');
  await client.getByLabel('Telefon').fill('+380 50 123 45 67');
  await shot(client, '68-client-phone-country');
  await country.selectOption('PL');
  await expect(client.getByLabel('Telefon')).toHaveValue('+48 50 123 45 67');
  await client.getByLabel('Telefon').fill('600 100 200');
  await client.getByLabel('E-mail').fill(CLIENT);
  await client.getByLabel(/Akceptuję regulamin rezerwacji/).check();
  await shot(client, '04-client-details');
  // Launch task L1: the consent links to the salon's own booking terms and privacy policy.
  await expect(client.getByRole('link', { name: 'regulamin rezerwacji' })).toHaveAttribute(
    'href',
    `/pl/b/${location.slug}/regulamin`,
  );
  await expect(client.getByRole('link', { name: 'politykę prywatności' })).toHaveAttribute(
    'href',
    `/pl/b/${location.slug}/privacy`,
  );
  const termsPage = await client.context().newPage();
  await termsPage.goto(`/pl/b/${location.slug}/regulamin`);
  await expect(termsPage.getByRole('heading', { name: 'Regulamin rezerwacji' })).toBeVisible();
  await expect(termsPage.getByText('Zmiany do 2 godzin przed wizytą.')).toBeVisible();
  await shot(termsPage, '66-client-booking-terms');
  await termsPage.close();
  await client.getByRole('button', { name: 'Wyślij kod' }).click();

  const codeMail = await waitForEmail(CLIENT, /Kod potwierdzenia/);
  const code = /\b(\d{6})\b/.exec(codeMail.text)![1]!;
  await client.getByLabel('Kod z e-maila').fill(code);
  await shot(client, '05-client-code');
  // Task 80: the optional wishes above "Potwierdź wizytę" — one tap, a short note.
  const wishStep = client.getByRole('region', { name: 'Twoje życzenia' });
  await wishStep.getByRole('button', { name: /Wolę ciszę/ }).click();
  await expect(wishStep.getByRole('button', { name: /Wolę ciszę/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await wishStep
    .getByLabel('Coś, o czym specjalista powinien wiedzieć?')
    .fill('Wrażliwa skóra głowy');
  await wishStep.scrollIntoViewIfNeeded();
  await shot(client, '05w-client-wishes');
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
  // "Add to calendar" (task 20): the email and the page give the visit as an .ics file.
  expect(confirmation.text).toContain('Dodaj do kalendarza:');
  const calendarLink = client.getByRole('link', { name: 'Dodaj do kalendarza' });
  const icsHref = (await calendarLink.getAttribute('href'))!;
  expect(icsHref).toMatch(/\/v1\/public\/appointments\/\S+\/calendar\.ics$/);
  const icsFile = await client.request.get(icsHref);
  expect(icsFile.headers()['content-type']).toContain('text/calendar');
  expect(await icsFile.text()).toContain('SUMMARY:Strzyżenie męskie');
  // The wishes can be changed by the link until the visit.
  const wishEdit = client.getByRole('form', { name: 'Twoje życzenia' });
  await expect(wishEdit.getByRole('button', { name: /Wolę ciszę/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(wishEdit.getByLabel('Coś, o czym specjalista powinien wiedzieć?')).toHaveValue(
    'Wrażliwa skóra głowy',
  );
  await shot(client, '07w-client-manage-wishes');
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
  // "Download my data" (GDPR): a JSON file with the card, visits and bonuses in every salon.
  const [download] = await Promise.all([
    client.waitForEvent('download'),
    client.getByRole('button', { name: 'Pobierz moje dane' }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^my-data-\d{4}-\d{2}-\d{2}\.json$/);
  const myData = JSON.parse(await readFile((await download.path())!, 'utf8')) as {
    person: { email: string };
    salons: { salon: string; visits: { service: string }[] }[];
  };
  expect(myData.person.email).toBe(CLIENT);
  expect(myData.salons[0]?.visits.map((v) => v.service)).toContain('Strzyżenie męskie');
  await shot(client, '07g-client-download-data');

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
  // The specialist sees the wishes on top of the visit: 🤫 and the note.
  const wishesCard = ownerPage.getByRole('region', { name: 'Życzenia klienta' });
  await expect(wishesCard).toContainText('🤫 Woli ciszę');
  await expect(wishesCard).toContainText('Wrażliwa skóra głowy');
  await shot(ownerPage, '09w-owner-visit-wishes');
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

  // Launch task L4: Ola's visits still kept in Booksy — the same time blocked every week. The
  // first week already has Jan Kowalski at 20:00, so that day stays free and is named.
  const weekLater = (date: string, weeks: number) =>
    new Date(Date.parse(`${date}T12:00:00Z`) + weeks * 7 * 24 * 60 * 60_000)
      .toISOString()
      .slice(0, 10);
  await ownerPage.goto(`/pl/app/calendar?date=${visit!.date}`);
  await ownerPage
    .getByRole('button', { name: /Nowa wizyta/ })
    .first()
    .click();
  const weekly = ownerPage.getByRole('dialog');
  await weekly.getByRole('button', { name: 'Zablokuj czas' }).click();
  await weekly.getByLabel('Specjalista').selectOption(staffIds[1]!);
  await weekly.getByLabel('Data').fill(visit!.date);
  await weekly.getByLabel('Od', { exact: true }).fill('19:30');
  await weekly.getByLabel('Do', { exact: true }).fill('20:15');
  await weekly.getByLabel('Powód (np. szkolenie)').fill('Booksy');
  await weekly.getByLabel('Powtarzaj co tydzień').check();
  await weekly.getByLabel('Przez ile tygodni').fill('3');
  await weekly.getByRole('button', { name: 'Zablokuj', exact: true }).click();
  await expect(weekly.getByRole('status')).toContainText('Zablokowano 2.');
  await shot(ownerPage, '70-owner-weekly-block');
  await weekly.getByRole('button', { name: 'Gotowe' }).click();
  await expect(weekly).toBeHidden();
  await ownerPage.goto(`/pl/app/calendar?date=${weekLater(visit!.date, 1)}`);
  await ownerPage.getByRole('button', { name: 'Booksy' }).first().click();
  const seriesSheet = ownerPage.getByRole('dialog');
  await expect(seriesSheet).toContainText('Powtarza się co tydzień');
  await shot(ownerPage, '70b-owner-weekly-block-card');
  await seriesSheet.getByRole('button', { name: 'Usuń całą serię' }).click();
  await expect(seriesSheet).toBeHidden();
  await expect(ownerPage.getByRole('button', { name: 'Booksy' })).toHaveCount(0);
  await ownerPage.goto(`/pl/app/calendar?date=${weekLater(visit!.date, 2)}`);
  await expect(ownerPage.getByRole('button', { name: 'Booksy' })).toHaveCount(0);

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
  // Task 62: Kasia's own price of this service; empty boxes keep the service price.
  await who.getByLabel('Cena u: Kasia').fill('75');
  // Task 70: and her own duration.
  await who.getByLabel('Czas u: Kasia (min)').fill('60');
  await shot(ownerPage, '80-owner-service-staff-price');
  await ownerPage.getByRole('dialog').getByRole('button', { name: 'Zapisz' }).click();
  await expect(ownerPage.getByRole('dialog')).toBeHidden();
  const ownPrices = await json<{
    prices: { staffId: string; priceGrosze: number }[];
    durations: { staffId: string; durationMinutes: number }[];
  }>(await request.get(`${base}/staff-prices`, { headers: owner }));
  expect(ownPrices.prices).toEqual([
    expect.objectContaining({ staffId: staffIds[0], priceGrosze: 7500 }),
  ]);
  expect(ownPrices.durations).toEqual([
    expect.objectContaining({ staffId: staffIds[0], durationMinutes: 60 }),
  ]);
  await shaveRow.click();
  await expect(who.getByLabel('Cena u: Kasia')).toHaveValue('75.00');
  await expect(who.getByLabel('Czas u: Kasia (min)')).toHaveValue('60');
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
  await expect(ownerPage.getByRole('button', { name: /^Kasia/ })).toBeVisible();
  await shot(ownerPage, '16-owner-team');
  // Task 13: the owner puts Ola first — the booking page shows her first; then back again.
  const teamRows = ownerPage.locator('.list > li.orderable .list-row strong');
  await expect(teamRows).toHaveText(['Kasia', 'Ola', 'Alex']);
  await expect(ownerPage.getByRole('button', { name: 'Wyżej: Kasia' })).toBeDisabled();
  await ownerPage.getByRole('button', { name: 'Wyżej: Ola' }).click();
  await expect(teamRows).toHaveText(['Ola', 'Kasia', 'Alex']);
  await expect(ownerPage.getByRole('button', { name: 'Niżej: Ola' })).toBeEnabled();
  await shot(ownerPage, '73-owner-team-order');
  const publicStaff = async () =>
    (
      await json<{ staff: { displayName: string }[] }>(
        await request.get(`/v1/public/locations/${location.slug}`),
      )
    ).staff.map((s) => s.displayName);
  expect(await publicStaff()).toEqual(['Ola', 'Kasia', 'Alex']);
  await ownerPage.getByRole('button', { name: 'Niżej: Ola' }).click();
  await expect(teamRows).toHaveText(['Kasia', 'Ola', 'Alex']);
  await expect(ownerPage.getByRole('button', { name: 'Niżej: Ola' })).toBeEnabled();
  expect(await publicStaff()).toEqual(['Kasia', 'Ola', 'Alex']);
  await ownerPage.getByRole('button', { name: /^Ola/ }).click();
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
  await expect(ownerPage.getByRole('button', { name: /^Ola/ }).locator('img')).toBeVisible();
  const olaRow = (
    await json<{ id: string; photoUrl: string | null }[]>(
      await request.get(`${base}/staff`, { headers: owner }),
    )
  ).find((s) => s.id === staffIds[1]);
  expect(olaRow?.photoUrl).toMatch(/^\/v1\/public\/photos\/[0-9a-f-]{36}$/);
  const olaFile = await request.get(olaRow!.photoUrl!);
  expect(olaFile.headers()['content-type']).toBe('image/jpeg');
  // Alex's specialty: one from the list and the salon's own words.
  await ownerPage.getByRole('button', { name: /^Alex/ }).click();
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
  await expect(ownerPage.getByRole('button', { name: /^Alex/ })).toContainText('Masaż, Trycholog');
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
  // Task 98: the card sums up how the client comes — visits, no-shows, cancellations, paid total.
  const summary = ownerPage.getByTestId('client-summary');
  await summary.scrollIntoViewIfNeeded();
  await expect(summary).toContainText('Podsumowanie');
  await expect(summary).toContainText('Nieobecności');
  await expect(summary).toContainText('Zaplanowane');
  await expect(summary).toContainText('Zapłacono łącznie');
  await shot(ownerPage, '19a-owner-client-summary');
  await ownerPage.keyboard.press('Escape');
  // Task 21: the owner downloads all clients as a CSV file for Excel.
  const [csv] = await Promise.all([
    ownerPage.waitForEvent('download'),
    ownerPage.getByRole('button', { name: 'Eksportuj CSV' }).click(),
  ]);
  expect(csv.suggestedFilename()).toMatch(/^klienci-\d{4}-\d{2}-\d{2}\.csv$/);
  const csvText = (await readFile(await csv.path())).toString('utf8');
  expect(csvText.startsWith('\uFEFF"Imię i nazwisko";"Telefon"')).toBe(true);
  expect(csvText).toContain('"Anna Kowalska"');
  await shot(ownerPage, '75-owner-clients-export');
  // Task 140: "who hasn't been for a while" — Anna has a visit booked, so she is not on the list.
  await ownerPage.getByLabel('Kto dawno nie był').selectOption({ label: 'Nie byli od 30 dni' });
  await expect(ownerPage.getByText(/Ofertę wysyłaj tylko osobom ze zgodą/)).toBeVisible();
  await expect(ownerPage.getByRole('button', { name: /Anna Kowalska/ })).toHaveCount(0);
  await shot(ownerPage, '75a-owner-clients-inactive');
  await ownerPage.getByLabel('Kto dawno nie był').selectOption({ label: 'Wszyscy klienci' });
  await expect(ownerPage.getByRole('button', { name: /Anna Kowalska/ })).toBeVisible();
  // GDPR (task 21): the owner downloads a client's data and erases them on request.
  await json(
    await request.post(`/v1/organizations/${org.id}/customers`, {
      headers: owner,
      data: { name: 'Ewa Usuwana', phone: '+48600999888', email: 'ewa.rodo@example.com' },
    }),
  );
  await ownerPage.reload();
  await ownerPage.getByRole('button', { name: /Ewa Usuwana/ }).click();
  const ewaDialog = ownerPage.getByRole('dialog');
  await expect(ewaDialog).toContainText('Dane osobowe (RODO)');
  const [exported] = await Promise.all([
    ownerPage.waitForEvent('download'),
    ewaDialog.getByRole('button', { name: 'Pobierz dane klienta' }).click(),
  ]);
  expect(exported.suggestedFilename()).toMatch(/^client-.+\.json$/);
  await ewaDialog.getByRole('button', { name: 'Usuń dane klienta' }).click();
  await expect(ewaDialog.getByRole('alertdialog')).toContainText('zostaną usunięte na zawsze');
  await shot(ownerPage, '78-owner-client-erase');
  await ewaDialog.getByRole('button', { name: 'Tak, usuń dane' }).click();
  await expect(ownerPage.getByRole('dialog')).toBeHidden();
  await expect(ownerPage.getByRole('button', { name: /Ewa Usuwana/ })).toHaveCount(0);
  await expect(ownerPage.getByRole('button', { name: /Anna Kowalska/ })).toBeVisible();
  await ownerPage.goto('/pl/app/notifications');
  await expect(ownerPage.getByText('Nowa rezerwacja online').first()).toBeVisible();
  await shot(ownerPage, '20-owner-notifications');
  // "Dziennik zmian" (task 23): who changed what, newest first — owner only.
  await ownerPage.goto('/pl/app/history');
  await expect(ownerPage.getByRole('heading', { name: 'Dziennik zmian' })).toBeVisible();
  await expect(ownerPage.getByText('Dodano usługę: Strzyżenie męskie').first()).toBeVisible();
  await expect(ownerPage.getByText(/Aleksander Owner · /).first()).toBeVisible();
  await shot(ownerPage, '79-owner-change-log');
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
  // Task 22: the reminder email — 24 h by default, the salon picks 3 h.
  const reminder = ownerPage.getByLabel('Przypomnienie e-mail przed wizytą');
  await expect(reminder).toHaveValue('24');
  await reminder.selectOption('3');
  await shot(ownerPage, '21-owner-settings');
  // Task 80: questions when booking — mood and note on by default; the salon offers coffee and tea.
  const wishSettings = ownerPage.getByRole('region', { name: 'Pytania przy rezerwacji' });
  await expect(wishSettings.getByLabel(/Jak klient chce spędzić wizytę/)).toBeChecked();
  await expect(wishSettings.getByLabel(/Informacja dla specjalisty/)).toBeChecked();
  await wishSettings.getByLabel(/Coś do picia/).check();
  await wishSettings.getByLabel(/Kawa/).check();
  await wishSettings.getByLabel(/Herbata/).check();
  await wishSettings.scrollIntoViewIfNeeded();
  await shot(ownerPage, '21w-owner-wishes-settings');
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
  // Launch task L1: the salon's booking terms and privacy policy, with a template to start from.
  const terms = ownerPage.getByLabel('Regulamin rezerwacji', { exact: true });
  await expect(terms).toHaveValue(/^# Regulamin rezerwacji/);
  const privacy = ownerPage.getByLabel('Polityka prywatności', { exact: true });
  ownerPage.once('dialog', (dialog) => void dialog.accept());
  await ownerPage
    .getByRole('region', { name: 'Regulamin i prywatność' })
    .getByRole('button', { name: 'Wstaw szablon' })
    .nth(1)
    .click();
  await expect(privacy).toHaveValue(/Polityka prywatności rezerwacji online — Gestalt Barbershop/);
  await expect(privacy).toHaveValue(/Administratorem danych jest GESTALT,/);
  await expect(ownerPage.getByText(/Do uzupełnienia: .*\{KRS\}/)).toBeVisible();
  await privacy.scrollIntoViewIfNeeded();
  await shot(ownerPage, '65-owner-legal-texts');
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
    privacyPolicy: string | null;
    latitude: number | null;
    longitude: number | null;
    reminderHoursBefore: number;
    askDrink: boolean;
    drinks: string[];
  }>(await request.get(base, { headers: owner }));
  expect([savedLocation.latitude, savedLocation.longitude]).toEqual([52.23251, 20.95634]);
  expect(savedLocation.reminderHoursBefore).toBe(3);
  expect([savedLocation.askDrink, savedLocation.drinks]).toEqual([true, ['coffee', 'tea']]);
  expect(savedLocation.languages).toEqual(['pl', 'uk', 'ru', 'be']);
  expect(savedLocation.description).toBe('Barbershop na Woli. Zapraszamy!');
  expect(savedLocation.privacyPolicy).toMatch(/^# Polityka prywatności rezerwacji online/);
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

  // Launch task L5: the salon's currency. Polish złoty unless the salon picks another one; the
  // service list, the service form and the booking page then show prices in it.
  const currency = ownerPage.getByLabel('Waluta cen');
  await expect(currency).toHaveValue('PLN');
  await expect(currency.locator('option[value="TRY"]')).toHaveText(/^TRY — lira turecka$/i);
  await currency.selectOption('EUR');
  await ownerPage.locator('form.page').getByRole('button', { name: 'Zapisz' }).click();
  await expect(ownerPage.getByText('Zapisano')).toBeVisible();
  await currency.scrollIntoViewIfNeeded();
  await shot(ownerPage, '67-owner-currency');
  await ownerPage.goto('/pl/app/services');
  await expect(ownerPage.getByText(/^90,00\s€$/).first()).toBeVisible();
  await ownerPage
    .getByRole('button', { name: /Strzyżenie męskie/ })
    .first()
    .click();
  await expect(ownerPage.getByRole('dialog').getByLabel('Cena (€)')).toHaveValue('90.00');
  await shot(ownerPage, '67b-owner-service-price-euro');
  const euroPage = await ownerPage.context().newPage();
  await euroPage.goto(`/pl/b/${location.slug}`);
  await expect(euroPage.locator('.c-price', { hasText: /^90,00\s€$/ }).first()).toBeVisible();
  await shot(euroPage, '67c-booking-prices-euro');
  await euroPage.close();
  // Back to złoty for the rest of the scenario.
  await ownerPage.goto('/pl/app/settings');
  await ownerPage.getByLabel('Waluta cen').selectOption('PLN');
  await ownerPage.locator('form.page').getByRole('button', { name: 'Zapisz' }).click();
  await expect(ownerPage.getByText('Zapisano')).toBeVisible();

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
  await ola.getByLabel(/Akceptuję regulamin rezerwacji/).check();
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
  await piotr.getByLabel(/Akceptuję regulamin rezerwacji/).check();
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
    // The client card from the visit: her own visits with Anna, still no contacts.
    await kasiaApp.getByRole('button', { name: 'Karta klienta', exact: true }).click();
    await expect(kasiaApp.getByRole('heading', { name: 'Anna Kowalska' })).toBeVisible();
    await expect(kasiaApp.getByText('Najbliższe wizyty')).toBeVisible();
    await expect(kasiaApp.getByText(annaVisit.customer!.phone!)).toHaveCount(0);
    await expect(kasiaApp.getByRole('button', { name: 'Klienci' })).toHaveCount(0);
    await shot(kasiaApp, '32c-business-app-staff-client');
    await kasiaApp.getByRole('button', { name: '‹ Wróć' }).click();
    await expect(
      kasiaApp.getByRole('button', { name: 'Karta klienta', exact: true }),
    ).toBeVisible();
    await kasiaApp.getByRole('button', { name: '‹ Wróć' }).click();
    await expect(kasiaApp.getByRole('button', { name: 'Dziś' })).toBeVisible();
    await expect(kasiaApp.getByRole('button', { name: 'Klienci' })).toHaveCount(0);
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
    // "New visit" for a specialist: only herself, and no search in the salon's clients.
    await kasiaApp.getByRole('button', { name: '+ Nowa wizyta' }).click();
    await expect(kasiaApp.getByRole('heading', { name: 'Nowa wizyta' })).toBeVisible();
    await kasiaApp.getByRole('button', { name: /^Strzyżenie męskie ·/ }).click();
    await expect(kasiaApp.getByText('✓ Kasia')).toBeVisible();
    await expect(kasiaApp.getByRole('button', { name: 'Ola', exact: true })).toHaveCount(0);
    await expect(kasiaApp.getByLabel('Szukaj: imię, telefon lub e-mail')).toHaveCount(0);
    await expect(kasiaApp.getByLabel('Imię i nazwisko')).toBeVisible();
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
    // Task 80e: Anna's wishes from the booking, as in the cabinet.
    await expect(ownerApp.getByText('Życzenia klienta')).toBeVisible();
    await expect(ownerApp.getByText('🤫 Woli ciszę')).toBeVisible();
    await expect(ownerApp.getByText('✍️ Wrażliwa skóra głowy')).toBeVisible();
    await shot(ownerApp, '33a-business-app-owner-visit');
    await ownerApp.getByRole('button', { name: '‹ Wróć' }).click();
    await expect(ownerApp.getByRole('button', { name: 'Dziś' })).toBeVisible();
    // Clients: search, the card with contacts, the note and tags saved from the phone.
    await ownerApp.getByRole('button', { name: 'Klienci' }).click();
    await expect(ownerApp.getByRole('heading', { name: 'Klienci' })).toBeVisible();
    await ownerApp.getByLabel('Szukaj: imię, telefon, e-mail lub tag').fill('Kowalska');
    await ownerApp.getByRole('button', { name: 'Szukaj', exact: true }).click();
    const annaRow = ownerApp.getByRole('button', {
      name: 'Karta klienta: Anna Kowalska',
      exact: true,
    });
    await expect(annaRow).toBeVisible();
    await shot(ownerApp, '33b-business-app-owner-clients');
    // Task 140: "who hasn't been for a while" — Anna has a visit booked, so she is not listed.
    await ownerApp.getByRole('radio', { name: '30 dni' }).click();
    await expect(ownerApp.getByText(/Ofertę wysyłaj tylko osobom ze zgodą/)).toBeVisible();
    await expect(annaRow).toHaveCount(0);
    await shot(ownerApp, '33h-business-app-inactive-clients');
    await ownerApp.getByRole('radio', { name: 'Wszyscy' }).click();
    await expect(annaRow).toBeVisible();
    await annaRow.click();
    await expect(ownerApp.getByRole('heading', { name: 'Anna Kowalska' })).toBeVisible();
    await expect(
      ownerApp.getByRole('button', { name: `Zadzwoń ${annaVisit.customer!.phone!}` }),
    ).toBeVisible();
    await expect(ownerApp.getByText('Historia wizyt')).toBeVisible();
    await ownerApp.getByRole('button', { name: 'Zmień notatkę i tagi' }).click();
    await ownerApp.getByLabel('Notatka', { exact: true }).fill('Lubi krótko po bokach.');
    await ownerApp.getByLabel('Tagi', { exact: true }).fill('stała klientka, broda');
    await ownerApp.getByRole('button', { name: 'Zapisz' }).click();
    await expect(ownerApp.getByText('Zapisano.')).toBeVisible();
    await expect(ownerApp.getByText('Lubi krótko po bokach.')).toBeVisible();
    await expect(ownerApp.getByText('stała klientka', { exact: true })).toBeVisible();
    await shot(ownerApp, '33c-business-app-owner-client');
    await ownerApp.getByRole('button', { name: '‹ Wróć' }).click();
    await expect(annaRow).toBeVisible();
    await ownerApp.getByRole('button', { name: '‹ Wróć' }).click();
    await expect(ownerApp.getByRole('button', { name: 'Dziś' })).toBeVisible();
    // Blocked time (task 18c): a month later, when nothing is booked, the whole salon 12:00–12:30.
    for (let i = 0; i < 30; i++) {
      await ownerApp.getByRole('button', { name: 'Następny dzień' }).click();
    }
    await expect(ownerApp.getByText('Brak wizyt tego dnia.')).toBeVisible();
    await ownerApp.getByRole('button', { name: '+ Zablokuj czas' }).click();
    await expect(ownerApp.getByRole('heading', { name: 'Zablokuj czas' })).toBeVisible();
    await ownerApp.getByRole('button', { name: 'Cały salon' }).click();
    await ownerApp.getByRole('button', { name: 'Do: 15 minut wcześniej' }).click();
    await ownerApp.getByRole('button', { name: 'Do: 15 minut wcześniej' }).click();
    await expect(ownerApp.getByLabel('Do 12:30')).toBeVisible();
    await ownerApp.getByLabel('Powód (np. przerwa)').fill('Szkolenie zespołu');
    await shot(ownerApp, '33d-business-app-block-time');
    await ownerApp.getByRole('button', { name: 'Zablokuj', exact: true }).click();
    await expect(
      ownerApp.getByText('Czas zablokowany — klienci nie zapiszą się w tych godzinach.'),
    ).toBeVisible();
    await expect(ownerApp.getByText('12:00–12:30 · Cały salon')).toBeVisible();
    await expect(ownerApp.getByText('Szkolenie zespołu')).toBeVisible();
    await shot(ownerApp, '33e-business-app-blocked-day');
    await ownerApp.getByRole('button', { name: 'Odblokuj 12:00–12:30' }).click();
    await ownerApp.getByRole('button', { name: 'Tak, odblokuj' }).click();
    await expect(ownerApp.getByText('Czas odblokowany.')).toBeVisible();
    await expect(ownerApp.getByText('12:00–12:30 · Cały salon')).toHaveCount(0);
    // The bell (task 18d): Anna's online booking, opening it shows the visit card.
    await ownerApp.getByRole('button', { name: /^Powiadomienia/ }).click();
    await expect(ownerApp.getByRole('heading', { name: 'Powiadomienia' })).toBeVisible();
    const annaNotice = ownerApp
      .getByRole('button', { name: /Nowa wizyta online, \d\d:\d\d Anna Kowalska/ })
      .first();
    await expect(annaNotice).toBeVisible();
    await shot(ownerApp, '33f-business-app-notifications');
    await annaNotice.click();
    await expect(ownerApp.getByText('Usługa', { exact: true })).toBeVisible();
    await ownerApp.getByRole('button', { name: '‹ Wróć' }).click();
    await expect(ownerApp.getByRole('heading', { name: 'Powiadomienia' })).toBeVisible();
    await ownerApp.getByRole('button', { name: '‹ Wróć' }).click();
    await expect(ownerApp.getByRole('button', { name: 'Dziś' })).toBeVisible();
    // Back to today for the new visit (task 17).
    await ownerApp.getByRole('button', { name: 'Dziś' }).click();
    // The owner books a client who phoned: service → specialist → day and free time → client.
    await ownerApp.getByRole('button', { name: '+ Nowa wizyta' }).click();
    await expect(ownerApp.getByRole('heading', { name: 'Nowa wizyta' })).toBeVisible();
    await shot(ownerApp, '74-business-app-new-visit-services');
    await ownerApp.getByRole('button', { name: /^Strzyżenie męskie ·/ }).click();
    await ownerApp.getByRole('button', { name: 'Alex', exact: true }).click();
    for (let i = 0; i < 10; i++) {
      await ownerApp.getByRole('button', { name: 'Następny dzień' }).click();
    }
    await ownerApp.getByRole('button', { name: '20:00', exact: true }).click();
    await expect(ownerApp.getByLabel('Szukaj: imię, telefon lub e-mail')).toBeVisible();
    await ownerApp.getByLabel('Imię i nazwisko').fill('Marek Nowicki');
    await ownerApp.getByLabel('Telefon', { exact: true }).fill('601 202 303');
    await shot(ownerApp, '74a-business-app-new-visit-form');
    await ownerApp.getByRole('button', { name: 'Zapisz wizytę' }).click();
    // Saved: the new visit's card, booked by the salon, with the number in the salon's code.
    await expect(ownerApp.getByRole('heading', { name: '20:00–20:45' })).toBeVisible();
    await expect(ownerApp.getByText('Marek Nowicki')).toBeVisible();
    await expect(ownerApp.getByText('Dodana przez salon')).toBeVisible();
    await expect(ownerApp.getByRole('button', { name: 'Zadzwoń +48601202303' })).toBeVisible();
    await shot(ownerApp, '74b-business-app-new-visit-saved');
    await ownerApp.getByRole('button', { name: '‹ Wróć' }).click();
    await expect(ownerApp.getByText('Marek Nowicki')).toBeVisible();
    // Move (with "Tak / Nie") and cancel (with a reason) in the visit card.
    await ownerApp.getByText('Marek Nowicki').click();
    await ownerApp.getByRole('button', { name: 'Przenieś' }).click();
    await ownerApp.getByRole('button', { name: '19:00', exact: true }).click();
    await expect(ownerApp.getByText(/^Przenieść na .* 19:00\?$/)).toBeVisible();
    await shot(ownerApp, '75-business-app-move-visit');
    await ownerApp.getByRole('button', { name: 'Tak', exact: true }).click();
    await expect(ownerApp.getByRole('heading', { name: '19:00–19:45' })).toBeVisible();
    await expect(ownerApp.getByText(/^Wizyta przeniesiona/)).toBeVisible();
    await ownerApp.getByRole('button', { name: 'Odwołaj wizytę' }).click();
    await ownerApp.getByLabel('Powód (klient go zobaczy)').fill('Klient prosił o odwołanie');
    await ownerApp.getByRole('button', { name: 'Odwołaj wizytę' }).click();
    await ownerApp.getByRole('button', { name: 'Tak, odwołaj' }).click();
    await expect(ownerApp.getByText('Odwołana', { exact: true })).toBeVisible();
    await expect(ownerApp.getByText('Klient prosił o odwołanie')).toBeVisible();
    await expect(ownerApp.getByRole('button', { name: 'Przenieś' })).toHaveCount(0);
    await shot(ownerApp, '75a-business-app-cancelled-visit');
    await ownerApp.getByRole('button', { name: '‹ Wróć' }).click();
    await expect(ownerApp.getByText('Marek Nowicki')).toHaveCount(0);
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
    // Task 97: "Download my data" (GDPR) in the app too — the web preview downloads the JSON file.
    const appDataButton = phone.getByRole('button', { name: 'Pobierz moje dane' });
    await appDataButton.scrollIntoViewIfNeeded();
    await expect(phone.getByText(/Plik z danymi, które salony przechowują o Tobie/)).toBeVisible();
    const [appDownload] = await Promise.all([
      phone.waitForEvent('download'),
      appDataButton.click(),
    ]);
    expect(appDownload.suggestedFilename()).toMatch(/^my-data-\d{4}-\d{2}-\d{2}\.json$/);
    const appData = JSON.parse(await readFile((await appDownload.path())!, 'utf8')) as {
      person: { email: string };
      salons: { visits: { service: string }[] }[];
    };
    expect(appData.person.email).toBe(CLIENT);
    expect(appData.salons.flatMap((x) => x.visits.map((v) => v.service))).toContain(
      'Strzyżenie męskie',
    );
    await shot(phone, '58c-client-app-download-data');
    await phone.getByRole('heading', { name: 'Moje wizyty' }).scrollIntoViewIfNeeded();
    // The visit card: details, cancel (asks first), call the salon, book the same again.
    await phone
      .getByRole('button', { name: /Strzyżenie męskie, Gestalt Barbershop/ })
      .first()
      .click();
    await expect(phone.getByRole('heading', { name: 'Strzyżenie męskie' })).toBeVisible();
    await expect(phone.getByText('Kasia', { exact: true })).toBeVisible();
    await expect(phone.getByText(/Odwołać lub zmienić online możesz do/)).toBeVisible();
    await expect(phone.getByRole('button', { name: 'Umów ponownie' })).toBeVisible();
    await shot(phone, '59-client-app-visit');
    // "Add to calendar" (task 22): the app gets a link to the visit's .ics file and opens it.
    const [calendarLink] = await Promise.all([
      phone.waitForResponse((r) => r.url().endsWith('/calendar-link')),
      phone.getByRole('button', { name: 'Dodaj do kalendarza' }).click(),
    ]);
    const { url: icsUrl } = (await calendarLink.json()) as { url: string };
    const appIcs = await phone.request.get(icsUrl);
    expect(appIcs.headers()['content-type']).toContain('text/calendar');
    expect(await appIcs.text()).toContain('SUMMARY:Strzyżenie męskie');
    for (const extra of phone.context().pages()) if (extra !== phone) await extra.close();
    // Change time: the same specialist's free days and times, then a question before moving.
    await phone.getByRole('button', { name: 'Zmień termin' }).click();
    await expect(phone.getByRole('heading', { name: 'Wybierz nowy termin' })).toBeVisible();
    await expect(phone.getByText('Wolne godziny u: Kasia.', { exact: false })).toBeVisible();
    const freeTime = phone.getByRole('button', { name: /^\d{2}:\d{2}$/ }).first();
    await expect(freeTime).toBeVisible();
    await shot(phone, '59c-client-app-move');
    const newTime = (await freeTime.textContent())!.trim();
    await freeTime.click();
    const moveAsk = phone.getByRole('alertdialog');
    await expect(moveAsk).toContainText(`Przenieść wizytę na`);
    await expect(moveAsk).toContainText(`godz. ${newTime}?`);
    await shot(phone, '59d-client-app-move-ask');
    // "Nie" changes nothing; "Tak" moves the visit.
    await moveAsk.getByRole('button', { name: 'Nie', exact: true }).click();
    await expect(moveAsk).toBeHidden();
    await freeTime.click();
    await phone.getByRole('alertdialog').getByRole('button', { name: 'Tak, przenieś' }).click();
    await expect(phone.getByText('Termin zmieniony.')).toBeVisible();
    await expect(phone.getByText(`godz. ${newTime}`, { exact: false }).first()).toBeVisible();
    await expect(phone.getByRole('heading', { name: 'Wybierz nowy termin' })).toBeHidden();
    await shot(phone, '59e-client-app-moved');
    await phone.getByRole('button', { name: 'Odwołaj wizytę' }).click();
    const cancelAsk = phone.getByRole('alertdialog');
    await expect(cancelAsk).toContainText('Odwołać wizytę');
    await shot(phone, '59a-client-app-cancel-ask');
    // "Nie" changes nothing.
    await cancelAsk.getByRole('button', { name: 'Nie', exact: true }).click();
    await expect(cancelAsk).toBeHidden();
    await expect(phone.getByText('Potwierdzona')).toBeVisible();
    // "Book again" books in the app: the same service and specialist, straight to free times;
    // "back" returns to the visit card.
    await phone.getByRole('button', { name: 'Umów ponownie' }).click();
    await expect(phone.getByRole('heading', { name: 'Wybierz termin' })).toBeVisible();
    await expect(phone.getByText(/· Kasia$/)).toBeVisible();
    await expect(phone.getByRole('button', { name: 'Inna usługa lub specjalista' })).toBeVisible();
    await expect(phone.getByRole('button', { name: /^\d{2}:\d{2}$/ }).first()).toBeVisible();
    await shot(phone, '59f-client-app-book-again');
    await phone.getByRole('button', { name: '‹ Wróć' }).click();
    await expect(phone.getByRole('heading', { name: 'Strzyżenie męskie' })).toBeVisible();
    await expect(phone.getByRole('button', { name: 'Odwołaj wizytę' })).toBeVisible();
    await phone.getByRole('button', { name: 'Odwołaj wizytę' }).click();
    await phone.getByRole('alertdialog').getByRole('button', { name: 'Tak, odwołaj' }).click();
    await expect(phone.getByText('Wizyta odwołana.')).toBeVisible();
    await expect(phone.getByText('Odwołana', { exact: true })).toBeVisible();
    await expect(phone.getByRole('button', { name: 'Odwołaj wizytę' })).toBeHidden();
    await shot(phone, '59b-client-app-cancelled');
    await phone.getByRole('button', { name: '‹ Wróć' }).click();
    await expect(phone.getByText(`Zalogowano jako ${CLIENT}`)).toBeVisible();
    await phone.getByRole('tab', { name: 'Historia' }).click();
    await expect(phone.getByRole('tab', { name: 'Historia', selected: true })).toBeVisible();
    await phone.waitForLoadState('networkidle');
    await shot(phone, '58c-client-app-history');
    // Task 61: a signed-in client saves a salon to "Favourites" on its page and books from there.
    await phone.getByRole('button', { name: 'Znajdź salon' }).click();
    await phone
      .getByRole('article', { name: 'Gestalt Barbershop' })
      .getByRole('button', { name: 'Zobacz salon' })
      .click();
    await expect(phone.getByRole('heading', { name: 'Gestalt Barbershop' })).toBeVisible();
    await phone.getByRole('button', { name: '♡ Dodaj do ulubionych' }).click();
    await expect(phone.getByRole('button', { name: 'Usuń z ulubionych' })).toHaveText(
      '♥ W ulubionych',
    );
    await phone.getByRole('button', { name: '‹ Wróć' }).click();
    await phone.getByRole('button', { name: '‹ Wróć' }).click();
    await phone.getByRole('tab', { name: 'Ulubione' }).click();
    await expect(phone.getByRole('tab', { name: 'Ulubione', selected: true })).toBeVisible();
    await expect(phone.getByRole('heading', { name: 'Gestalt Barbershop' })).toBeVisible();
    await expect(
      phone.getByRole('button', { name: 'Usuń z ulubionych: Gestalt Barbershop' }),
    ).toBeVisible();
    await shot(phone, '80f-client-app-favourites');
    // The salon's page opens from the list; taking it off empties the list.
    await phone.getByRole('button', { name: 'Zobacz salon: Gestalt Barbershop' }).click();
    await expect(phone.getByRole('button', { name: 'Usuń z ulubionych' })).toBeVisible();
    await phone.getByRole('button', { name: '‹ Wróć' }).click();
    await phone.getByRole('button', { name: 'Usuń z ulubionych: Gestalt Barbershop' }).click();
    await expect(
      phone.getByText('Nie masz jeszcze ulubionych salonów.', { exact: false }),
    ).toBeVisible();
    // The session is kept on the phone: opening the app again needs no new code.
    await phone.reload();
    await expect(phone.getByText(`Zalogowano jako ${CLIENT}`)).toBeVisible();
    await phone.getByRole('button', { name: 'Wyloguj się' }).click();
    await expect(phone.getByRole('heading', { name: 'Moje wizyty' })).toBeVisible();
    await expect(phone.getByLabel('E-mail', { exact: true })).toBeVisible();

    // The catalogue needs no sign-in: by spoken language and search, then the salon's page.
    await phone.getByRole('button', { name: 'Znajdź salon' }).click();
    await expect(phone.getByRole('heading', { name: 'Znajdź salon' })).toBeVisible();
    const salonCard = phone.getByRole('article', { name: 'Gestalt Barbershop' });
    await expect(salonCard).toBeVisible();
    // Only Alex speaks English, and that is enough to find the salon.
    await phone.getByRole('button', { name: 'angielski' }).click();
    await expect(phone.getByRole('button', { name: 'angielski' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(salonCard).toBeVisible();
    // The owner added Belarusian above; the catalogue lists the specialists' languages too.
    await expect(salonCard.getByRole('note')).toHaveAttribute(
      'aria-label',
      'Mówimy po: polski, ukraiński, rosyjski, białoruski, angielski',
    );
    await shot(phone, '60-client-app-catalogue');
    await phone.getByRole('button', { name: 'Wszystkie języki' }).click();
    // Search by street, without Polish letters; a wrong city finds nothing.
    const search = phone.getByLabel('Szukaj: nazwa, miasto, ulica');
    await search.fill('jozefa bema');
    await expect(salonCard).toBeVisible();
    await search.fill('Gdańsk');
    await expect(phone.getByText('Nic nie znaleziono. Zmień wyszukiwanie.')).toBeVisible();
    await search.fill('');
    // The salon's page: price list, opening hours, specialists with their trades.
    await salonCard.getByRole('button', { name: 'Zobacz salon' }).click();
    await expect(phone.getByRole('heading', { name: 'Gestalt Barbershop' })).toBeVisible();
    await expect(phone.getByText('Strzyżenie męskie', { exact: true })).toBeVisible();
    await expect(phone.getByText('Godziny otwarcia')).toBeVisible();
    await expect(phone.getByText('Barber · Fryzjer')).toBeVisible();
    await shot(phone, '61-client-app-salon');
    // Booking in the app, without an account: service → specialist → time → details → code.
    await phone.getByRole('button', { name: 'Umów wizytę' }).click();
    await expect(phone.getByRole('heading', { name: 'Wybierz usługę' })).toBeVisible();
    await shot(phone, '64-client-app-book-service');
    await phone.getByRole('button', { name: /^Strzyżenie męskie,/ }).click();
    await expect(phone.getByRole('heading', { name: 'Wybierz specjalistę' })).toBeVisible();
    await expect(phone.getByRole('button', { name: /^Dowolny specjalista/ })).toBeVisible();
    // Task 12: each specialist's nearest free time, as on the booking page.
    const appNearest = /(Dziś wolne od|Jutro wolne od|Najbliższy wolny termin: .+,) \d\d:\d\d/;
    await expect(phone.getByRole('button', { name: /^Kasia/ })).toHaveAccessibleName(appNearest);
    await expect(phone.getByRole('button', { name: /^Dowolny specjalista/ })).toHaveAccessibleName(
      appNearest,
    );
    await shot(phone, '64d-client-app-book-staff');
    // Task 81c: "Mówi po" in the app too — only the specialists who speak the language.
    await expect(phone.getByRole('button', { name: 'ukraiński', exact: true })).toBeVisible();
    await phone.getByRole('button', { name: 'angielski', exact: true }).click();
    await expect(phone.getByRole('button', { name: /^Alex/ })).toBeVisible();
    await expect(phone.getByRole('button', { name: /^Kasia/ })).toHaveCount(0);
    await expect(phone.getByRole('button', { name: /^Dowolny specjalista/ })).toHaveCount(0);
    await shot(phone, '64e-client-app-book-speaks');
    await phone.getByRole('button', { name: 'Wszyscy', exact: true }).click();
    await phone.getByRole('button', { name: /^Kasia/ }).click();
    await expect(phone.getByRole('heading', { name: 'Wybierz termin' })).toBeVisible();
    const bookTime = phone.getByRole('button', { name: /^\d{2}:\d{2}$/ }).first();
    await expect(bookTime).toBeVisible();
    await shot(phone, '64a-client-app-book-time');
    const bookedTime = (await bookTime.textContent())!.trim();
    await bookTime.click();
    // The time is held for 10 minutes while the client fills in the details.
    await expect(phone.getByRole('heading', { name: 'Twoje dane' })).toBeVisible();
    await expect(phone.getByText(/Termin czeka na Ciebie jeszcze \d+:\d{2}/)).toBeVisible();
    await phone.getByRole('textbox', { name: 'Imię i nazwisko' }).fill('Marek Nowak');
    await phone.getByRole('textbox', { name: 'Telefon' }).fill('600 700 800');
    await phone.getByRole('textbox', { name: 'E-mail', exact: true }).fill(CLIENT4);
    // Hidden screens stay mounted (going back keeps what was typed): find only what is shown.
    // The salon's booking rules must be accepted first.
    await phone.getByRole('button', { name: 'Wyślij kod' }).click();
    await expect(phone.getByText('Zaznacz akceptację zasad rezerwacji.')).toBeVisible();
    await phone.getByRole('checkbox', { name: /Akceptuję regulamin rezerwacji/ }).click();
    await expect(
      phone.getByRole('checkbox', { name: /Akceptuję regulamin rezerwacji/ }),
    ).toBeChecked();
    // Launch task L1: the salon's booking terms and privacy policy open on the web.
    await expect(phone.getByRole('button', { name: 'Regulamin rezerwacji' })).toBeVisible();
    await expect(phone.getByRole('button', { name: 'Polityka prywatności' })).toBeVisible();
    await shot(phone, '64b-client-app-book-details');
    await phone.getByRole('button', { name: 'Wyślij kod' }).click();
    await expect(phone.getByText(`Wysłaliśmy 6 cyfr na ${CLIENT4}.`)).toBeVisible();
    const bookCodeMail = await waitForEmail(CLIENT4, /Kod potwierdzenia/);
    // Task 80e: the salon's questions on the code step, one tap each (coffee and tea offered).
    await expect(phone.getByRole('heading', { name: 'Twoje życzenia' })).toBeVisible();
    await phone.getByRole('button', { name: '😄 Chętnie pogadam' }).click();
    await expect(phone.getByRole('button', { name: '😄 Chętnie pogadam' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await phone.getByRole('button', { name: '☕ Kawa' }).click();
    await expect(phone.getByRole('button', { name: '💧 Woda' })).toHaveCount(0);
    await shot(phone, '64w-client-app-book-wishes');
    await phone.getByRole('textbox', { name: 'Kod z e-maila' }).fill('000000');
    await phone.getByRole('button', { name: 'Potwierdź wizytę' }).click();
    await expect(phone.getByText('Kod jest nieprawidłowy', { exact: false })).toBeVisible();
    await phone
      .getByRole('textbox', { name: 'Kod z e-maila' })
      .fill(/\b(\d{6})\b/.exec(bookCodeMail.text)![1]!);
    await phone.getByRole('button', { name: 'Potwierdź wizytę' }).click();
    await expect(phone.getByRole('heading', { name: 'Do zobaczenia!' })).toBeVisible();
    await expect(phone.getByText(`${bookedTime} ·`, { exact: false })).toBeVisible();
    await expect(phone.getByText('Strzyżenie męskie · Kasia')).toBeVisible();
    await shot(phone, '64c-client-app-booked');
    // Not signed in: one more code shows the new visit in "Moje wizyty"; the email is filled in.
    await phone.getByRole('button', { name: 'Zaloguj się do „Moich wizyt”' }).click();
    await expect(phone.getByLabel('E-mail', { exact: true })).toHaveValue(CLIENT4);
    await phone.getByRole('button', { name: 'Znajdź salon' }).click();
    await expect(phone.getByRole('heading', { name: 'Znajdź salon' })).toBeVisible();
    await expect(salonCard).toBeVisible();
    await phone.getByRole('button', { name: 'Українська' }).click();
    await expect(phone.getByRole('heading', { name: 'Знайти салон' })).toBeVisible();
    await shot(phone, '62-client-app-catalogue-uk');
    // Launch task L5, part 4: Turkish and Albanian in the client app too.
    await phone.getByRole('button', { name: 'Türkçe' }).click();
    await expect(phone.getByRole('heading', { name: 'Salon bul' })).toBeVisible();
    await expect(salonCard.getByRole('button', { name: 'Salonu gör' })).toBeVisible();
    await shot(phone, '71f-client-app-catalogue-tr');
    await phone.getByRole('button', { name: 'Shqip' }).click();
    await expect(phone.getByRole('heading', { name: 'Gjeni një sallon' })).toBeVisible();
    await shot(phone, '71g-client-app-catalogue-sq');
    await phone.getByRole('button', { name: 'Українська' }).click();
    await expect(phone.getByRole('heading', { name: 'Знайти салон' })).toBeVisible();
    await phone.getByRole('button', { name: '‹ Назад' }).click();
    await expect(phone.getByLabel('E-mail', { exact: true })).toBeVisible();
  } finally {
    clientApp.server.close();
  }
});
