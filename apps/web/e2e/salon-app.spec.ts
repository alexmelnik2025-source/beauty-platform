import { expect, test, type APIResponse, type Locator, type Page } from '@playwright/test';
import { waitForEmail } from './mailpit';
import { openBusinessMenu, serveApp } from './mobile-app';

/**
 * Task 131: "Salon" in the business app (web preview of apps/mobile-business). The owner changes
 * the salon's phone and description from the phone; online booking cannot be switched on
 * without booking terms; when someone else saved the salon meanwhile, the app shows the current
 * data and the second try goes through. Screenshots 131, 131a. Task 319: "Zasady rezerwacji" —
 * the lead time, how far ahead, the change deadline and the step of the times (screenshot 319).
 * Task 320: "Pytania przy rezerwacji" — mood off, a drink with what the salon has (screenshot 320).
 * Task 321: "Miejsce na mapie katalogu" — coordinates pasted from Google Maps (screenshot 321).
 * Task 322: "Języki w salonie" — Polish and Ukrainian at the salon (screenshot 322).
 * Task 323: "Kraj i strefa czasowa" and "Waluta cen" — Czechia and koruna (screenshot 323).
 * Task 324: "Regulamin i prywatność" — the template over the written terms, own privacy words
 * (screenshot 324). Task 325: "Zdjęcia salonu" — two photos, one removed (screenshot 325).
 * Task 337: a new photo from the phone's gallery (the browser's file chooser here; screenshot
 * 337).
 */

const PASSWORD = 'e2e-password-123';
const run = Date.now().toString(36);
const OWNER = `salon-app-owner-${run}@example.com`;
const PHONE = { width: 320, height: 844 };
// A sign-up address of its own (reserved for tests, RFC 2544): the API allows 10 sign-ups an hour from one.
const n = Math.floor(Math.random() * 65_536);
const ADDRESS = { 'x-forwarded-for': `198.18.${n >> 8}.${n & 255}` };

/** A small photo drawn in the browser (like the one the cabinet sends after shrinking). */
async function drawnPhoto(page: Page, text: string): Promise<Buffer> {
  const base64 = await page.evaluate((label) => {
    const canvas = document.createElement('canvas');
    canvas.width = 400;
    canvas.height = 300;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#1d1d1b';
    ctx.fillRect(0, 0, 400, 300);
    ctx.fillStyle = '#c8a46a';
    ctx.font = '48px sans-serif';
    ctx.fillText(label, 60, 170);
    return canvas.toDataURL('image/jpeg', 0.9).split(',')[1]!;
  }, text);
  return Buffer.from(base64, 'base64');
}

const shot = (page: Page, name: string) => page.screenshot({ path: `e2e/screenshots/${name}.png` });

async function touchTarget(control: Locator) {
  const box = await control.boundingBox();
  expect(box, control.toString()).toBeTruthy();
  expect(box!.width).toBeGreaterThanOrEqual(44);
  expect(box!.height).toBeGreaterThanOrEqual(44);
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(PHONE.width);
}

async function json<T>(res: APIResponse): Promise<T> {
  expect(res.ok(), `${res.url()} → ${res.status()} ${await res.text()}`).toBeTruthy();
  return (res.status() === 204 ? undefined : await res.json()) as T;
}

test('the owner changes the salon from the business app (task 131)', async ({
  browser,
  request,
}) => {
  await json(
    await request.post('/v1/auth/register', {
      headers: ADDRESS,
      data: { email: OWNER, password: PASSWORD, name: 'Aleksander Owner' },
    }),
  );
  const mail = await waitForEmail(OWNER, /Potwierdź adres/);
  const token = /token=([^\s&]+)/.exec(mail.text)?.[1];
  await json(
    await request.post('/v1/auth/verify-email', { data: { token: decodeURIComponent(token!) } }),
  );
  const login = await json<{ accessToken: string }>(
    await request.post('/v1/auth/login', {
      headers: ADDRESS,
      data: { email: OWNER, password: PASSWORD, clientType: 'mobile' },
    }),
  );
  const owner = { Authorization: `Bearer ${login.accessToken}` };
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
  const path = `/v1/organizations/${org.id}/locations/${location.id}`;

  const businessApp = await serveApp('mobile-business');
  try {
    // The app's sign-in from the same address of its own: sign-in codes are limited per address too.
    const context = await browser.newContext({
      viewport: PHONE,
      locale: 'pl-PL',
      isMobile: true,
      extraHTTPHeaders: ADDRESS,
    });
    const app = await context.newPage();
    await app.goto(businessApp.url);
    await app.getByLabel('E-mail lub telefon').fill(OWNER);
    await app.getByRole('button', { name: 'Wyślij kod' }).click();
    const code = await waitForEmail(OWNER, /Kod logowania do aplikacji salonu/);
    await app.getByLabel('Kod', { exact: true }).fill(/\b(\d{6})\b/.exec(code.text)![1]!);
    await app.getByRole('button', { name: 'Zaloguj się' }).click();
    await expect(app.getByRole('button', { name: 'Dziś' })).toBeVisible();
    // Task 325: two photos added in the cabinet.
    for (const text of ['FOTEL', 'LUSTRO']) {
      await json(
        await request.post(`${path}/photos`, {
          headers: { ...owner, 'Content-Type': 'image/jpeg' },
          data: await drawnPhoto(app, text),
        }),
      );
    }

    // ── Settings: phone without the country code, a description ──────────────
    await openBusinessMenu(app, 'Ustawienia');
    await expect(app.getByRole('heading', { name: 'Ustawienia', exact: true })).toBeVisible();
    const backToSettings = app.getByRole('button', { name: '‹ Ustawienia', exact: true });
    async function openSettingsSection(name: string) {
      if (await backToSettings.isVisible()) await backToSettings.click();
      await app.getByRole('button', { name: new RegExp(`^${name}`) }).click();
      await expect(app.getByRole('heading', { name, exact: true })).toBeVisible();
    }

    await openSettingsSection('Dane salonu');
    const salonName = app.getByLabel('Nazwa salonu');
    await expect(salonName).toHaveValue('Gestalt Barbershop');
    await salonName.fill('Zmiana do odrzucenia');
    await expect(app.getByText('Niezapisane zmiany')).toBeVisible();
    await app.getByRole('button', { name: 'Odrzuć', exact: true }).click();
    await expect(salonName).toHaveValue('Gestalt Barbershop');
    const phone = app.getByRole('textbox', { name: 'Telefon salonu' });
    const email = app.getByRole('textbox', { name: 'E-mail (opcjonalnie)' });
    const about = app.getByRole('textbox', { name: 'O salonie' });
    const save = app.getByRole('button', { name: 'Zapisz', exact: true });
    const discard = app.getByRole('button', { name: 'Odrzuć', exact: true });
    const unsaved = app.getByText('Niezapisane zmiany', { exact: true });

    for (const [label, bad, good, message] of [
      ['Nazwa salonu', '', 'Gestalt Barbershop', 'Wpisz nazwę salonu.'],
      ['Ulica i numer', ' ', 'ul. Józefa Bema 91', 'Wpisz ulicę i numer.'],
      ['Miasto', '', 'Warszawa', 'Wpisz miasto.'],
      ['Kod pocztowy', '1', '01-233', 'Wpisz kod pocztowy.'],
      ['Telefon salonu', '123', '22 123 45 67', 'Wpisz numer telefonu, np. 600 100 200.'],
      ['E-mail (opcjonalnie)', 'salon@', 'SALON@example.com', 'Sprawdź adres e-mail.'],
    ] as const) {
      const field = app.getByRole('textbox', { name: label, exact: true });
      await field.fill(bad);
      await save.click();
      await expect(field).toBeFocused();
      await expect(field).toHaveAttribute('aria-invalid', 'true');
      await expect(field).toHaveAccessibleDescription(`! ${message}`);
      await expect(app.getByRole('alert')).toHaveText(`! ${message}`);
      await field.fill(good);
      await expect(app.getByRole('alert')).toHaveCount(0);
    }
    // The API also rejects addresses that pass the app's basic format check.
    await email.fill('salon@example.c');
    await save.click();
    await expect(email).toHaveAccessibleDescription('! Sprawdź adres e-mail.');
    await email.fill('SALON@example.com');
    const description = 'Strzyżemy od 2015 roku. Kawa gratis.';
    await about.fill(description);

    // At the default font size the status and both actions share a line.
    const statusBox = (await unsaved.boundingBox())!;
    const saveBox = (await save.boundingBox())!;
    expect(statusBox.y).toBeGreaterThanOrEqual(saveBox.y);
    expect(statusBox.y + statusBox.height).toBeLessThanOrEqual(saveBox.y + saveBox.height);
    await shot(app, '131-business-app-salon');

    // Enlarge the actual text in the Expo web preview, including both action labels.
    const largeType = await app.addStyleTag({
      content: '[dir="auto"], input, textarea { font-size: 28px !important; }',
    });
    await expect(phone).toHaveCSS('font-size', '28px');
    for (const control of [
      ...(await app.getByRole('textbox').all()),
      backToSettings,
      discard,
      save,
    ]) {
      await touchTarget(control);
    }
    for (const label of [unsaved, discard.getByText('Odrzuć'), save.getByText('Zapisz')]) {
      await expect(label).toHaveCSS('font-size', '28px');
      const lines = await label.evaluate((element) => {
        const range = document.createRange();
        range.selectNodeContents(element);
        return Array.from(range.getClientRects(), (rect) => rect.top);
      });
      expect(new Set(lines).size).toBe(1);
    }
    await largeType.evaluate((style) => style.parentNode?.removeChild(style));

    await app.route(`**${path}`, (route) => route.abort('connectionfailed'), { times: 1 });
    await save.click();
    await expect(app.getByRole('alert')).toContainText('Brak połączenia z serwerem');
    await expect(app.getByRole('alert')).toBeInViewport();
    await expect(phone).toHaveValue('22 123 45 67');
    await expect(email).toHaveValue('SALON@example.com');
    await expect(about).toHaveValue(description);
    await expect(unsaved).toBeVisible();
    await save.click();
    await expect(app.getByText('Zapisano.')).toBeVisible();
    const saved = await json<{
      phone: string;
      email: string;
      description: string;
      version: number;
    }>(await request.get(path, { headers: owner }));
    expect(saved.phone).toBe('+48221234567');
    expect(saved.email).toBe('salon@example.com');
    expect(saved.description).toBe(description);

    // ── Online booking needs the terms first ────────────────────────────────
    await openSettingsSection('Rezerwacja online');
    await app.getByLabel('Rezerwacja online').click();
    await app.getByRole('button', { name: 'Zapisz' }).click();
    await expect(app.getByText(/potrzebuje regulaminu i polityki prywatności/)).toBeVisible();
    await shot(app, '131a-business-app-salon-terms-needed');

    // Meanwhile the terms are written in the salon dashboard (a newer version of the salon).
    await json(
      await request.patch(path, {
        headers: owner,
        data: {
          version: saved.version,
          bookingTerms: '# Regulamin\n\nWizyta jest bezpłatna do odwołania.',
          privacyPolicy: '# Prywatność\n\nAdministratorem danych jest GESTALT.',
        },
      }),
    );
    await app.getByRole('button', { name: 'Zapisz' }).click();
    await expect(app.getByText(/Ktoś inny właśnie zmienił dane salonu/)).toBeVisible();
    await openSettingsSection('Rezerwacja online');
    await expect(app.getByText('Wyłączona — strona rezerwacji jest niedostępna.')).toBeVisible();
    await app.getByLabel('Rezerwacja online').click();
    await app.getByRole('button', { name: 'Zapisz' }).click();
    await expect(app.getByText('Zapisano.')).toBeVisible();
    await expect(app.getByText('Włączona — klienci umawiają się przez link salonu.')).toBeVisible();
    const online = await json<{ onlineBookingEnabled: boolean; phone: string }>(
      await request.get(path, { headers: owner }),
    );
    expect(online).toMatchObject({ onlineBookingEnabled: true, phone: '+48221234567' });

    // ── Task 319: booking rules ─────────────────────────────────────────────
    await openSettingsSection('Zasady rezerwacji');
    await app.getByLabel('Najdalej: dni naprzód').fill('400');
    await app.getByRole('button', { name: 'Zapisz' }).click();
    await expect(app.getByRole('alert')).toContainText('Wpisz liczbę dni od 1 do 365.');
    await app.getByLabel('Najwcześniej: minut przed wizytą').fill('30');
    await app.getByLabel('Najdalej: dni naprzód').fill('90');
    await app.getByLabel('Klient może zmienić wizytę do: minut przed').fill('240');
    await app.getByRole('button', { name: '30 min', exact: true }).click();
    await expect(app.getByRole('button', { name: '30 min', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await app
      .getByRole('heading', { name: 'Zasady rezerwacji', exact: true })
      .scrollIntoViewIfNeeded();
    await shot(app, '319-business-app-booking-rules');
    await app.getByRole('button', { name: 'Zapisz' }).click();
    await expect(app.getByText('Zapisano.')).toBeVisible();
    const rules = await json<{
      minLeadMinutes: number;
      bookingHorizonDays: number;
      clientCancelDeadlineMinutes: number;
      slotStepMinutes: number;
    }>(await request.get(path, { headers: owner }));
    expect(rules).toMatchObject({
      minLeadMinutes: 30,
      bookingHorizonDays: 90,
      clientCancelDeadlineMinutes: 240,
      slotStepMinutes: 30,
    });

    // ── Task 320: questions on the last booking step ────────────────────────
    await openSettingsSection('Pytania przy rezerwacji');
    await app.getByLabel('Jak klient chce spędzić wizytę (rozmowa, cisza, odpoczynek)').click();
    await app.getByLabel('Coś do picia').click();
    await app.getByRole('button', { name: '☕ Kawa' }).click();
    await app.getByRole('button', { name: '🍵 Herbata' }).click();
    await expect(app.getByRole('button', { name: '☕ Kawa' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await app
      .getByRole('heading', { name: 'Pytania przy rezerwacji', exact: true })
      .scrollIntoViewIfNeeded();
    await shot(app, '320-business-app-booking-questions');
    await app.getByRole('button', { name: 'Zapisz' }).click();
    await expect(app.getByText('Zapisano.')).toBeVisible();
    const questions = await json<{
      askMood: boolean;
      askDrink: boolean;
      drinks: string[];
      askNote: boolean;
    }>(await request.get(path, { headers: owner }));
    expect(questions).toEqual(
      expect.objectContaining({
        askMood: false,
        askDrink: true,
        drinks: ['coffee', 'tea'],
        askNote: true,
      }),
    );

    // ── Task 321: the salon's place on the catalogue map ────────────────────
    await openSettingsSection('Dane salonu');
    await expect(app.getByText(/Salonu nie ma jeszcze na mapie katalogu/)).toBeVisible();
    await app.getByLabel('Miejsce na mapie katalogu').fill('52.23251');
    await app.getByRole('button', { name: 'Zapisz' }).click();
    await expect(app.getByRole('alert')).toContainText(
      'Wpisz dwie liczby oddzielone przecinkiem, np. 52.23251, 20.95634.',
    );
    await app.getByLabel('Miejsce na mapie katalogu').fill('52.23251, 20.95634');
    await app.getByLabel('Miejsce na mapie katalogu').scrollIntoViewIfNeeded();
    await shot(app, '321-business-app-salon-map');
    await app.getByRole('button', { name: 'Zapisz' }).click();
    await expect(app.getByText('Zapisano.')).toBeVisible();
    await expect(app.getByText(/Salonu nie ma jeszcze na mapie katalogu/)).toBeHidden();
    const place = await json<{ latitude: number; longitude: number }>(
      await request.get(path, { headers: owner }),
    );
    expect(place).toMatchObject({ latitude: 52.23251, longitude: 20.95634 });

    // ── Task 322: languages at the salon ────────────────────────────────────
    await openSettingsSection('Języki w salonie');
    await app.getByRole('checkbox', { name: 'Українська' }).click();
    await expect(app.getByRole('checkbox', { name: 'Українська' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await app
      .getByRole('heading', { name: 'Języki w salonie', exact: true })
      .scrollIntoViewIfNeeded();
    await shot(app, '322-business-app-salon-languages');
    await app.getByRole('button', { name: 'Zapisz' }).click();
    await expect(app.getByText('Zapisano.')).toBeVisible();
    const spoken = await json<{ languages: string[] }>(await request.get(path, { headers: owner }));
    expect(spoken.languages).toContain('uk');

    // ── Task 323: country (time zone) and currency ──────────────────────────
    await openSettingsSection('Kraj i waluta');
    await expect(app.getByLabel('Kraj i strefa czasowa: Polska (Warsaw)')).toBeVisible();
    await app.getByRole('button', { name: 'Zmień: Kraj i strefa czasowa' }).click();
    await app.getByLabel('Szukaj: Kraj i strefa czasowa').fill('czech');
    await expect(app.getByRole('radio')).toHaveCount(1);
    await app.getByRole('radio', { name: 'Czechy (Prague)' }).click();
    await expect(app.getByLabel('Kraj i strefa czasowa: Czechy (Prague)')).toBeVisible();
    await app.getByRole('button', { name: 'Zmień: Waluta cen' }).click();
    await app.getByLabel('Szukaj: Waluta cen').fill('CZK');
    await expect(app.getByRole('radio', { name: /^CZK/ })).toBeVisible();
    await app.getByRole('heading', { name: 'Kraj i waluta', exact: true }).scrollIntoViewIfNeeded();
    await shot(app, '323-business-app-salon-country');
    await app.getByRole('radio', { name: /^CZK/ }).click();
    await expect(app.getByLabel(/^Waluta cen: CZK/)).toBeVisible();
    await app.getByRole('button', { name: 'Zapisz' }).click();
    await expect(app.getByText('Zapisano.')).toBeVisible();
    await expect
      .poll(async () =>
        json<{ timezone: string; currency: string }>(await request.get(path, { headers: owner })),
      )
      .toMatchObject({ timezone: 'Europe/Prague', currency: 'CZK' });

    // ── Task 324: terms and privacy ─────────────────────────────────────────
    await openSettingsSection('Regulamin i prywatność');
    await expect(app.getByLabel('Regulamin rezerwacji', { exact: true })).toHaveValue(
      /Wizyta jest bezpłatna/,
    );
    await app.getByRole('button', { name: 'Wstaw szablon: Regulamin rezerwacji' }).click();
    await expect(app.getByText('Zastąpić obecny tekst szablonem?')).toBeVisible();
    await app.getByRole('button', { name: 'Zastąp', exact: true }).click();
    await expect(app.getByLabel('Regulamin rezerwacji', { exact: true })).toHaveValue(
      /^# Regulamin rezerwacji online — Gestalt Barbershop/,
    );
    await expect(app.getByText(/^Wstawiono szablon z danymi salonu/)).toBeVisible();
    await expect(app.getByText(/^Do uzupełnienia: \{[A-Z_]+\}/)).toBeVisible();
    await app
      .getByLabel('Polityka prywatności', { exact: true })
      .fill('# Prywatność\n\nAdministratorem danych jest GESTALT sp. z o.o.');
    await app
      .getByRole('heading', { name: 'Regulamin i prywatność', exact: true })
      .scrollIntoViewIfNeeded();
    await shot(app, '324-business-app-salon-legal');
    await app.getByRole('button', { name: 'Zapisz' }).click();
    await expect(app.getByText(/^Wstawiono szablon z danymi salonu/)).toBeHidden();
    await expect
      .poll(async () => {
        const legal = await json<{ bookingTerms: string; privacyPolicy: string }>(
          await request.get(path, { headers: owner }),
        );
        return [legal.bookingTerms.split('\n')[0], legal.privacyPolicy];
      })
      .toEqual([
        '# Regulamin rezerwacji online — Gestalt Barbershop',
        '# Prywatność\n\nAdministratorem danych jest GESTALT sp. z o.o.',
      ]);

    // ── Task 325: the salon's photos — one removed at once ──────────────────
    await openSettingsSection('Zdjęcia salonu');
    await expect(app.getByLabel('Zdjęcie 1', { exact: true })).toBeVisible();
    await expect(app.getByLabel('Zdjęcie 2', { exact: true })).toBeVisible();
    await app.getByRole('button', { name: 'Usuń: Zdjęcie 1' }).click();
    await expect(app.getByText('Usunąć to zdjęcie ze strony rezerwacji?')).toBeVisible();
    await app
      .getByRole('heading', { name: 'Zdjęcia salonu', exact: true })
      .scrollIntoViewIfNeeded();
    await shot(app, '325-business-app-salon-photos');
    await app.getByRole('button', { name: 'Tak, usuń: Zdjęcie 1' }).click();
    await expect(app.getByText('Zdjęcie usunięte.')).toBeVisible();
    await expect(app.getByLabel('Zdjęcie 2', { exact: true })).toBeHidden();
    await expect(app.getByLabel('Zdjęcie 1', { exact: true })).toBeVisible();
    const left = await json<{ id: string }[]>(
      await request.get(`${path}/photos`, { headers: owner }),
    );
    expect(left).toHaveLength(1);

    // ── Task 337: a photo from the gallery (the file chooser in the web preview) ──
    const chooser = app.waitForEvent('filechooser', { timeout: 15_000 });
    await app.getByRole('button', { name: '+ Dodaj zdjęcie' }).click();
    await (
      await chooser
    ).setFiles({
      name: 'krzeslo.jpg',
      mimeType: 'image/jpeg',
      buffer: await drawnPhoto(app, 'NOWE'),
    });
    await expect(app.getByText('Zdjęcie dodane', { exact: false })).toBeVisible();
    await expect(app.getByLabel('Zdjęcie 2', { exact: true })).toBeVisible();
    await app
      .getByRole('heading', { name: 'Zdjęcia salonu', exact: true })
      .scrollIntoViewIfNeeded();
    await shot(app, '337-business-app-salon-photo-added');
    const now = await json<{ contentType: string }[]>(
      await request.get(`${path}/photos`, { headers: owner }),
    );
    expect(now).toHaveLength(2);
    expect(now[1]!.contentType).toBe('image/jpeg');

    // ── A new name shows on the calendar at once ────────────────────────────
    await openSettingsSection('Dane salonu');
    await expect(email).toHaveValue('salon@example.com');
    await email.fill('');
    await save.click();
    await expect(unsaved).toBeHidden();
    expect(
      (await json<{ email: string | null }>(await request.get(path, { headers: owner }))).email,
    ).toBeNull();
    await app.getByLabel('Nazwa salonu').fill('Gestalt Barbershop Bema');
    await app.getByRole('button', { name: 'Zapisz' }).click();
    await expect(app.getByText('Zapisano.')).toBeVisible();
    await backToSettings.click();
    await app.getByRole('button', { name: '‹ Wróć', exact: true }).click();
    await app.getByRole('tab', { name: 'Kalendarz', exact: true }).click();
    await expect(app.getByText('Gestalt Barbershop Bema')).toBeVisible();
    await context.close();
  } finally {
    businessApp.server.close();
  }
});
