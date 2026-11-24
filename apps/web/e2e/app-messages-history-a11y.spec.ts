import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { pl } from '../../mobile-business/src/locales/pl';
import { freshAddress } from './addresses';
import { waitForEmail } from './mailpit';
import { openBusinessMenu, serveApp } from './mobile-app';

const actor = 'Aleksandra Konstantynopolitańczykowianeczka-Wojciechowska';
const service = 'Konsultacja i indywidualna stylizacja długich włosów z pielęgnacją';
const reminder = 'Zapraszamy na kolejną wizytę. Prosimy wybrać dogodny termin i godzinę.';

async function createSalon(api: APIRequestContext) {
  const address = freshAddress();
  const account = { email: `bl-${crypto.randomUUID()}@example.com`, password: crypto.randomUUID() };
  const register = await api.post('/v1/auth/register', {
    headers: address,
    data: { ...account, name: actor },
  });
  await expect(register).toBeOK();
  const mail = await waitForEmail(account.email, /Potwierdź adres/);
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
  const post = async (url: string, data: Record<string, unknown>) => {
    const result = await api.post(url, { headers, data });
    await expect(result).toBeOK();
    return (await result.json()).id as string;
  };
  const orgId = await post('/v1/organizations', { name: 'Salon BL' });
  const locations = `/v1/organizations/${orgId}/locations`;
  const locationId = await post(locations, {
    name: 'Salon BL',
    addressLine: 'Bema 91',
    city: 'Warszawa',
    postalCode: '01-233',
  });
  await post(`${locations}/${locationId}/services`, {
    name: service,
    durationMinutes: 45,
    priceGrosze: 9000,
  });
  return { address, refreshToken, orgId, locationId };
}

async function enlargeText(page: Page, sample: Locator) {
  const fontSize = () => sample.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  const before = await fontSize();
  // Expo exports pixel-based text styles. Keep padding and viewport dimensions intact.
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
  expect(await fontSize()).toBeCloseTo(before * 1.3, 1);
}

async function expectWrapped(text: Locator) {
  await expect(text).toBeVisible();
  const fits = await text.evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    const lines = [...range.getClientRects()];
    const box = el.getBoundingClientRect();
    return (
      lines.length > 1 &&
      lines.every((line) => line.top >= box.top - 1 && line.bottom <= box.bottom + 1)
    );
  });
  expect(fits, text.toString()).toBe(true);
}

async function expectLayout(page: Page) {
  const failures = await page.evaluate(() => {
    const issues: string[] = [];
    if (innerWidth !== 320 || document.documentElement.scrollWidth !== 320)
      issues.push('page width');
    for (const el of document.querySelectorAll<HTMLElement>('body *')) {
      const box = el.getBoundingClientRect();
      if (!box.width || !box.height) continue;
      const label = el.getAttribute('aria-label') ?? el.tagName;
      if (box.left < -1 || box.right > 321 || el.scrollWidth > el.clientWidth + 1)
        issues.push(`overflow: ${label}`);
      if (
        el.matches('button, [role=button], input, textarea') &&
        (box.width < 44 || box.height < 44)
      )
        issues.push(`touch target: ${label}`);
    }
    return issues;
  });
  expect(failures).toEqual([]);
}

test.use({
  viewport: { width: 320, height: 640 },
  isMobile: true,
  locale: 'pl-PL',
  baseURL: process.env.API_URL ?? 'http://localhost:4000',
});

test('message controls and complete notification and history rows at 130% on a 320 px screen', async ({
  page,
  request,
}) => {
  const salon = await createSalon(request);
  const app = await serveApp('mobile-business');
  const { messages: m, notifications: n, history: h } = pl;
  const button = (name: string) => page.getByRole('button', { name, exact: true });
  try {
    await page.setExtraHTTPHeaders(salon.address);
    await page.addInitScript(
      (token) => localStorage.setItem('beauty.business.refreshToken', token),
      salon.refreshToken,
    );
    await page.goto(app.url);
    await openBusinessMenu(page, m.open);
    await enlargeText(page, page.getByRole('heading', { name: m.title }));
    const choices = page.getByRole('group', { name: m.reminder });
    await choices.getByRole('button', { name: m.reminderNone }).click();
    await expect(choices.getByRole('button', { pressed: true })).toHaveAccessibleName(
      m.reminderNone,
    );
    await expect(
      page.getByRole('group', { name: m.hold }).getByRole('button', { name: m.holdOff }),
    ).toBeVisible();
    await page.getByRole('switch', { name: m.rebookOn }).check();
    await expect(page.getByRole('textbox', { name: m.rebookDays })).toBeVisible();
    await page.getByRole('switch', { name: m.rebookText }).check();
    const field = page.getByRole('textbox', { name: m.rebookText });
    const longText = Array(6).fill(reminder).join(' ');
    await field.fill(longText);
    await expect(field).toHaveValue(longText);
    expect(await field.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeLessThanOrEqual(1);
    await expectLayout(page);
    await button(m.back).click();

    // A cancelled visit can be marked as read but has no visit card to open afterwards.
    await page.route('**/v1/me/notifications?*', (route) =>
      route.fulfill({
        json: [
          {
            id: 'cancelled-bl',
            organizationId: salon.orgId,
            appointmentId: null,
            read: false,
            type: 'appointment.cancelled',
            data: {
              locationId: salon.locationId,
              date: '2026-11-24',
              time: '10:30',
              by: 'client',
              customerName: 'Anna',
              serviceName: service,
              staffName: actor,
            },
          },
        ],
      }),
    );
    await page.route('**/v1/me/notifications/read', (route) =>
      route.fulfill({ json: { updated: 1 } }),
    );
    await openBusinessMenu(page, n.open);
    const inbox = page.getByRole('list', { name: n.title });
    const summary = `${n.kind.cancelled}, 10:30, Anna · ${service} · ${actor}, wtorek, 24 listopada, ${n.byClient}`;
    const unread = inbox.getByRole('button', { name: `${n.unread}: ${summary}`, exact: true });
    await expect(unread).toBeVisible();
    await expect(button(n.readAll)).toBeVisible();
    await expectWrapped(unread.getByText(`Anna · ${service} · ${actor}`, { exact: true }));
    await expectLayout(page);
    await unread.click();
    await expect(inbox.getByRole('listitem', { name: summary, exact: true })).toBeVisible();
    await expect(unread).toHaveCount(0);
    await expect(button(n.readAll)).toHaveCount(0);
    await button(n.back).click();

    await openBusinessMenu(page, h.open);
    const title = `${h.actions['service.created']}: ${service}`;
    const row = page.getByRole('list', { name: h.title }).getByRole('listitem', {
      name: new RegExp(`^${title}\\. ${actor} · .+\\d{4}.*\\d{2}:\\d{2}$`),
    });
    await expect(row).toBeVisible();
    await expectWrapped(row.getByText(title, { exact: true }));
    await expectLayout(page);
  } finally {
    app.server.close();
  }
});
