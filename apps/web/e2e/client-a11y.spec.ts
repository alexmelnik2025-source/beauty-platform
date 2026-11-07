import { expect, request as playwrightRequest, test, type APIResponse } from '@playwright/test';
import { waitForEmail } from './mailpit';

/**
 * Task 234: the client's pages work with a screen reader — like the cabinet (task 230): on the
 * home page, the catalogue (list and map), a salon's booking page and "Moje wizyty" every
 * visible button and link has a name. Screenshot 234 (the booking page).
 */

const PASSWORD = 'e2e-password-123';
const run = Date.now().toString(36);
const OWNER = `a11y-owner-${run}@example.com`;
const PHONE = { width: 390, height: 844 };
const n = Math.floor(Math.random() * 65_536);
const ADDRESS = { 'x-forwarded-for': `198.18.${n >> 8}.${n & 255}` };

async function json<T>(res: APIResponse): Promise<T> {
  expect(res.ok(), `${res.url()} → ${res.status()} ${await res.text()}`).toBeTruthy();
  return (res.status() === 204 ? undefined : await res.json()) as T;
}

/** A salon open for online booking (one service, one specialist). */
async function bookableSalon(baseURL: string): Promise<string> {
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
  await json(
    await api.post(`${base}/staff`, {
      headers: owner,
      data: { displayName: 'Marek', serviceIds: [service.id] },
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
  return location.slug;
}

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
