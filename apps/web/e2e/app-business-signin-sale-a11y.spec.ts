import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { DICTIONARIES, fill, LANGUAGE_NAMES, LOCALES } from '../../mobile-business/src/i18n';
import { freshAddress } from './addresses';
import { waitForEmail } from './mailpit';
import { serveApp } from './mobile-app';

const salon = 'Studio Fryzjerskie i Pracownia Stylizacji Włosów przy Starym Rynku';
const product = 'Profesjonalna odżywka odbudowująca do włosów farbowanych z olejem arganowym';
const supplier = 'Laboratorium Kosmetyków';
const barcode = '5901234567893';

async function prepareVisit(
  api: APIRequestContext,
  address: Record<string, string>,
  email: string,
) {
  const account = { email, password: randomUUID() };
  const registration = await api.post('/v1/auth/register', {
    headers: address,
    data: { ...account, name: 'Salon Owner' },
  });
  await expect(registration).toBeOK();
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
  const headers = { ...address, Authorization: `Bearer ${(await login.json()).accessToken}` };
  async function create(path: string, data: Record<string, unknown>): Promise<string> {
    const response = await api.post(path, { headers, data });
    await expect(response).toBeOK();
    return (await response.json()).id;
  }
  const org = await create('/v1/organizations', { name: 'Studio' });
  const locations = `/v1/organizations/${org}/locations`;
  const street = { addressLine: 'ul. Testowa 1', city: 'Warszawa', postalCode: '00-001' };
  await create(locations, { ...street, name: 'Centrum' });
  const location = await create(locations, { ...street, name: salon });
  const base = `${locations}/${location}`;
  const serviceId = await create(`${base}/services`, {
    name: 'Strzyżenie',
    durationMinutes: 30,
    priceGrosze: 9000,
  });
  const staffId = await create(`${base}/staff`, { displayName: 'Anna', serviceIds: [serviceId] });
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Warsaw' }).format(new Date());
  const yesterday = new Date(Date.parse(today) - 86_400_000).toISOString().slice(0, 10);
  await create(`${base}/appointments`, {
    staffId,
    serviceId,
    start: `${yesterday}T10:00:00Z`,
    customer: { name: 'Jan Nowak', phone: '+48600241024' },
    alreadyHappened: true,
    allowOutsideHours: true,
  });
  await create(`${base}/products`, {
    name: product,
    barcode,
    supplier,
    priceGrosze: 5900,
    stockQuantity: 2,
  });
}

// Expo emits pixel sizes. Scale its font rules so later screens inherit the same
// setting while the viewport and the controls' padding keep their original size.
async function enlargeText(page: Page, sample: Locator) {
  await expect(sample).toBeVisible();
  const readSize = () => sample.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  const original = await readSize();
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
  expect(await readSize()).toBeCloseTo(original * 1.3, 1);
}

async function fits(control: Locator, touch = true) {
  await expect(control).toBeVisible();
  const clipped = await control.evaluate((el, touch) => {
    const box = el.getBoundingClientRect();
    if (touch && (box.width < 44 || box.height < 44)) return 'smaller than 44 × 44';
    if (box.left < -1 || box.right > 321) return 'outside the viewport';
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const range = document.createRange();
      const node = walker.currentNode;
      const bounds = node.parentElement!.getBoundingClientRect();
      // A wrapping space can hang beyond a line even when all glyphs fit.
      for (const word of (node.textContent ?? '').matchAll(/\S+/g)) {
        range.setStart(node, word.index);
        range.setEnd(node, word.index + word[0].length);
        for (const line of range.getClientRects()) {
          if (
            line.left < Math.max(box.left, bounds.left) - 1 ||
            line.right > Math.min(box.right, bounds.right) + 1 ||
            line.top < box.top - 1 ||
            line.bottom > box.bottom + 1
          )
            return word[0];
        }
      }
    }
    return null;
  }, touch);
  expect(clipped, control.toString()).toBeNull();
}

test.use({
  viewport: { width: 320, height: 568 },
  isMobile: true,
  locale: 'pl-PL',
  timezoneId: 'Europe/Warsaw',
});

for (const locale of LOCALES) {
  test(`sign-in, salon choice, sale and delivery with 130% text at 320 px (${locale})`, async ({
    page,
    request,
  }) => {
    const address = freshAddress();
    const email = `at-${locale}-${Date.now()}@example.com`;
    await prepareVisit(request, address, email);
    const app = await serveApp('mobile-business');
    const t = DICTIONARIES[locale];
    const p = t.products;
    const button = (name: string) => page.getByRole('button', { name, exact: true });
    try {
      await page.setExtraHTTPHeaders(address);
      await page.goto(app.url);
      await enlargeText(page, page.getByRole('heading', { name: DICTIONARIES.pl.signIn.title }));
      const picker = button(`${DICTIONARIES.pl.language}: ${LANGUAGE_NAMES.pl}`);
      await fits(picker);
      await picker.click();
      await expect(picker).toHaveAttribute('aria-expanded', 'true');
      const options = page.getByRole('group', { name: DICTIONARIES.pl.language });
      const option = options.getByRole('button', {
        name: `${locale === 'uk' ? 'UA' : locale.toUpperCase()} · ${LANGUAGE_NAMES[locale]}`,
        exact: true,
      });
      await expect(options.getByRole('button', { pressed: true })).toHaveText('PL · Polski');
      await fits(option);
      await option.click();
      await expect(button(`${t.language}: ${LANGUAGE_NAMES[locale]}`)).toHaveAttribute(
        'aria-expanded',
        'false',
      );

      const contact = page.getByRole('textbox', { name: t.signIn.contact, exact: true });
      await fits(contact);
      await contact.fill(email);
      await fits(button(t.signIn.sendCode));
      await button(t.signIn.sendCode).click();
      const code = page.getByRole('textbox', { name: t.signIn.code, exact: true });
      const sent = fill(t.signIn.sentEmail, { to: email });
      await expect(code).toHaveAccessibleDescription(sent);
      await fits(page.getByText(sent, { exact: true }), false);
      await fits(code);
      const mail = await waitForEmail(email, /Kod logowania do aplikacji salonu/);
      await code.fill(/\b(\d{6})\b/.exec(mail.text)![1]!);
      await fits(button(t.signIn.confirm));
      await button(t.signIn.confirm).click();

      const choice = button(salon);
      await expect(choice).toHaveAccessibleDescription(
        `Studio · Warszawa · ${t.salons.role.owner}`,
      );
      await fits(choice);
      await choice.click();
      await button(t.day.previous).click();
      await page.getByRole('button', { name: /Jan Nowak/ }).click();

      const sales = page.getByTestId('visit-products');
      const scan = sales.getByRole('textbox', { name: p.saleByCode });
      await fits(scan);
      await scan.fill('?');
      await expect(scan).toHaveAccessibleDescription(`! ${p.barcodeInvalid}`);
      const addCode = button(p.addByCode);
      await expect(addCode).toBeDisabled();
      await fits(addCode);
      await scan.fill(barcode);
      const addProduct = button(fill(p.addSaleFor, { name: product }));
      await fits(addProduct);
      await addCode.click();
      const removeProduct = button(fill(p.removeSaleFor, { name: product }));
      await fits(removeProduct);
      await fits(sales.getByText(product, { exact: true }), false);

      const methods = page.getByRole('radiogroup', { name: t.visit.paymentMethod, exact: true });
      for (const method of Object.values(t.visit.paymentMethods)) {
        await fits(methods.getByRole('radio', { name: method, exact: true }));
      }
      const card = methods.getByRole('radio', { name: t.visit.paymentMethods.card, exact: true });
      await card.click();
      await expect(card).toBeChecked();
      await button(t.visit.markPaid).click();
      await expect(
        page.getByText(`✓ ${t.visit.paid} · ${t.visit.paymentMethods.card}`, { exact: true }),
      ).toBeVisible();

      await button(t.visit.back).click();
      await page.getByRole('tab', { name: t.shop.open, exact: true }).click();
      await button(`${t.navigation.inventory} ▸`).click();
      await button(p.delivery).click();
      const delivery = page.getByTestId('delivery');
      const filter = delivery.getByRole('button', { name: supplier, exact: true });
      await fits(filter);
      await filter.click();
      await expect(filter).toHaveAttribute('aria-pressed', 'true');
      await fits(delivery.getByText(product, { exact: true }), false);
      const quantity = delivery.getByRole('textbox', {
        name: fill(p.deliveryCame, { name: product }),
      });
      await fits(quantity);
      await quantity.fill('0');
      await expect(quantity).toHaveAccessibleDescription(`! ${p.deliveryInvalid}`);
      await expect(button(fill(p.deliverySave, { n: '0' }))).toBeDisabled();
      await quantity.fill('3');
      const save = button(fill(p.deliverySave, { n: '3' }));
      await fits(save);
      await save.click();
      await expect(page.getByTestId('delivery-done')).toHaveText(
        fill(p.deliveryDone, { pieces: '3', products: '1' }),
      );
    } finally {
      app.server.close();
    }
  });
}
