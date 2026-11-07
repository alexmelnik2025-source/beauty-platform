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
 * Task 230: the cabinet with the keyboard. The visit in the calendar opens with Enter, the card
 * is a named dialog with the focus inside, Tab does not leave it, Escape closes it and the focus
 * returns to the visit (screenshot 230). No button or link on the main cabinet pages is without
 * a name a screen reader can say.
 */

const PASSWORD = 'e2e-password-123';
const run = Date.now().toString(36);
const OWNER = `kbd-owner-${run}@example.com`;
const DESKTOP = { width: 1440, height: 900 };

const shot = (page: Page, name: string) => page.screenshot({ path: `e2e/screenshots/${name}.png` });

async function json<T>(res: APIResponse): Promise<T> {
  expect(res.ok(), `${res.url()} → ${res.status()} ${await res.text()}`).toBeTruthy();
  return (res.status() === 204 ? undefined : await res.json()) as T;
}

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
    await api.post('/v1/auth/login', {
      headers: freshAddress(),
      data: { email, password: PASSWORD, clientType: 'mobile' },
    }),
  );
  return { Authorization: `Bearer ${login.accessToken}` };
}

test('the visit card works with the keyboard; buttons have names', async ({ browser, request }) => {
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
  const service = await json<{ id: string }>(
    await request.post(`${base}/services`, {
      headers: owner,
      data: { name: 'Strzyżenie męskie', durationMinutes: 45, priceGrosze: 9000, bufferMinutes: 0 },
    }),
  );
  const staff = await json<{ id: string }>(
    await request.post(`${base}/staff`, {
      headers: owner,
      data: { displayName: 'Ilian', serviceIds: [service.id] },
    }),
  );
  // Tomorrow at 10:00 UTC — a visit to open from the calendar.
  const tomorrow = new Date(Date.now() + 86_400_000);
  const booked = await json<{ id: string; date: string }>(
    await request.post(`${base}/appointments`, {
      headers: owner,
      data: {
        serviceId: service.id,
        staffId: staff.id,
        start: new Date(
          Date.UTC(tomorrow.getUTCFullYear(), tomorrow.getUTCMonth(), tomorrow.getUTCDate(), 10),
        ).toISOString(),
        allowOutsideHours: true,
        customer: {
          name: 'Jan Kowalski',
          phone: '+48600000230',
          email: `jan-${run}@example.com`,
        },
      },
    }),
  );

  const context = await browser.newContext({ viewport: DESKTOP, locale: 'pl-PL' });
  const page = await context.newPage();
  await page.goto('/pl/login');
  await page.getByLabel('E-mail').fill(OWNER);
  await page.getByLabel('Hasło').fill(PASSWORD);
  await page.getByRole('button', { name: 'Zaloguj się' }).click();
  await page.waitForURL(/\/pl\/app\/calendar/);
  await page.goto(`/pl/app/calendar?date=${booked.date}`);

  const visit = page.getByRole('button', { name: /Jan Kowalski/ });
  await visit.focus();
  await page.keyboard.press('Enter');
  const card = page.getByRole('dialog');
  await expect(card).toBeVisible();
  await expect(card).toHaveAccessibleName(/.+/);
  await expect(card).toBeFocused();
  // Tab goes round inside the card and never to the calendar behind it.
  for (let i = 0; i < 25; i++) {
    await page.keyboard.press('Tab');
    const inside = await card.evaluate((el) => el.contains(document.activeElement));
    expect(inside, `Tab ${i + 1} left the card`).toBe(true);
  }
  await page.keyboard.press('Shift+Tab');
  expect(await card.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  await shot(page, '230-keyboard-visit-card');
  await page.keyboard.press('Escape');
  await expect(card).toBeHidden();
  await expect(visit).toBeFocused();

  // Every button and link on the main cabinet pages has a name for a screen reader.
  for (const path of [
    `/pl/app/calendar?date=${booked.date}`,
    '/pl/app/clients',
    '/pl/app/reports',
    '/pl/app/services',
    '/pl/app/team',
  ]) {
    await page.goto(path);
    await page.waitForLoadState('networkidle');
    const unnamed = await page.evaluate(() =>
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
    expect(unnamed, `${path}: buttons or links without a name`).toEqual([]);
  }
  await context.close();
});
