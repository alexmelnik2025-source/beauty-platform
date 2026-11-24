import {
  expect,
  test,
  type APIRequestContext,
  type APIResponse,
  type Locator,
} from '@playwright/test';
import { en } from '../../mobile-business/src/locales/en';
import { uk } from '../../mobile-business/src/locales/uk';
import { ru } from '../../mobile-business/src/locales/ru';
import { freshAddress } from './addresses';
import { waitForEmail } from './mailpit';
import { serveApp } from './mobile-app';

const ownerName = 'Alexandra Konstantynopolitańczykowianeczka-Wojciechowska';
const customer = 'Jan Kowalski';
const reward = 'Complete restorative treatment for very long colour-treated hair';
const product = 'Professional intensive conditioning and colour protection treatment';
const contact = 'aleksandra.konstantynopolitanczykowianeczka@example.com';
const price = 9_876_543;

async function json<T>(response: APIResponse): Promise<T> {
  await expect(response).toBeOK();
  return response.json();
}

async function createVisit(request: APIRequestContext) {
  const account = { email: `ax-${Date.now()}@example.com`, password: 'e2e-password-123' };
  const address = freshAddress();
  await expect(
    await request.post('/v1/auth/register', {
      headers: address,
      data: { ...account, name: ownerName },
    }),
  ).toBeOK();
  const mail = await waitForEmail(account.email, /Potwierdź adres/);
  const token = /token=([^\s&]+)/.exec(mail.text)![1]!;
  await expect(
    await request.post('/v1/auth/verify-email', {
      headers: address,
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
  const create = (path: string, data: object) => request.post(path, { headers, data });
  const org = await json<{ id: string }>(await create('/v1/organizations', { name: 'AX salon' }));
  const locations = `/v1/organizations/${org.id}/locations`;
  const salon = await json<{ id: string }>(
    await create(locations, {
      name: 'AX salon',
      addressLine: 'Bema 91',
      city: 'Warszawa',
      postalCode: '01-233',
    }),
  );
  const base = `${locations}/${salon.id}`;
  const service = await json<{ id: string }>(
    await create(`${base}/services`, { name: 'Cut', durationMinutes: 30, priceGrosze: price }),
  );
  const staff = await json<{ id: string }>(
    await create(`${base}/staff`, { displayName: 'Alex', serviceIds: [service.id] }),
  );
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Warsaw' }).format(new Date());
  const yesterday = new Date(Date.parse(today + 'T12:00:00Z') - 86_400_000);
  const visit = await json<{ id: string }>(
    await create(`${base}/appointments`, {
      serviceId: service.id,
      staffId: staff.id,
      start: yesterday.toISOString(),
      alreadyHappened: true,
      customer: { name: customer, phone: '+48600123456' },
    }),
  );
  const voucher = await json<{ code: string }>(
    await create(`${base}/gift-vouchers`, { amountGrosze: price }),
  );
  return {
    refresh: session.refreshToken,
    base,
    visitPath: `${base}/appointments/${visit.id}`,
    voucher: voucher.code,
    today,
  };
}

// Measure the rendered words, including nested labels and identifiers without spaces.
async function expectLayout(section: Locator) {
  const issues = await section.evaluate((root) => {
    const bounds = root.getBoundingClientRect();
    const issues: string[] = [];
    if (innerWidth !== 320 || bounds.left < -1 || bounds.right > 321) issues.push('section width');
    for (const control of root.querySelectorAll('input, button, [role=button]')) {
      const box = control.getBoundingClientRect();
      if (
        box.width < 44 ||
        box.height < 44 ||
        box.left < bounds.left - 1 ||
        box.right > bounds.right + 1
      )
        issues.push(control.getAttribute('aria-label') ?? 'control');
    }
    const nodes = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    while (nodes.nextNode()) {
      const node = nodes.currentNode;
      const box = node.parentElement!.getBoundingClientRect();
      for (const match of (node.textContent ?? '').matchAll(/\S+/gu)) {
        range.setStart(node, match.index);
        range.setEnd(node, match.index + match[0].length);
        if (
          Array.from(range.getClientRects()).some(
            (line) =>
              line.left < Math.max(box.left, bounds.left) - 1 ||
              line.right > Math.min(box.right, bounds.right) + 1,
          )
        )
          issues.push(match[0]);
      }
    }
    return issues;
  });
  expect(issues).toEqual([]);
}

async function expectFieldError(field: Locator, message: string) {
  await expect(field).toHaveAttribute('aria-invalid', 'true');
  await expect(field).toHaveAccessibleDescription(`! ${message}`);
  const alert = field.locator('xpath=following-sibling::*[1]').getByRole('alert');
  await expect(alert).toHaveText(`! ${message}`);
  const input = (await field.boundingBox())!;
  const gap = (await alert.boundingBox())!.y - input.y - input.height;
  expect(gap).toBeGreaterThanOrEqual(-1);
  expect(gap).toBeLessThan(16);
}

for (const [locale, t] of [
  ['en-GB', en],
  ['uk-UA', uk],
  ['ru-RU', ru],
] as const) {
  test.describe(locale, () => {
    test.use({ locale, viewport: { width: 320, height: 844 }, isMobile: true });
    test('visit sections at 130% text size', async ({ page, request }) => {
      const visit = await createVisit(request);
      const money = (grosze: number) =>
        new Intl.NumberFormat(locale, { style: 'currency', currency: 'PLN' }).format(grosze / 100);
      const button = (name: string) => page.getByRole('button', { name, exact: true });
      const w = t.waitlist;
      const c = t.visit.coupons;
      const v = t.vouchers;
      const p = t.products;
      let waiting = true;
      await page.route(`**${visit.base}/waitlist?*`, (route) =>
        route.fulfill({
          json: {
            items: waiting
              ? [
                  {
                    id: 'waiting',
                    name: ownerName,
                    serviceName: reward,
                    staffName: null,
                    email: contact,
                    phone: null,
                    date: visit.today,
                    createdAt: visit.today + 'T06:00:00Z',
                    status: 'waiting',
                    autoBook: true,
                  },
                ]
              : [],
          },
        }),
      );
      await page.route(`**${visit.base}/waitlist/waiting/remove`, (route) => {
        waiting = false;
        return route.fulfill({ status: 204 });
      });
      const app = await serveApp('mobile-business');
      try {
        await page.addInitScript(
          (token) => localStorage.setItem('beauty.business.refreshToken', token),
          visit.refresh,
        );
        await page.goto(app.url);
        await expect(page.locator('html')).toHaveAttribute('lang', locale.split('-')[0]!);
        const heading = page.getByRole('heading', { name: `${w.title} (1)`, exact: true });
        await expect(heading).toBeVisible();
        const normal = await heading.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
        await page.addStyleTag({ content: '* { -webkit-text-size-adjust: 130% !important; }' });
        expect(
          await heading.evaluate((el) => parseFloat(getComputedStyle(el).fontSize)),
        ).toBeCloseTo(normal * 1.3, 1);
        const waitlist = page.getByLabel(w.title, { exact: true });
        await expect(button(contact)).toBeVisible();
        await expectLayout(waitlist);
        await button(`${w.remove}: ${ownerName}`).click();
        await expect(waitlist.getByText(w.removeAsk.replace('{name}', ownerName))).toBeVisible();
        await expectLayout(waitlist);
        await button(w.removeYes).click();
        await expect(waitlist.getByRole('heading')).toHaveText(`${w.title} (0)`);
        await expect(waitlist.getByRole('status')).toHaveText(
          w.removed.replace('{name}', ownerName),
        );

        await button(t.day.previous).click();
        const openVisit = page.getByRole('button', { name: new RegExp(customer) }).first();
        await openVisit.click();
        await expect(page.getByText(`${t.clients.coupons} (0)`, { exact: true })).toBeVisible();
        await button(t.visit.back).click();
        await page.route(`**${visit.visitPath}/coupons`, (route) =>
          route.request().method() === 'GET'
            ? route.fulfill({
                json: {
                  tier: null,
                  applied: [],
                  available: [
                    {
                      id: 'reward',
                      name: reward,
                      code: 'AX24',
                      discountGrosze: price - 100,
                      problem: null,
                    },
                  ],
                },
              })
            : route.continue(),
        );
        await page.route(`**${visit.visitPath}/reservations`, (route) =>
          route.fulfill({
            json: {
              reservations: [
                { id: 'item', name: product, quantity: 3, totalGrosze: price, status: 'reserved' },
              ],
              toHandGrosze: price,
            },
          }),
        );
        await page.route(`**${visit.visitPath}/reservations/item/hand-over`, (route) =>
          route.fulfill({ status: 409, json: {} }),
        );
        await page.route(`**${visit.visitPath}/reservations/item/cancel`, (route) =>
          route.fulfill({ json: { reservations: [], toHandGrosze: 0 } }),
        );
        await openVisit.click();
        const coupons = page.getByRole('heading', { name: c.title }).locator('..');
        await expect(coupons.getByText(reward, { exact: false }).first()).toBeVisible();
        await expect(button(c.useOne.replace('{code}', 'AX24'))).toContainText(money(price - 100));
        const code = coupons.getByRole('textbox', { name: c.code });
        await expect(coupons.getByText(c.code, { exact: true })).toBeVisible();
        await button(c.useCode).click();
        await expectFieldError(code, c.code);
        await code.fill('UNKNOWN');
        await button(c.useCode).click();
        await expectFieldError(code, c.error.notFound);
        await expectLayout(coupons);

        const hand = page.getByTestId('visit-to-hand');
        await expect(hand.getByRole('heading')).toHaveAccessibleName(p.toHandTitle);
        await expect(hand.getByText(`${product} × 3`, { exact: true })).toBeVisible();
        await expect(hand.getByText(p.toHandTotal.replace('{amount}', money(price)))).toBeVisible();
        await button(p.toHandGiveFor.replace('{name}', product)).click();
        await expect(hand.getByRole('alert')).toHaveText(`! ${t.error.generic}`);
        await expectLayout(hand);
        await button(p.toHandCancelFor.replace('{name}', product)).click();
        await expect(hand).toHaveCount(0);

        const vouchers = page.getByTestId('visit-vouchers');
        await button(v.visitOpen).click();
        await expect(vouchers.getByText(v.noUses)).toBeVisible();
        const voucherCode = vouchers.getByRole('textbox', { name: v.code });
        const amount = vouchers.getByRole('textbox', { name: v.payAmount });
        await expect(vouchers.getByText(v.payAmount, { exact: true })).toBeVisible();
        await expect(amount).toHaveValue(locale === 'en-GB' ? '98765.43' : '98765,43');
        await button(v.pay).click();
        await expectFieldError(voucherCode, v.code);
        await voucherCode.fill('UNKNOWN');
        await button(v.pay).click();
        await expectFieldError(voucherCode, v.notFound);
        await voucherCode.fill(visit.voucher);
        await amount.fill('100000');
        await button(v.pay).click();
        await expectFieldError(amount, v.visitLeft.replace('{amount}', money(price)));
        await expectLayout(vouchers);
        await amount.fill('76543');
        await button(v.pay).click();
        await expect(vouchers.getByTestId('visit-voucher-left')).toHaveText(
          v.visitLeft.replace('{amount}', money(price - 7_654_300)),
        );
        await expect(vouchers.getByText(ownerName, { exact: false }).first()).toBeVisible();
        await expectLayout(vouchers);
      } finally {
        app.server.close();
      }
    });
  });
}
