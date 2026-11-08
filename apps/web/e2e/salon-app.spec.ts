import { expect, test, type APIResponse, type Page } from '@playwright/test';
import { waitForEmail } from './mailpit';
import { serveApp } from './mobile-app';

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
 * (screenshot 324).
 */

const PASSWORD = 'e2e-password-123';
const run = Date.now().toString(36);
const OWNER = `salon-app-owner-${run}@example.com`;
const PHONE = { width: 390, height: 844 };
// A sign-up address of its own (reserved for tests, RFC 2544): the API allows 10 sign-ups an hour from one.
const n = Math.floor(Math.random() * 65_536);
const ADDRESS = { 'x-forwarded-for': `198.18.${n >> 8}.${n & 255}` };

const shot = (page: Page, name: string) => page.screenshot({ path: `e2e/screenshots/${name}.png` });

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

    // ── "Salon": phone without the country code, a description ──────────────
    await app.getByRole('button', { name: 'Salon', exact: true }).click();
    await expect(app.getByRole('heading', { name: 'Salon', exact: true })).toBeVisible();
    await expect(app.getByLabel('Nazwa salonu')).toHaveValue('Gestalt Barbershop');
    await app.getByLabel('Telefon salonu').fill('22 123 45 67');
    await app.getByLabel('O salonie').fill('Strzyżemy od 2015 roku. Kawa gratis.');
    await shot(app, '131-business-app-salon');
    await app.getByRole('button', { name: 'Zapisz' }).click();
    await expect(app.getByText('Zapisano.')).toBeVisible();
    const saved = await json<{ phone: string; description: string; version: number }>(
      await request.get(path, { headers: owner }),
    );
    expect(saved.phone).toBe('+48221234567');
    expect(saved.description).toBe('Strzyżemy od 2015 roku. Kawa gratis.');

    // ── Online booking needs the terms first ────────────────────────────────
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
    await expect(app.getByText('Zasady rezerwacji')).toBeVisible();
    await app.getByLabel('Najdalej: dni naprzód').fill('400');
    await app.getByRole('button', { name: 'Zapisz' }).click();
    await expect(app.getByText('Wpisz liczbę dni od 1 do 365.')).toBeVisible();
    await app.getByLabel('Najwcześniej: minut przed wizytą').fill('30');
    await app.getByLabel('Najdalej: dni naprzód').fill('90');
    await app.getByLabel('Klient może zmienić wizytę do: minut przed').fill('240');
    await app.getByRole('button', { name: '30 min', exact: true }).click();
    await expect(app.getByRole('button', { name: '30 min', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await app.getByText('Zasady rezerwacji').scrollIntoViewIfNeeded();
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
    await expect(app.getByText('Pytania przy rezerwacji')).toBeVisible();
    await app.getByLabel('Jak klient chce spędzić wizytę (rozmowa, cisza, odpoczynek)').click();
    await app.getByLabel('Coś do picia').click();
    await app.getByRole('button', { name: '☕ Kawa' }).click();
    await app.getByRole('button', { name: '🍵 Herbata' }).click();
    await expect(app.getByRole('button', { name: '☕ Kawa' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await app.getByText('Pytania przy rezerwacji').scrollIntoViewIfNeeded();
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
    await expect(app.getByText(/Salonu nie ma jeszcze na mapie katalogu/)).toBeVisible();
    await app.getByLabel('Miejsce na mapie katalogu').fill('52.23251');
    await app.getByRole('button', { name: 'Zapisz' }).click();
    await expect(
      app.getByText('Wpisz dwie liczby oddzielone przecinkiem, np. 52.23251, 20.95634.'),
    ).toBeVisible();
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
    await app.getByRole('checkbox', { name: 'Українська' }).click();
    await expect(app.getByRole('checkbox', { name: 'Українська' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await app.getByText('Języki w salonie').scrollIntoViewIfNeeded();
    await shot(app, '322-business-app-salon-languages');
    await app.getByRole('button', { name: 'Zapisz' }).click();
    await expect(app.getByText('Zapisano.')).toBeVisible();
    const spoken = await json<{ languages: string[] }>(await request.get(path, { headers: owner }));
    expect(spoken.languages).toContain('uk');

    // ── Task 323: country (time zone) and currency ──────────────────────────
    await expect(app.getByLabel('Kraj i strefa czasowa: Polska (Warsaw)')).toBeVisible();
    await app.getByRole('button', { name: 'Zmień: Kraj i strefa czasowa' }).click();
    await app.getByLabel('Szukaj: Kraj i strefa czasowa').fill('czech');
    await expect(app.getByRole('radio')).toHaveCount(1);
    await app.getByRole('radio', { name: 'Czechy (Prague)' }).click();
    await expect(app.getByLabel('Kraj i strefa czasowa: Czechy (Prague)')).toBeVisible();
    await app.getByRole('button', { name: 'Zmień: Waluta cen' }).click();
    await app.getByLabel('Szukaj: Waluta cen').fill('CZK');
    await expect(app.getByRole('radio', { name: /^CZK/ })).toBeVisible();
    await app.getByText('Kraj i waluta').scrollIntoViewIfNeeded();
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
    await expect(app.getByText(/^Do uzupełnienia: .*\{NAZWA_FIRMY\}/)).toBeVisible();
    await app
      .getByLabel('Polityka prywatności', { exact: true })
      .fill('# Prywatność\n\nAdministratorem danych jest GESTALT sp. z o.o.');
    await app.getByText('Regulamin i prywatność', { exact: true }).scrollIntoViewIfNeeded();
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

    // ── A new name shows on the calendar at once ────────────────────────────
    await app.getByLabel('Nazwa salonu').fill('Gestalt Barbershop Bema');
    await app.getByRole('button', { name: 'Zapisz' }).click();
    await expect(app.getByText('Zapisano.')).toBeVisible();
    await app.getByRole('button', { name: '‹ Wróć' }).click();
    await expect(app.getByText('Gestalt Barbershop Bema')).toBeVisible();
    await context.close();
  } finally {
    businessApp.server.close();
  }
});
