import {
  expect,
  test,
  type APIRequestContext,
  type APIResponse,
  type Locator,
} from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { fill } from '../../mobile-business/src/i18n';
import { en } from '../../mobile-business/src/locales/en';
import { uk } from '../../mobile-business/src/locales/uk';
import { ru } from '../../mobile-business/src/locales/ru';
import { freshAddress } from './addresses';
import { waitForEmail } from './mailpit';
import { serveApp } from './mobile-app';

const productName = 'Professional UltraRestorativeColourProtectionConditioner for long hair';
const supplier = 'Laboratorium Profesjonalnej Pielęgnacji Włosów i Skóry Głowy';
const price = 9_876_543;
const barcode = '5901234567893';

async function json<T>(response: APIResponse): Promise<T> {
  await expect(response).toBeOK();
  return response.json();
}

async function seedSale(request: APIRequestContext) {
  const account = { email: `bi-${randomUUID()}@example.com`, password: randomUUID() };
  const address = freshAddress();
  await expect(
    await request.post('/v1/auth/register', {
      headers: address,
      data: { ...account, name: 'Alex' },
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
  const owner = { Authorization: `Bearer ${session.accessToken}` };
  const org = await json<{ id: string }>(
    await request.post('/v1/organizations', { headers: owner, data: { name: 'BI salon' } }),
  );
  const location = await json<{ id: string }>(
    await request.post(`/v1/organizations/${org.id}/locations`, {
      headers: owner,
      data: {
        name: 'Salon produktów',
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
      data: { name: 'Strzyżenie', durationMinutes: 30, priceGrosze: 9000 },
    }),
  );
  const staff = await json<{ id: string }>(
    await request.post(`${base}/staff`, {
      headers: owner,
      data: { displayName: 'Anna', serviceIds: [service.id] },
    }),
  );
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Warsaw' }).format(new Date());
  const yesterday = new Date(Date.parse(today) - 86_400_000).toISOString().slice(0, 10);
  const visit = await json<{ id: string }>(
    await request.post(`${base}/appointments`, {
      headers: owner,
      data: {
        serviceId: service.id,
        staffId: staff.id,
        start: `${yesterday}T10:00:00Z`,
        customer: { name: 'Jan Nowak', phone: '+48600000477' },
        alreadyHappened: true,
        allowOutsideHours: true,
      },
    }),
  );

  await json(
    await request.post(`${base}/products`, {
      headers: owner,
      data: {
        name: productName,
        priceGrosze: price,
        stockQuantity: 2,
        barcode,
        supplier,
      },
    }),
  );
  return { refresh: session.refreshToken, base, owner, visitId: visit.id };
}

async function expectFits(section: Locator) {
  await expect(section).toBeVisible();
  const overflow = await section.evaluate((root) => {
    const bounds = root.getBoundingClientRect();
    const outside = (r: DOMRect) =>
      r.left < Math.max(0, bounds.left) - 1 || r.right > Math.min(innerWidth, bounds.right) + 1;
    const errors: string[] = [];
    for (const control of root.querySelectorAll('input, button, [role=button], [role=radio]')) {
      const box = control.getBoundingClientRect();
      if (outside(box) || box.height < 44 || box.width < 44)
        errors.push(control.outerHTML.slice(0, 140));
    }
    const nodes = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    while (nodes.nextNode()) {
      const node = nodes.currentNode;
      const parent = node.parentElement!.getBoundingClientRect();
      for (const word of (node.textContent ?? '').matchAll(/\S+/gu)) {
        range.setStart(node, word.index);
        range.setEnd(node, word.index + word[0].length);
        if (
          Array.from(range.getClientRects()).some(
            (r) => outside(r) || r.left < parent.left - 1 || r.right > parent.right + 1,
          )
        ) {
          errors.push(word[0]);
        }
      }
    }
    return errors;
  });
  expect(overflow).toEqual([]);
}

async function expectFieldError(field: Locator, message: string) {
  await expect(field).toHaveAttribute('aria-invalid', 'true');
  await expect(field).toHaveAccessibleDescription(`! ${message}`);
  const alert = field.locator('..').getByRole('alert');
  await expect(alert).toHaveText(`! ${message}`);
  const input = (await field.boundingBox())!;
  const gap = (await alert.boundingBox())!.y - input.y - input.height;
  expect(gap).toBeGreaterThanOrEqual(-1);
  expect(gap).toBeLessThan(12);
}

for (const [locale, t] of [
  ['en-GB', en],
  ['uk-UA', uk],
  ['ru-RU', ru],
] as const) {
  test.describe(locale, () => {
    test.use({ locale, viewport: { width: 320, height: 844 }, isMobile: true });
    test('visit sale, payment and stock delivery at 130% text size', async ({ page, request }) => {
      const { refresh, owner, base, visitId } = await seedSale(request);
      const p = t.products;
      const money = (grosze: number) =>
        new Intl.NumberFormat(locale, {
          style: 'currency',
          currency: 'PLN',
        }).format(grosze / 100);
      const button = (name: string) => page.getByRole('button', { name, exact: true });
      const app = await serveApp('mobile-business');
      try {
        await page.addInitScript(
          (token) => localStorage.setItem('beauty.business.refreshToken', token),
          refresh,
        );
        await page.goto(app.url);
        await expect(page.locator('html')).toHaveAttribute('lang', locale.split('-')[0]!);
        await button(t.day.previous).click();
        await page.getByRole('button', { name: /Jan Nowak/ }).click();
        const sales = page.getByTestId('visit-products');
        const title = sales.getByRole('heading');
        await expect(title).toHaveText(p.sold.toUpperCase());
        const fontSize = () => title.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
        const normal = await fontSize();
        await page.addStyleTag({ content: '* { -webkit-text-size-adjust: 130% !important; }' });
        expect(await fontSize()).toBeCloseTo(normal * 1.3, 1);
        const code = sales.getByRole('textbox', { name: p.saleByCode });
        const add = button(p.addByCode);
        const product = button(fill(p.addSaleFor, { name: productName }));
        await expect(add).toBeDisabled();
        await expect(product).toContainText(money(price));
        await code.fill('??');
        await expectFieldError(code, p.barcodeInvalid);
        await expect(add).toBeDisabled();
        const unknown = 'UNKNOWNBARCODEWITHOUTSEPARATORS';
        await code.fill(unknown);
        await add.click();
        await expectFieldError(code, fill(p.codeUnknown, { code: unknown }));
        await expectFits(sales);
        await product.click();
        await expect(title).toHaveText(fill(p.soldTotal, { amount: money(price) }));
        await code.fill(barcode);
        await add.click();
        await expect(code).toHaveValue('');
        await expect(title).toHaveText(fill(p.soldTotal, { amount: money(2 * price) }));
        await expect(sales.getByText(productName, { exact: true })).toHaveCount(2);
        await expect(product).toBeDisabled();
        await code.fill(barcode);
        await code.press('Enter');
        await expectFieldError(code, p.outOfStock);
        await expectFits(sales);

        const group = page.getByRole('radiogroup', { name: t.visit.paymentMethod, exact: true });
        for (const name of Object.values(t.visit.paymentMethods)) {
          await expect(group.getByRole('radio', { name, exact: true })).not.toBeChecked();
        }
        const transfer = group.getByRole('radio', { name: t.visit.paymentMethods.transfer });
        await transfer.click();
        await expect(transfer).toBeChecked();
        await expectFits(group);
        await button(t.visit.markPaid).click();
        await expect(
          page.getByText(`✓ ${t.visit.paid} · ${t.visit.paymentMethods.transfer}`, { exact: true }),
        ).toBeVisible();
        const visit = await json<{ paymentMethod: string }>(
          await request.get(`${base}/appointments/${visitId}`, { headers: owner }),
        );
        expect(visit.paymentMethod).toBe('transfer');

        await button(t.visit.back).click();
        await page.getByRole('tab', { name: t.shop.open, exact: true }).click();
        await button(`${t.navigation.inventory} ▸`).click();
        await button(p.delivery).click();
        const delivery = page.getByTestId('delivery');
        await delivery.getByRole('button', { name: supplier }).click();
        const quantity = delivery.getByRole('textbox', {
          name: fill(p.deliveryCame, { name: productName }),
        });
        const save = (n: string) =>
          delivery.getByRole('button', { name: fill(p.deliverySave, { n }), exact: true });
        await quantity.clear();
        await expect(save('0')).toBeDisabled();
        await quantity.fill('0');
        await expectFieldError(quantity, p.deliveryInvalid);
        await expect(save('0')).toBeDisabled();
        await expectFits(delivery);
        await quantity.fill('5');
        await expect(delivery.getByRole('alert')).toHaveCount(0);
        await save('5').click();
        await expect(page.getByTestId('delivery-done')).toHaveText(
          fill(p.deliveryDone, { pieces: '5', products: '1' }),
        );
        const stock = await json<{ products: { stockQuantity: number }[] }>(
          await request.get(`${base}/products`, { headers: owner }),
        );
        expect(stock.products[0]?.stockQuantity).toBe(5);
      } finally {
        app.server.close();
      }
    });
  });
}
