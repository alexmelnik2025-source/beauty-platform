import {
  expect,
  test,
  type APIRequestContext,
  type APIResponse,
  type Locator,
  type Page,
} from '@playwright/test';
import { en } from '../../mobile-business/src/locales/en';
import { ru } from '../../mobile-business/src/locales/ru';
import { uk } from '../../mobile-business/src/locales/uk';
import { freshAddress } from './addresses';
import { waitForEmail } from './mailpit';
import { serveApp } from './mobile-app';

async function json<T>(response: APIResponse): Promise<T> {
  await expect(response).toBeOK();
  return response.json();
}

// A real service change supplies the long audit entry, including its actor.
async function createSalon(request: APIRequestContext, service: string) {
  const address = freshAddress();
  const email = `av-messages-${crypto.randomUUID()}@example.com`;
  const account = { email, password: 'e2e-password-123' };
  const actor = 'Aleksandra Konstantynopolitańczykowianeczka-Wojciechowska';
  await expect(
    await request.post('/v1/auth/register', {
      headers: address,
      data: { ...account, name: actor },
    }),
  ).toBeOK();
  const mail = await waitForEmail(email, /Potwierdź adres/);
  const token = /token=([^\s&]+)/.exec(mail.text)![1]!;
  await expect(
    await request.post('/v1/auth/verify-email', {
      data: { token: decodeURIComponent(token) },
    }),
  ).toBeOK();
  const session = await json<{ accessToken: string; refreshToken: string }>(
    await request.post('/v1/auth/login', {
      headers: address,
      data: { ...account, clientType: 'mobile' },
    }),
  );
  const headers = { Authorization: `Bearer ${session.accessToken}` };
  const org = await json<{ id: string }>(
    await request.post('/v1/organizations', { headers, data: { name: 'Salon AV' } }),
  );
  const locations = `/v1/organizations/${org.id}/locations`;
  const salon = await json<{ id: string }>(
    await request.post(locations, {
      headers,
      data: { name: 'Salon AV', addressLine: 'Bema 91', city: 'Warszawa', postalCode: '01-233' },
    }),
  );
  await expect(
    await request.post(`${locations}/${salon.id}/services`, {
      headers,
      data: { name: service, durationMinutes: 45, priceGrosze: 9000 },
    }),
  ).toBeOK();
  return { actor, refreshToken: session.refreshToken, orgId: org.id, locationId: salon.id };
}

// Expo web emits fixed pixel font sizes. Scale its text rules once per document,
// preserving the relative sizes of headings, labels, fields and newly rendered errors.
async function enlargeText(page: Page) {
  const css = await page.evaluate(() =>
    Array.from(document.styleSheets)
      .flatMap((sheet) => Array.from(sheet.cssRules))
      .filter(
        (rule): rule is CSSStyleRule =>
          rule instanceof CSSStyleRule && rule.style.fontSize.endsWith('px'),
      )
      .map(
        (rule) =>
          `${rule.selectorText} { font-size: ${parseFloat(rule.style.fontSize) * 1.3}px !important }`,
      )
      .join('\n'),
  );
  expect(css).toBeTruthy();
  await page.addStyleTag({ content: css });
}

async function expectFieldError(page: Page, field: Locator, message: string) {
  const alert = page.getByRole('alert');
  await expect(field).toHaveAttribute('aria-invalid', 'true');
  await expect(field).toHaveAccessibleDescription(message);
  await expect(alert).toHaveText(message);
  const input = await field.boundingBox();
  const error = await alert.boundingBox();
  const gap = error!.y - (input!.y + input!.height);
  expect(gap).toBeGreaterThanOrEqual(0);
  expect(gap).toBeLessThanOrEqual(8);
}

async function expectReadableLayout(page: Page) {
  const issues = await page.evaluate(() => {
    const issues: string[] = [];
    const controls = 'button, [role="button"], [role="switch"], textarea, input';
    const elements = [
      ...document.querySelectorAll<HTMLElement>(`[dir="auto"], ${controls}`),
    ].filter((el) => el.getBoundingClientRect().width > 0);
    const boxes = elements.map((el) => el.getBoundingClientRect());
    for (const [i, el] of elements.entries()) {
      const box = boxes[i]!;
      const name = (el.getAttribute('aria-label') || el.textContent || el.tagName).slice(0, 80);
      if (box.left < -1 || box.right > window.innerWidth + 1 || el.scrollWidth > el.clientWidth + 1)
        issues.push(`Horizontal overflow: ${name}`);
      if (el.matches(controls) && (box.width < 44 || box.height < 44))
        issues.push(`Small touch target: ${name} (${box.width} × ${box.height})`);
      if (el.childElementCount === 0 && el.textContent && !el.matches('textarea, input')) {
        const range = document.createRange();
        // Wrapped pre-formatted spaces can hang past the line. Measure the visible words.
        for (const node of el.childNodes) {
          if (!(node instanceof Text)) continue;
          for (const word of node.data.matchAll(/\S+/g)) {
            range.setStart(node, word.index);
            range.setEnd(node, word.index + word[0].length);
            if (
              [...range.getClientRects()].some(
                (line) =>
                  line.left < box.left - 1 ||
                  line.right > box.right + 1 ||
                  line.top < box.top - 1 ||
                  line.bottom > box.bottom + 1,
              )
            )
              issues.push(`Clipped word: ${word[0]} in ${name}`);
          }
        }
      }
      if (
        elements.slice(0, i).some((other, j) => {
          if (other.contains(el) || el.contains(other)) return false;
          const b = boxes[j]!;
          return (
            Math.min(b.right, box.right) - Math.max(b.left, box.left) > 1 &&
            Math.min(b.bottom, box.bottom) - Math.max(b.top, box.top) > 1
          );
        })
      )
        issues.push(`Overlap: ${name}`);
    }
    return issues;
  });
  expect(issues).toEqual([]);
}

const cases = [
  {
    locale: 'en-GB',
    t: en,
    service: 'Haircut for long hair with an individual consultation and evening styling',
    reminder: 'It is time for your next visit. Book your usual specialist online.',
  },
  {
    locale: 'uk-UA',
    t: uk,
    service: 'Стрижка довгого волосся з індивідуальною консультацією та вечірньою укладкою',
    reminder: 'Час планувати наступний візит. Оберіть зручний час у свого майстра.',
  },
  {
    locale: 'ru-RU',
    t: ru,
    service: 'Стрижка длинных волос с индивидуальной консультацией и вечерней укладкой',
    reminder: 'Пора планировать следующий визит. Выберите удобное время у своего мастера.',
  },
];

for (const { locale, t, service, reminder } of cases) {
  test.describe(locale, () => {
    test.use({
      locale,
      viewport: { width: 320, height: 844 },
      isMobile: true,
      baseURL: process.env.API_URL ?? 'http://localhost:4000',
    });
    test('messages, notifications and change log at 130% text size', async ({ page, request }) => {
      const salon = await createSalon(request, service);
      const app = await serveApp('mobile-business');
      try {
        await page.addInitScript((token) => {
          if (!localStorage.getItem('beauty.business.refreshToken'))
            localStorage.setItem('beauty.business.refreshToken', token);
        }, salon.refreshToken);
        await page.goto(app.url);
        const button = (name: string) => page.getByRole('button', { name, exact: true });
        const more = page.getByRole('tab', { name: t.navigation.more, exact: true });
        await more.click();
        const { messages: m, notifications: n, history: h } = t;
        await button(m.open).click();
        const heading = (name: string) => page.getByRole('heading', { name, exact: true });
        const size = await heading(m.title).evaluate((el) =>
          parseFloat(getComputedStyle(el).fontSize),
        );
        await enlargeText(page);
        expect(
          await heading(m.title).evaluate((el) => parseFloat(getComputedStyle(el).fontSize)),
        ).toBeCloseTo(size * 1.3);
        const save = button(m.save);
        const days = page.getByRole('textbox', { name: m.rebookDays });
        const template = page.getByRole('textbox', { name: m.rebookText });
        await expect(page.getByRole('switch', { name: m.rebookOn })).not.toBeChecked();
        await expect(template).toBeHidden();
        await page.getByRole('switch', { name: m.rebookOn }).check();
        await save.click();
        await expectFieldError(page, days, `! ${m.badDays}`);
        await expectReadableLayout(page);
        await days.fill('30');
        await page.getByRole('switch', { name: m.rebookText }).check();
        await save.click();
        const missing = '! ' + t.salon.missing.replace('{list}', m.rebook);
        await expectFieldError(page, template, missing);
        await expectReadableLayout(page);
        const longTemplate = Array(6).fill(reminder).join(' ');
        await template.fill(longTemplate);
        await save.click();
        await expect(page.getByRole('status')).toHaveText(m.saved);
        await button(m.back).click();
        await button(m.open).click();
        await expect(template).toHaveValue(longTemplate);
        expect(
          await template.evaluate((el) => el.scrollHeight - el.clientHeight),
        ).toBeLessThanOrEqual(1);
        await expectReadableLayout(page);
        await button(m.back).click();

        await button(n.open).click();
        await expect(heading(n.title)).toBeVisible();
        await expect(page.getByText(n.empty, { exact: true })).toBeVisible();
        await expect(button(n.readAll)).toBeHidden();
        await expectReadableLayout(page);
        await button(n.back).click();
        await page.route('**/v1/me/notifications?*', (route) =>
          route.fulfill({
            json: [
              {
                id: 'notice-av',
                organizationId: salon.orgId,
                type: 'appointment.booked',
                read: false,
                appointmentId: null,
                data: {
                  locationId: salon.locationId,
                  date: '2026-11-24',
                  time: '10:30',
                  by: 'client',
                  customerName: 'Anna',
                  serviceName: service,
                  staffName: salon.actor,
                },
              },
            ],
          }),
        );
        await button(n.open).click();
        const detail = `Anna · ${service} · ${salon.actor}`;
        await expect(page.getByText(detail, { exact: true })).toBeVisible();
        await expect(
          page.getByRole('button', { name: new RegExp(n.unread + ': ' + n.kind.booked) }),
        ).toContainText(n.byClient);
        await expect(button(n.readAll)).toBeVisible();
        await expectReadableLayout(page);
        await button(n.back).click();

        await page.route(
          '**/audit-log?*',
          (route) => {
            const url = new URL(route.request().url());
            url.searchParams.set('limit', '1');
            return route.continue({ url: url.href });
          },
          { times: 1 },
        );
        await button(h.open).click();
        await expect(button(h.more)).toBeVisible();
        await expectReadableLayout(page);
        await button(h.more).click();
        await expect(heading(h.title)).toBeVisible();
        const title = `${h.actions['service.created']}: ${service}`;
        await expect(page.getByLabel(`${title}. ${salon.actor}`, { exact: false })).toBeVisible();
        await expect(page.getByText(title, { exact: true })).toBeVisible();
        await expectReadableLayout(page);
        // The log caches the current salon; reopen it in a fresh app session.
        await page.route('**/audit-log?*', (route) =>
          route.fulfill({ json: { items: [], next: null } }),
        );
        await page.reload();
        await more.click();
        await button(h.open).click();
        await expect(page.getByText(h.empty, { exact: true })).toBeVisible();
        await enlargeText(page);
        await expect(button(h.more)).toBeHidden();
        await expectReadableLayout(page);
      } finally {
        app.server.close();
      }
    });
  });
}
