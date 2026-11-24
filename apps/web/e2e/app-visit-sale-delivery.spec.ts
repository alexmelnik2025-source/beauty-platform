import {
  expect,
  test,
  type APIRequestContext,
  type APIResponse,
  type Locator,
} from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { freshAddress } from './addresses';
import { waitForEmail } from './mailpit';
import { serveApp } from './mobile-app';

const PASSWORD = randomUUID();
const ADDRESS = freshAddress();
const OWNER = `visit-sale-owner-${Date.now().toString(36)}@example.com`;

async function json<T>(res: APIResponse): Promise<T> {
  await expect(res).toBeOK();
  return (res.status() === 204 ? undefined : await res.json()) as T;
}

async function verifiedUser(api: APIRequestContext, email: string, name: string) {
  await json(
    await api.post('/v1/auth/register', {
      headers: ADDRESS,
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
      headers: ADDRESS,
      data: { email, password: PASSWORD, clientType: 'mobile' },
    }),
  );
  return { Authorization: `Bearer ${login.accessToken}` };
}

const productName = 'Profesjonalna odżywka regenerująca do długich włosów z olejem arganowym';
const barcode = '5901234567893';

async function fitsOnPhone(locator: Locator) {
  await expect(locator).toBeVisible();
  const box = await locator.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(320);
  expect(await locator.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
}

test.use({
  viewport: { width: 320, height: 844 },
  isMobile: true,
  locale: 'pl-PL',
  timezoneId: 'Europe/Warsaw',
  extraHTTPHeaders: ADDRESS,
});

test('business app records a visit sale, payment and stock delivery at 320 px', async ({
  page,
  request,
}) => {
  const owner = await verifiedUser(request, OWNER, 'Aleksander Owner');
  const org = await json<{ id: string }>(
    await request.post('/v1/organizations', { headers: owner, data: { name: 'GESTALT' } }),
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
  for (const data of [
    { name: productName, priceGrosze: 5900, stockQuantity: 2, barcode },
    { name: 'Szampon', priceGrosze: 3900, stockQuantity: 7 },
  ]) {
    await json(await request.post(`${base}/products`, { headers: owner, data }));
  }

  const app = await serveApp('mobile-business');
  try {
    await page.goto(app.url);
    await page.getByLabel('E-mail lub telefon').fill(OWNER);
    await page.getByRole('button', { name: 'Wyślij kod' }).click();
    const mail = await waitForEmail(OWNER, /Kod logowania do aplikacji salonu/);
    await page.getByLabel('Kod', { exact: true }).fill(/\b(\d{6})\b/.exec(mail.text)![1]!);
    await page.getByRole('button', { name: 'Zaloguj się' }).click();
    await page.getByRole('button', { name: 'Poprzedni dzień' }).click();
    await page.getByRole('button', { name: /Jan Nowak/ }).click();

    const products = page.getByTestId('visit-products');
    const code = products.getByRole('textbox', { name: 'Kod kreskowy produktu' });
    const addCode = products.getByRole('button', { name: '+ Dodaj po kodzie' });
    const addProduct = products.getByRole('button', { name: `Dodaj produkt — ${productName}` });
    await expect(addCode).toBeDisabled();
    await fitsOnPhone(code);
    await fitsOnPhone(addCode);
    await fitsOnPhone(addProduct);
    await code.fill('??');
    await expect(addCode).toBeDisabled();
    await expect(products.getByRole('alert')).toContainText('Kod: 3–32');
    await code.fill('UNKNOWN');
    await addCode.click();
    await expect(products.getByRole('alert')).toContainText('Nie ma produktu z kodem UNKNOWN');

    await addProduct.click();
    await expect(products).toContainText(/PRODUKTY: 59,00\s*zł/);
    await fitsOnPhone(products.getByText(productName, { exact: true }));
    await code.fill(barcode);
    await addCode.click();
    await expect(code).toHaveValue('');
    await expect(products).toContainText(/PRODUKTY: 118,00\s*zł/);
    await expect(addProduct).toBeDisabled();
    await code.fill(barcode);
    await code.press('Enter');
    await expect(products.getByRole('alert')).toContainText('Za mało sztuk w magazynie');
    await expect(code).toHaveValue(barcode);

    const methods = page.getByRole('radiogroup', { name: 'Sposób płatności' });
    const card = methods.getByRole('radio', { name: 'Karta' });
    await fitsOnPhone(card);
    const cash = methods.getByRole('radio', { name: 'Gotówka' });
    await cash.click();
    await expect(cash).toBeChecked();
    await card.click();
    await expect(cash).not.toBeChecked();
    await expect(card).toBeChecked();
    await page.getByRole('button', { name: 'Opłacono', exact: true }).click();
    await expect(page.getByText('✓ Opłacono · Karta', { exact: true })).toBeVisible();
    const savedVisit = await json<{ paymentMethod: string }>(
      await request.get(`${base}/appointments/${visit.id}`, { headers: owner }),
    );
    expect(savedVisit.paymentMethod).toBe('card');

    await page.getByRole('button', { name: '‹ Wróć', exact: true }).click();
    await page.getByRole('tab', { name: 'Sklep', exact: true }).click();
    await page.getByRole('button', { name: 'Magazyn ▸', exact: true }).click();
    await page.getByRole('button', { name: 'Przyjmij dostawę', exact: true }).click();
    const delivery = page.getByTestId('delivery');
    const quantity = delivery.getByLabel(`Przyszło — ${productName}`);
    const save = delivery.getByRole('button', { name: /Przyjmij dostawę \(/ });
    await fitsOnPhone(delivery.getByText(productName, { exact: true }));
    await fitsOnPhone(quantity);
    await quantity.clear();
    await expect(delivery.getByLabel('Przyszło — Szampon')).toHaveValue('');
    await expect(save).toBeDisabled();
    await quantity.fill('0');
    await expect(delivery.getByRole('alert')).toContainText('Wpisz liczbę sztuk (co najmniej 1)');
    await expect(save).toBeDisabled();
    await quantity.fill('5');
    await expect(delivery.getByRole('alert')).toHaveCount(0);
    await expect(save).toHaveAccessibleName('Przyjmij dostawę (5 szt.)');
    await save.click();
    await expect(page.getByTestId('delivery-done')).toHaveText(
      'Dostawa przyjęta: 5 szt., produktów: 1.',
    );
    const stock = await json<{ products: { name: string; stockQuantity: number }[] }>(
      await request.get(`${base}/products`, { headers: owner }),
    );
    expect(Object.fromEntries(stock.products.map((p) => [p.name, p.stockQuantity]))).toEqual({
      [productName]: 5,
      Szampon: 7,
    });
  } finally {
    app.server.close();
  }
});
