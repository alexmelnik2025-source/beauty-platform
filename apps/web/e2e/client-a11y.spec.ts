import { expect, request as playwrightRequest, test, type APIResponse } from '@playwright/test';
import { freshAddress } from './addresses';
import { waitForEmail } from './mailpit';

/**
 * Task 234: the client's pages work with a screen reader — like the cabinet (task 230): on the
 * home page, the catalogue (list and map), a salon's booking page and "Moje wizyty" every
 * visible button and link has a name. Screenshot 234 (the booking page).
 * Task 599: on a 390 px phone the same pages, every step of booking and the visit link page
 * have no sideways scrolling, and every visible form field has a name.
 * Task 601: the salon sells a product, so the shop rows of those pages are checked as well.
 */

const PASSWORD = 'e2e-password-123';
const run = Date.now().toString(36);
const OWNER = `a11y-owner-${run}@example.com`;
const CLIENT = `a11y-client-${run}@example.com`;
const PHONE = { width: 390, height: 844 };
const n = Math.floor(Math.random() * 65_536);
const ADDRESS = { 'x-forwarded-for': `198.18.${n >> 8}.${n & 255}` };

async function json<T>(res: APIResponse): Promise<T> {
  expect(res.ok(), `${res.url()} → ${res.status()} ${await res.text()}`).toBeTruthy();
  return (res.status() === 204 ? undefined : await res.json()) as T;
}

/** A salon open for online booking (one service, one specialist). */
async function bookableSalon(baseURL: string): Promise<string> {
  if (salonSlug) return salonSlug;
  const api = await playwrightRequest.newContext({ baseURL, extraHTTPHeaders: ADDRESS });
  await json(
    await api.post('/v1/auth/register', {
      data: { email: OWNER, password: PASSWORD, name: 'A11y Owner' },
    }),
  );
  const mail = await waitForEmail(OWNER, /Potwierdź adres/);
  const token = /token=([^\s&]+)/.exec(mail.text)?.[1];
  await json(
    await api.post('/v1/auth/verify-email', { data: { token: decodeURIComponent(token!) } }),
  );
  const login = await json<{ accessToken: string }>(
    await api.post('/v1/auth/login', {
      data: { email: OWNER, password: PASSWORD, clientType: 'mobile' },
    }),
  );
  const owner = { Authorization: `Bearer ${login.accessToken}` };
  const org = await json<{ id: string }>(
    await api.post('/v1/organizations', { headers: owner, data: { name: `A11y Barber ${run}` } }),
  );
  const location = await json<{ id: string; slug: string }>(
    await api.post(`/v1/organizations/${org.id}/locations`, {
      headers: owner,
      data: {
        name: `A11y Barber ${run}`,
        addressLine: 'ul. Puławska 1',
        city: 'Warszawa',
        postalCode: '02-515',
        onlineBookingEnabled: true,
        // The nearest time is soon: the client may still change it (task 599, "Zmień termin").
        clientCancelDeadlineMinutes: 0,
        bookingTerms: '# Regulamin\n\nWizyta jest bezpłatna do odwołania.',
        privacyPolicy: '# Prywatność\n\nAdministratorem danych jest salon.',
      },
    }),
  );
  const base = `/v1/organizations/${org.id}/locations/${location.id}`;
  const service = await json<{ id: string }>(
    await api.post(`${base}/services`, {
      headers: owner,
      data: { name: 'Strzyżenie męskie', durationMinutes: 45, priceGrosze: 9000, bufferMinutes: 0 },
    }),
  );
  const marek = await json<{ id: string }>(
    await api.post(`${base}/staff`, {
      headers: owner,
      data: { displayName: 'Marek', serviceIds: [service.id] },
    }),
  );
  await json(
    await api.put(`${base}/staff/${marek.id}/working-hours`, {
      headers: owner,
      data: {
        days: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
          weekday,
          intervals: [{ start: '08:00', end: '20:00' }],
        })),
      },
    }),
  );
  // Task 601: a product in the salon's shop, so the folded "Produkty salonu" row, "Dodać coś do
  // wizyty?" after booking and the visit link's products are checked too.
  await json(
    await api.post(`${base}/products`, {
      headers: owner,
      data: { name: 'Pomada matowa', priceGrosze: 4900, stockQuantity: 5, inSalonShop: true },
    }),
  );
  // Online booking ends with the test: the catalogue tests count their own salons.
  const saved = await json<{ version: number }>(await api.get(base, { headers: owner }));
  const off = async () =>
    json(
      await api.patch(base, {
        headers: owner,
        data: { version: saved.version, onlineBookingEnabled: false },
      }),
    );
  cleanups.push(async () => {
    await off();
    await api.dispose();
  });
  salonSlug = location.slug;
  return location.slug;
}

let salonSlug: string | undefined;
const cleanups: (() => Promise<unknown>)[] = [];
test.afterAll(async () => {
  for (const cleanup of cleanups) await cleanup();
});

/** Visible buttons and links without a name a screen reader can say. */
async function unnamedControls(page: import('@playwright/test').Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll('button, [role="button"], a[href]')]
      .filter((el) => el.getClientRects().length > 0)
      .filter((el) => {
        const label = [
          el.getAttribute('aria-label'),
          el.getAttribute('aria-labelledby') ? 'labelled' : null,
          el.getAttribute('title'),
          el.textContent,
        ]
          .map((text) => (text ?? '').trim())
          .find(Boolean);
        const picture = el.querySelector('img[alt]:not([alt=""]), svg[aria-label]');
        return !label && !picture;
      })
      .map((el) => el.outerHTML.slice(0, 160)),
  );
}

test('every button and link on the client pages has a name (task 234)', async ({
  browser,
  baseURL,
}) => {
  const slug = await bookableSalon(baseURL!);
  for (const viewport of [PHONE, { width: 1280, height: 900 }]) {
    const context = await browser.newContext({ viewport, locale: 'pl-PL' });
    const page = await context.newPage();
    for (const path of ['/pl', '/pl/salons', `/pl/b/${slug}`, '/pl/c']) {
      await page.goto(path);
      await page.waitForLoadState('networkidle');
      expect(await unnamedControls(page), `${path} (${viewport.width}px)`).toEqual([]);
    }
    if (viewport === PHONE) {
      await page.goto(`/pl/b/${slug}`);
      await page.waitForLoadState('networkidle');
      await page.screenshot({ path: 'e2e/screenshots/234-client-booking-names.png' });
    }
    await context.close();
  }
});

/** What sticks out past the right edge of the screen (the page scrolls sideways), if anything. */
async function sideways(page: import('@playwright/test').Page): Promise<string[]> {
  return page.evaluate(() => {
    const width = document.documentElement.clientWidth;
    if (document.documentElement.scrollWidth <= width + 1) return [];
    return [...document.body.querySelectorAll('*')]
      .filter((el) => el.getBoundingClientRect().right > width + 1)
      .slice(-5)
      .map((el) => el.outerHTML.slice(0, 160));
  });
}

/** Visible form fields without a name a screen reader can say (a label, aria-label, title). */
async function unnamedFields(page: import('@playwright/test').Page): Promise<string[]> {
  return page.evaluate(() =>
    [
      ...document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
        'input:not([type="hidden"]), select, textarea',
      ),
    ]
      .filter((el) => el.getClientRects().length > 0)
      .filter((el) => {
        const labelled = [...(el.labels ?? [])].some((label) => label.textContent?.trim());
        return (
          !labelled &&
          !el.getAttribute('aria-label')?.trim() &&
          !el.getAttribute('aria-labelledby') &&
          !el.getAttribute('title')?.trim()
        );
      })
      .map((el) => el.outerHTML.slice(0, 160)),
  );
}

async function phoneCheck(page: import('@playwright/test').Page, step: string) {
  await page.waitForLoadState('networkidle');
  expect(await sideways(page), `${step}: sideways scrolling at 390 px`).toEqual([]);
  expect(await unnamedFields(page), `${step}: fields without a name`).toEqual([]);
  expect(await unnamedControls(page), `${step}: buttons without a name`).toEqual([]);
}

test('a 390 px phone: no sideways scrolling, every field has a name (task 599)', async ({
  browser,
  baseURL,
}) => {
  const slug = await bookableSalon(baseURL!);
  const context = await browser.newContext({
    viewport: PHONE,
    locale: 'pl-PL',
    isMobile: true,
    hasTouch: true,
    extraHTTPHeaders: freshAddress(),
  });
  const page = await context.newPage();
  for (const path of ['/pl', '/pl/salons', '/pl/c']) {
    await page.goto(path);
    await phoneCheck(page, path);
  }

  // Booking step by step: services → times → details → code → booked.
  await page.goto(`/pl/b/${slug}`);
  await phoneCheck(page, 'services');
  const productsRow = page.getByRole('button', { name: 'Produkty salonu (1)' });
  await productsRow.click();
  await expect(page.getByTestId('salon-products').getByText('Pomada matowa')).toBeVisible();
  await phoneCheck(page, 'services, Produkty salonu open');
  await productsRow.click();
  await page
    .getByRole('button', { name: /Strzyżenie/ })
    .first()
    .click();
  const times = page.locator('.times button').first();
  const marek = page.getByRole('button', { name: /Marek/ });
  await expect(times.or(marek).first()).toBeVisible();
  if (await marek.isVisible()) {
    await phoneCheck(page, 'specialists');
    await marek.click();
  }
  await expect(times).toBeVisible();
  await phoneCheck(page, 'times');
  await times.click();
  await expect(page.getByLabel('Imię i nazwisko')).toBeVisible();
  await phoneCheck(page, 'details');
  await page.getByLabel('Imię i nazwisko').fill('Anna Kowalska');
  await page.getByLabel('Telefon').fill('600 100 299');
  await page.getByLabel('E-mail').fill(CLIENT);
  await page.getByLabel(/Akceptuję regulamin rezerwacji/).check();
  await page.getByRole('button', { name: 'Wyślij kod' }).click();
  const codeMail = await waitForEmail(CLIENT, /Kod potwierdzenia/);
  await expect(page.getByLabel('Kod z e-maila')).toBeVisible();
  await phoneCheck(page, 'code');
  await page.getByLabel('Kod z e-maila').fill(/\b(\d{6})\b/.exec(codeMail.text)![1]!);
  await page.getByRole('button', { name: 'Potwierdź wizytę' }).click();
  await expect(page.getByRole('heading', { name: 'Do zobaczenia!' })).toBeVisible();
  await phoneCheck(page, 'booked');
  const offer = page.getByTestId('booked-products');
  await offer.getByRole('button', { name: '+ Dodaj produkt do tej wizyty' }).click();
  await expect(offer.getByRole('button', { name: /^Odbiorę przy wizycie/ })).toHaveCount(1);
  await phoneCheck(page, 'booked, Dodać coś do wizyty open');

  // The visit link from the email, and its "Zmień termin" with the times.
  const confirmation = await waitForEmail(CLIENT, /Wizyta potwierdzona/);
  await page.goto(/(\/pl\/m\/\S+)/.exec(confirmation.text)![1]!);
  await expect(page.getByText('Potwierdzona')).toBeVisible();
  await phoneCheck(page, 'visit link');
  await page.getByRole('button', { name: 'Zmień termin' }).click();
  await expect(page.getByRole('region', { name: 'Zmień termin' })).toBeVisible();
  await phoneCheck(page, 'visit link, Zmień termin');
  await page.screenshot({ path: 'e2e/screenshots/599-phone-visit-reschedule.png', fullPage: true });
  await context.close();
});
