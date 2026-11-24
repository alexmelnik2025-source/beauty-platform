import { expect, test, type APIRequestContext, type Locator } from '@playwright/test';
import { fill } from '../../mobile-business/src/i18n';
import { pl } from '../../mobile-business/src/locales/pl';
import { freshAddress } from './addresses';
import { waitForEmail } from './mailpit';
import { serveApp } from './mobile-app';

const customer = 'Katarzyna Kowalska';
const product = 'Odżywka regenerująca do włosów farbowanych';
const longCode = 'MWMWMWMWMWMWMWMWMWMW';
const price = 9_876_543;
const money = (grosze: number) =>
  new Intl.NumberFormat('pl-PL', { style: 'currency', currency: 'PLN' }).format(grosze / 100);

async function createVisit(request: APIRequestContext) {
  const account = { email: `bo-${crypto.randomUUID()}@example.com`, password: crypto.randomUUID() };
  const address = freshAddress();
  await expect(
    await request.post('/v1/auth/register', {
      headers: address,
      data: { ...account, name: 'Anna' },
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
  const login = await request.post('/v1/auth/login', {
    headers: address,
    data: { ...account, clientType: 'mobile' },
  });
  await expect(login).toBeOK();
  const { accessToken, refreshToken } = await login.json();
  async function create(path: string, data: object): Promise<string> {
    const response = await request.post(path, {
      headers: { ...address, Authorization: `Bearer ${accessToken}` },
      data,
    });
    await expect(response).toBeOK();
    return (await response.json()).id;
  }
  const org = await create('/v1/organizations', { name: 'Salon BO' });
  const locations = `/v1/organizations/${org}/locations`;
  const location = await create(locations, {
    name: 'Salon BO',
    city: 'Warszawa',
    postalCode: '00-001',
    addressLine: 'Bema 1',
  });
  const base = `${locations}/${location}`;
  const serviceId = await create(`${base}/services`, {
    name: 'Strzyżenie',
    durationMinutes: 30,
    priceGrosze: price,
  });
  const staffId = await create(`${base}/staff`, { displayName: 'Anna', serviceIds: [serviceId] });
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Warsaw' }).format(new Date());
  const start = new Date(Date.parse(today + 'T12:00:00Z') - 86_400_000).toISOString();
  const id = await create(`${base}/appointments`, {
    start,
    serviceId,
    staffId,
    alreadyHappened: true,
    allowOutsideHours: true,
    customer: { name: customer, phone: '+48600123456' },
  });
  return { today, base, path: `${base}/appointments/${id}`, refreshToken };
}

async function expectLayout(section: Locator) {
  const issues = await section.evaluate((root) => {
    const bounds = root.getBoundingClientRect();
    const issues: string[] = [];
    if (
      innerWidth !== 320 ||
      document.documentElement.scrollWidth > 320 ||
      bounds.left < 0 ||
      bounds.right > 320
    )
      issues.push('horizontal scrolling');
    for (const el of root.querySelectorAll<HTMLElement>(
      'input, textarea, button, [role=button], [dir=auto]',
    )) {
      const box = el.getBoundingClientRect();
      const name = el.getAttribute('aria-label') ?? el.textContent;
      if (
        el.matches('input, textarea, button, [role=button]') &&
        (box.height < 44 || box.width < 44)
      )
        issues.push(`small touch target: ${name}`);
      if (el instanceof HTMLTextAreaElement && el.scrollHeight > el.clientHeight + 1)
        issues.push(`clipped input: ${name}`);
      if (
        el.scrollWidth > el.clientWidth + 1 ||
        box.left < bounds.left - 1 ||
        box.right > bounds.right + 1
      )
        issues.push(`overflow: ${name}`);
    }
    return issues;
  });
  expect(issues).toEqual([]);
}

async function expectError(field: Locator, section: Locator, error: string) {
  const alert = section.getByRole('alert');
  await expect(alert).toHaveText(`! ${error}`);
  await expect(field).toHaveAccessibleDescription(`! ${error}`);
  await expect(field).toHaveAttribute('aria-invalid', 'true');
  const input = (await field.boundingBox())!;
  const gap = (await alert.boundingBox())!.y - input.y - input.height;
  expect(gap).toBeGreaterThanOrEqual(-1);
  expect(gap).toBeLessThanOrEqual(10);
}

test.use({
  viewport: { width: 320, height: 844 },
  isMobile: true,
  locale: 'pl-PL',
  baseURL: process.env.API_URL ?? 'http://localhost:4000',
});

test('visit section labels, errors and touch targets at 320 px with 130% text', async ({
  page,
  request,
}) => {
  const visit = await createVisit(request);
  const w = pl.waitlist;
  const c = pl.visit.coupons;
  const v = pl.vouchers;
  const p = pl.products;
  const button = (scope: Locator, name: string) => scope.getByRole('button', { name, exact: true });
  await page.route(`**${visit.base}/waitlist?*`, (route) =>
    route.fulfill({
      json: {
        items: [
          {
            id: 'bo',
            name: customer,
            date: visit.today,
            status: 'waiting',
            createdAt: visit.today + 'T06:00:00Z',
            serviceName: 'Strzyżenie',
            staffName: null,
            email: 'klient@example.com',
            autoBook: true,
          },
        ],
      },
    }),
  );
  const coupon = {
    id: 'bo',
    name: 'Rabat za wizytę',
    code: longCode,
    discountGrosze: 452_345,
    problem: null,
  };
  await page.route(`**${visit.path}/coupons`, (route) =>
    route.fulfill({
      json: {
        tier: null,
        applied: [coupon],
        available: [{ ...coupon, id: 'other', code: 'BO24' }],
      },
    }),
  );
  await page.route(`**${visit.path}/reservations`, (route) =>
    route.fulfill({
      json: {
        reservations: [
          { id: 'bo', name: product, quantity: 2, totalGrosze: price, status: 'reserved' },
        ],
        toHandGrosze: price,
      },
    }),
  );
  const paid = 4_321_098;
  await page.route(`**${visit.path}/gift-voucher-payments`, (route) =>
    route.fulfill({
      json: {
        totalGrosze: paid,
        payments: [
          {
            id: 'payment',
            code: 'WMWMMWMW',
            amountGrosze: paid,
            time: '12:30',
            byName: 'Anna Kowalska',
            undoneDate: null,
          },
        ],
      },
    }),
  );
  const app = await serveApp('mobile-business');
  try {
    await page.addInitScript(
      (token) => localStorage.setItem('beauty.business.refreshToken', token),
      visit.refreshToken,
    );
    await page.goto(app.url);
    const waitlist = page.getByLabel(w.title, { exact: true });
    const heading = waitlist.getByRole('heading', { name: `${w.title} (1)` });
    await expect(heading).toBeVisible();
    const size = () => heading.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    const original = await size();
    await page.addStyleTag({ content: '* { -webkit-text-size-adjust: 130% !important }' });
    expect(await size()).toBeCloseTo(original * 1.3, 1);
    expect(await waitlist.ariaSnapshot()).toContain('Auto');
    await expect(button(waitlist, fill(w.bookFor, { name: customer }))).toBeVisible();
    await expectLayout(waitlist);
    await button(waitlist, `${w.remove}: ${customer}`).click();
    await expect(button(waitlist, w.removeYes)).toBeVisible();
    await expectLayout(waitlist);
    await button(waitlist, w.removeNo).click();

    await page.getByRole('button', { name: pl.day.previous, exact: true }).click();
    await page.getByRole('button', { name: new RegExp(customer) }).click();
    const coupons = page.getByRole('heading', { name: c.title }).locator('..');
    await expect(coupons.getByText(longCode, { exact: true })).toBeVisible();
    await expect(button(coupons, fill(c.removeOne, { code: longCode }))).toBeVisible();
    await expect(button(coupons, fill(c.useOne, { code: 'BO24' }))).toContainText(
      money(coupon.discountGrosze),
    );
    const code = coupons.getByRole('textbox', { name: c.code, exact: true });
    await button(coupons, c.useCode).click();
    await expectError(code, coupons, c.code);
    await code.fill('AB');
    await expect(code).toHaveAccessibleDescription('');
    await button(coupons, c.useCode).click();
    await expectError(code, coupons, c.error.notFound);
    await code.fill(longCode);
    await expect(code).toHaveValue(longCode);
    await expectLayout(coupons);

    const hand = page.getByTestId('visit-to-hand');
    await expect(hand.getByRole('heading', { name: p.toHandTitle })).toBeVisible();
    await expect(hand.getByText(money(price), { exact: true })).toBeVisible();
    await expect(button(hand, fill(p.toHandGiveFor, { name: product }))).toBeVisible();
    await expect(button(hand, fill(p.toHandCancelFor, { name: product }))).toBeVisible();
    await expectLayout(hand);

    const vouchers = page.getByTestId('visit-vouchers');
    await expect(vouchers.getByText('WMWM-MWMW', { exact: false })).toBeVisible();
    await expect(vouchers.getByText(money(paid), { exact: true })).toBeVisible();
    await button(vouchers, v.visitOpen).click();
    const voucherCode = vouchers.getByRole('textbox', { name: v.code, exact: true });
    const amount = vouchers.getByRole('textbox', { name: v.payAmount, exact: true });
    await button(vouchers, v.pay).click();
    await expectError(voucherCode, vouchers, v.code);
    await voucherCode.fill(longCode);
    await expect(voucherCode).toHaveAccessibleDescription('');
    await amount.fill('100000');
    await button(vouchers, v.pay).click();
    await expectError(amount, vouchers, fill(v.visitLeft, { amount: money(price - paid) }));
    await expectLayout(vouchers);
    await amount.fill('98765,43');
    await expectLayout(vouchers);
    await expect(amount).toHaveAccessibleDescription('');
    await button(vouchers, pl.clients.cancel).click();
    await expect(button(vouchers, v.visitOpen)).toBeVisible();
  } finally {
    app.server.close();
  }
});
