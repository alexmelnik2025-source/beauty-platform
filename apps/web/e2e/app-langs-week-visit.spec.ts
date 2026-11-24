import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { DICTIONARIES } from '../../mobile-business/src/i18n';
import { freshAddress } from './addresses';
import { waitForEmail } from './mailpit';
import { serveApp } from './mobile-app';

const zone = 'Europe/Warsaw';
const salonName = 'Studio Fryzjerskie przy Starym Rynku';

async function prepareVisits(api: APIRequestContext) {
  const address = freshAddress();
  const email = `aw-${randomUUID()}@example.com`;
  const account = { email, password: randomUUID() };
  await expect(
    await api.post('/v1/auth/register', {
      headers: address,
      data: { ...account, name: 'Salon Owner' },
    }),
  ).toBeOK();
  const mail = await waitForEmail(email, /Potwierdź adres/);
  const token = /token=([^\s&]+)/.exec(mail.text)![1]!;
  await expect(
    await api.post('/v1/auth/verify-email', {
      headers: address,
      data: { token: decodeURIComponent(token) },
    }),
  ).toBeOK();
  const login = await api.post('/v1/auth/login', {
    headers: address,
    data: { ...account, clientType: 'mobile' },
  });
  await expect(login).toBeOK();
  const { accessToken, refreshToken } = await login.json();
  const headers = { ...address, Authorization: `Bearer ${accessToken}` };
  async function create(path: string, data: Record<string, unknown>): Promise<string> {
    const response = await api.post(path, {
      headers,
      data,
    });
    await expect(response).toBeOK();
    return (await response.json()).id;
  }
  const org = await create('/v1/organizations', { name: salonName });
  const locations = `/v1/organizations/${org}/locations`;
  const location = await create(locations, {
    name: salonName,
    addressLine: 'Testowa 1',
    city: 'Warszawa',
    postalCode: '00-001',
  });
  const base = `${locations}/${location}`;
  const serviceId = await create(`${base}/services`, {
    name: 'Strzyżenie',
    priceGrosze: 8000,
    durationMinutes: 30,
  });
  const staffId = await create(`${base}/staff`, {
    displayName: 'Anna Nowak',
    serviceIds: [serviceId],
  });
  const now = new Date();
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: zone }).format(now);
  const yesterday = new Date(Date.parse(today) - 86_400_000).toISOString().slice(0, 10);
  for (const [hour, name] of [
    ['08', 'Jan'],
    ['10', 'Adam'],
  ] as const) {
    const response = await api.post(`${base}/appointments`, {
      headers,
      data: {
        serviceId,
        staffId,
        start: `${yesterday}T${hour}:00:00Z`,
        alreadyHappened: true,
        customer: { name, phone: `+486001002${hour}` },
      },
    });
    await expect(response).toBeOK();
    if (name === 'Adam') {
      const { id, version } = await response.json();
      await expect(
        await api.post(`${base}/appointments/${id}/status`, {
          headers,
          data: { version, status: 'no_show' },
        }),
      ).toBeOK();
    }
  }
  const monday = new Date(today);
  monday.setUTCDate(monday.getUTCDate() + 8 - (monday.getUTCDay() || 7));
  await create(`${base}/appointments`, {
    start: `${monday.toISOString().slice(0, 10)}T08:00:00Z`,
    serviceId,
    staffId,
    allowOutsideHours: true,
    customer: { name: 'Ewa Lis', phone: '+48600100200' },
  });
  return { monday, now, refreshToken };
}

// The Expo web bundle specifies font sizes in pixels. Scale its rules once,
// including text mounted later, and verify the setting on a rendered heading.
async function enlargeText(page: Page, heading: Locator) {
  await expect(heading).toBeVisible();
  const fontSize = () => heading.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  const original = await fontSize();
  await page.evaluate(() => {
    for (const sheet of document.styleSheets) {
      for (const rule of sheet.cssRules) {
        if (!(rule instanceof CSSStyleRule)) continue;
        for (const property of ['font-size', 'line-height']) {
          const value = rule.style.getPropertyValue(property);
          if (value.endsWith('px'))
            rule.style.setProperty(property, `${parseFloat(value) * 1.3}px`);
        }
      }
    }
  });
  expect(await fontSize()).toBeCloseTo(original * 1.3, 1);
}

async function fits(label: Locator) {
  await expect(label).toBeVisible();
  const inside = await label.evaluate((el) => {
    const box = el.getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(el);
    return (
      box.left >= 0 &&
      box.right <= 320 &&
      el.scrollWidth <= el.clientWidth + 1 &&
      [...range.getClientRects()].every(
        (line) =>
          line.left >= box.left - 1 &&
          line.right <= box.right + 1 &&
          line.top >= box.top - 1 &&
          line.bottom <= box.bottom + 1,
      )
    );
  });
  expect(inside, label.toString()).toBe(true);
}

async function sameRow(controls: Locator[]) {
  let right = 0;
  let center: number | undefined;
  for (const control of controls) {
    await fits(control);
    const box = (await control.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(right);
    const middle = box.y + box.height / 2;
    if (center !== undefined) expect(Math.abs(center - middle)).toBeLessThanOrEqual(1);
    right = box.x + box.width;
    center = middle;
  }
}

for (const [lang, locale] of [
  ['en', 'en-GB'],
  ['uk', 'uk-UA'],
  ['ru', 'ru-RU'],
] as const) {
  test.describe(locale, () => {
    test.use({ viewport: { width: 320, height: 844 }, isMobile: true, locale, timezoneId: zone });
    test('week, visit statuses and inline block errors with 130% text', async ({
      page,
      request,
    }) => {
      const { monday, now, refreshToken } = await prepareVisits(request);
      const app = await serveApp('mobile-business');
      const { day, week, visit, blocks } = DICTIONARIES[lang];
      const button = (name: string) => page.getByRole('button', { name, exact: true });
      const text = (value: string) => page.getByText(value, { exact: true });
      try {
        await page.addInitScript(
          (token) => localStorage.setItem('beauty.business.refreshToken', token),
          refreshToken,
        );
        await page.clock.setFixedTime(now);
        await page.goto(app.url);
        await button(week.open).click();
        const heading = page.getByRole('heading', { name: week.title });
        await enlargeText(page, heading);
        await button(week.next).click();
        const format = new Intl.DateTimeFormat(locale, {
          weekday: 'long',
          month: 'long',
          day: 'numeric',
          timeZone: 'UTC',
        });
        const dates = Array.from({ length: 7 }, (_, i) =>
          format.format(monday.getTime() + i * 86_400_000),
        );
        for (const date of dates) await fits(text(date));
        const range = page.getByLabel(`${dates[0]} – ${dates[6]}`, { exact: true });
        const shortDate = new Intl.DateTimeFormat(locale, {
          day: '2-digit',
          month: '2-digit',
          timeZone: 'UTC',
        });
        await expect(range).toHaveText(
          `${shortDate.format(monday)}–${shortDate.format(monday.getTime() + 6 * 86_400_000)}`,
        );
        await sameRow([button(week.back), text(salonName)]);
        await sameRow([heading, range]);
        await sameRow([button(week.previous), button(week.thisWeek), button(week.next)]);
        await text(dates[0]!).click();
        await page.getByRole('button', { name: /Ewa Lis · Strzyżenie/ }).click();
        await fits(text(visit.status.confirmed));
        await button(visit.cancel).click();
        await page.getByRole('textbox', { name: visit.reason }).fill('Zmiana planów');
        await button(visit.cancel).click();
        await button(visit.cancelYes).click();
        await fits(text(visit.status.cancelled));
        await button(visit.back).click();

        await button(`+ ${blocks.add}`).click();
        await fits(page.getByRole('heading', { name: blocks.add }));
        const end = page.getByRole('group', { name: blocks.to, exact: true });
        const earlier = button(`${blocks.to}: ${blocks.earlier}`);
        for (let step = 0; step < 4; step++) await earlier.click();
        const reason = page.getByRole('textbox', { name: blocks.reason });
        await reason.fill('   ');
        await button(blocks.save).click();
        await expect(end).toHaveAccessibleDescription(`! ${blocks.badRange}`);
        await expect(reason).toHaveAccessibleDescription(`! ${blocks.reason}`);
        await fits(page.getByRole('alert').filter({ hasText: blocks.badRange }));
        await fits(page.getByRole('alert').filter({ hasText: blocks.reason }));
        await reason.fill('Szkolenie');
        await expect(reason).toHaveAttribute('aria-invalid', 'false');
        await expect(end).toHaveAccessibleDescription(`! ${blocks.badRange}`);
        await button(`${blocks.to}: ${blocks.later}`).click();
        await expect(page.getByRole('alert')).toHaveCount(0);
        await button(blocks.repeat).click();
        await fits(text(blocks.repeatHint));
        await button(blocks.once).click();
        await button(blocks.save).click();
        await expect(text(blocks.added)).toBeVisible();

        await button(day.today).click();
        await button(day.previous).click();
        for (const [name, status] of [
          ['Jan', visit.status.completed],
          ['Adam', visit.status.no_show],
        ] as const) {
          // The till controls load above yesterday's visits, also when returning from a card.
          // Wait for the last section to render before clicking a row that it moves down.
          await expect(button(day.tillClose)).toBeVisible();
          await page.getByRole('button', { name: new RegExp(` ${name} · Strzyżenie$`) }).click();
          await expect(button(visit.back)).toBeVisible();
          await expect(text(name)).toBeVisible();
          await fits(text(status));
          await button(visit.back).click();
        }
      } finally {
        app.server.close();
      }
    });
  });
}
