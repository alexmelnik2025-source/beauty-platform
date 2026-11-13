import {
  expect,
  test,
  type APIRequestContext,
  type APIResponse,
  type Page,
} from '@playwright/test';
import { freshAddress } from './addresses';
import { waitForEmail } from './mailpit';

/**
 * Task 386: the cabinet works with a screen reader — like the client pages (task 234): on every
 * page of the owner's menu (calendar, clients, services, team, reports, reviews, settings…) each
 * visible button and link has a name, on a phone and on a computer. Screenshot 386 (the menu).
 */

const PASSWORD = 'e2e-password-123';
const run = Date.now().toString(36);
const OWNER = `cabinet-a11y-${run}@example.com`;
const OWNER_IP = freshAddress();
const PHONE = { width: 390, height: 844 };

const PAGES = [
  'calendar',
  'clients',
  'services',
  'team',
  'reports',
  'reviews',
  'loyalty',
  'happy-hours',
  'waitlist',
  'cancellation-guard',
  'history',
  'notifications',
  'settings',
  'more',
];

async function json<T>(res: APIResponse): Promise<T> {
  expect(res.ok(), `${res.url()} → ${res.status()} ${await res.text()}`).toBeTruthy();
  return (res.status() === 204 ? undefined : await res.json()) as T;
}

/** The owner with a salon: one service, one specialist (online booking stays off). */
async function ownerWithSalon(api: APIRequestContext): Promise<void> {
  await json(
    await api.post('/v1/auth/register', {
      headers: freshAddress(),
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
      headers: freshAddress(),
      data: { email: OWNER, password: PASSWORD, clientType: 'mobile' },
    }),
  );
  const owner = { Authorization: `Bearer ${login.accessToken}` };
  const org = await json<{ id: string }>(
    await api.post('/v1/organizations', { headers: owner, data: { name: `A11y Kabinet ${run}` } }),
  );
  const location = await json<{ id: string }>(
    await api.post(`/v1/organizations/${org.id}/locations`, {
      headers: owner,
      data: {
        name: `A11y Kabinet ${run}`,
        addressLine: 'ul. Puławska 1',
        city: 'Warszawa',
        postalCode: '02-515',
      },
    }),
  );
  const base = `/v1/organizations/${org.id}/locations/${location.id}`;
  const service = await json<{ id: string }>(
    await api.post(`${base}/services`, {
      headers: owner,
      data: { name: 'Strzyżenie męskie', durationMinutes: 45, priceGrosze: 9000 },
    }),
  );
  await json(
    await api.post(`${base}/staff`, {
      headers: owner,
      data: { displayName: 'Marek', serviceIds: [service.id] },
    }),
  );
}

/** Visible buttons and links without a name a screen reader can say (as in task 234). */
async function unnamedControls(page: Page): Promise<string[]> {
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

test('every button and link on the cabinet pages has a name (task 386)', async ({
  browser,
  request,
}) => {
  test.setTimeout(180_000);
  await ownerWithSalon(request);
  for (const viewport of [PHONE, { width: 1280, height: 900 }]) {
    const context = await browser.newContext({
      viewport,
      locale: 'pl-PL',
      timezoneId: 'Europe/Warsaw',
      extraHTTPHeaders: OWNER_IP,
    });
    const page = await context.newPage();
    await page.goto('/pl/login');
    await page.getByLabel('E-mail').fill(OWNER);
    await page.getByLabel('Hasło').fill(PASSWORD);
    await page.getByRole('button', { name: 'Zaloguj się' }).click();
    await page.waitForURL(/\/pl\/app\//);
    for (const path of PAGES) {
      await page.goto(`/pl/app/${path}`);
      await page.waitForLoadState('networkidle');
      expect(await unnamedControls(page), `/pl/app/${path} (${viewport.width}px)`).toEqual([]);
    }
    if (viewport === PHONE) {
      await page.goto('/pl/app/more');
      await page.waitForLoadState('networkidle');
      await page.screenshot({ path: 'e2e/screenshots/386-cabinet-names.png' });
    }
    await context.close();
  }
});
