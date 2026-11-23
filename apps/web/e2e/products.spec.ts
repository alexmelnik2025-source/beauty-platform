import {
  expect,
  test,
  type APIRequestContext,
  type APIResponse,
  type Page,
} from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { freshAddress } from './addresses';
import { waitForEmail } from './mailpit';
import { expandBusinessRow, openBusinessMenu, serveApp } from './mobile-app';

/**
 * Task 395: "Produkty". The owner keeps the salon's list of products in "Usługi" (screenshot
 * 395), notes what the client bought in the card of a visit that took place (395-a) and sees
 * "Sprzedaż produktów" in "Raporty", apart from the visit revenue (395-b).
 * Task 396: the same in the business app — a tap on a product in the visit card (396) and
 * "Sprzedaż produktów" in its report (396-a); the list of products in "Usługi" (task 397, 397).
 * Task 422–423: "CSV produktów" — every sale of the period for the accountant (422), in the app too.
 * Task 424: "Kupione produkty" in the client card of the cabinet (424).
 * Task 436–441: "CSV stanu magazynowego" (437), "Dostawa" (438, 439) and "Historia magazynu" (441);
 * task 444–447: "Odpis" and "Odpisy z magazynu" in the reports; task 452–453: "Dostawy na magazyn";
 * task 455: "CSV historii magazynu"
 * in the cabinet and the business app; task 521–522: "Kod kreskowy" and "Szukaj" in the cabinet (521)
 * and the business app (522); task 524: a product added in the visit card by its code (524, 524-a).
 */

const PASSWORD = 'e2e-password-123';
const run = Date.now().toString(36);
const OWNER = `products-owner-${run}@example.com`;
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

test('the owner sells a product at a visit; the report counts it apart', async ({
  browser,
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
  // Visits can't be booked in the past: book tomorrow at 10:00 UTC and move it two days back.
  const tomorrow = new Date(Date.now() + 86_400_000);
  const booked = await json<{ id: string; version: number }>(
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
          phone: '+48600000395',
          email: `jan-${run}@example.com`,
        },
      },
    }),
  );
  execFileSync('psql', [
    (process.env.DATABASE_URL ?? '').replace(/\?.*$/, ''),
    '-v',
    'ON_ERROR_STOP=1',
    '-c',
    `UPDATE appointment SET start_at = start_at - interval '2 days', end_at = end_at - interval '2 days', blocked_until = blocked_until - interval '2 days' WHERE id = '${booked.id}'`,
  ]);
  const visit = await json<{ date: string; version: number }>(
    await request.post(`${base}/appointments/${booked.id}/status`, {
      headers: owner,
      data: { version: booked.version, status: 'completed' },
    }),
  );

  const context = await browser.newContext({ viewport: DESKTOP, locale: 'pl-PL' });
  const page = await context.newPage();
  await page.goto('/pl/login');
  await page.getByLabel('E-mail').fill(OWNER);
  await page.getByLabel('Hasło').fill(PASSWORD);
  await page.getByRole('button', { name: 'Zaloguj się' }).click();
  await page.waitForURL(/\/pl\/app\/calendar/);

  // "Usługi" → "Produkty": two products, then a new price for one.
  await page.goto('/pl/app/services');
  const products = page.getByTestId('products');
  await products.scrollIntoViewIfNeeded();
  await expect(products.getByText('Na liście nie ma jeszcze produktów.')).toBeVisible();
  for (const [name, price] of [
    ['Pomada matowa', '45'],
    ['Szampon', '30,50'],
  ] as const) {
    await products.getByLabel('Nowy produkt').fill(name);
    await products.getByLabel(/^Cena \(/).fill(price);
    await products.getByRole('button', { name: '+ Dodaj produkt' }).click();
    await expect(products.getByLabel(`Nazwa — ${name}`)).toBeVisible();
  }
  await expect(products.getByTestId('product-row')).toHaveCount(2);
  // Task 652 (Q6): the new-product form is short — name, price, stock; the rest under "Więcej ▸".
  const costNew = products.getByLabel(/^Cena zakupu \(puste/);
  await expect(costNew).toBeHidden();
  await products.getByText('Więcej ▸', { exact: true }).click();
  await expect(costNew).toBeVisible();
  await expect(products.getByLabel(/^Kod kreskowy \(puste/)).toBeVisible();
  await products.locator('.product-new').scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'e2e/screenshots/652-product-form-more.png' });
  // Task 663 (errors at the field): a wrong price says why under "Cena" once the field is left,
  // a wrong barcode under "Kod kreskowy" when "+ Dodaj produkt" is pressed; nothing is added.
  const newForm = products.locator('.product-new');
  await newForm.getByLabel('Nowy produkt').fill('Próba');
  const newPrice = newForm.getByLabel(/^Cena \(/);
  await newPrice.fill('4,5,0');
  await expect(newForm.getByText('Wpisz kwotę, np. 45 lub 45,50.')).toBeHidden();
  await newPrice.blur();
  await expect(newPrice).toHaveAttribute('aria-invalid', 'true');
  await expect(newForm.getByText('Wpisz kwotę, np. 45 lub 45,50.')).toBeVisible();
  await newPrice.fill('45');
  await expect(newForm.getByText('Wpisz kwotę, np. 45 lub 45,50.')).toBeHidden();
  const newBarcode = newForm.getByLabel(/^Kod kreskowy \(puste/);
  await newBarcode.fill('a');
  await newForm.getByRole('button', { name: '+ Dodaj produkt' }).click();
  await expect(newForm.getByText('Od 3 do 32 znaków: cyfry, litery i „-”.')).toBeVisible();
  await expect(newBarcode).toBeFocused();
  await expect(products.getByTestId('product-row')).toHaveCount(2);
  await newForm.scrollIntoViewIfNeeded();
  await shot(page, '663-product-new-field-error');
  await newBarcode.fill('');
  await newForm.getByLabel('Nowy produkt').fill('');
  await newPrice.fill('');
  // Task 708: "+ Dodaj produkt" is not silently off — an empty name and price say so under them.
  await newForm.getByRole('button', { name: '+ Dodaj produkt' }).click();
  await expect(newForm.getByText('Uzupełnij to pole.')).toHaveCount(2);
  await expect(newForm.getByLabel('Nowy produkt')).toBeFocused();
  await expect(products.getByTestId('product-row')).toHaveCount(2);
  await shot(page, '708-product-new-required');
  await products.getByText('Więcej ▸', { exact: true }).click();
  await products.getByLabel('Cena — Pomada matowa').fill('49');
  // Task 430: the salon counts the pomades — two left in stock.
  await products.getByLabel('W magazynie — Pomada matowa').fill('2');
  // Task 448: "Cena zakupu" — the salon pays 20 zł for a pomade (only the owner sees it).
  await products.getByLabel('Cena zakupu — Pomada matowa').fill('20');
  await products
    .getByTestId('product-row')
    .filter({ has: page.getByLabel('Nazwa — Pomada matowa') })
    .getByRole('button', { name: 'Zapisz' })
    .click();
  await expect(products.getByLabel('Cena — Pomada matowa')).toHaveValue('49');
  await expect(products.getByLabel('W magazynie — Pomada matowa')).toHaveValue('2');
  await expect(products.getByLabel('W magazynie — Szampon')).toHaveValue('');
  await expect(products.getByLabel('Cena zakupu — Pomada matowa')).toHaveValue('20');
  await expect(products.getByLabel('Cena zakupu — Szampon')).toHaveValue('');
  await shot(page, '395-owner-products');
  await shot(page, '448-owner-purchase-price');

  // Task Q6: the explanations wait under "?" — the list comes first; one tap opens them, another closes.
  await expect(products.getByText(/Cena zakupu: ile salon płaci/)).toBeHidden();
  const help = products.getByRole('button', { name: 'Jak to działa?' });
  await expect(help).toHaveAttribute('aria-expanded', 'false');
  await products.scrollIntoViewIfNeeded();
  await shot(page, 'q6-products-help-closed');
  await help.click();
  await expect(help).toHaveAttribute('aria-expanded', 'true');
  await expect(
    products.getByTestId('products-help').getByText(/Cena zakupu: ile salon płaci/),
  ).toBeVisible();
  await products
    .getByTestId('products-help')
    .screenshot({ path: 'e2e/screenshots/q6-products-help-open.png' });
  await help.click();
  await expect(products.getByTestId('products-help')).toHaveCount(0);

  // The visit card: the client buys two pomades and a shampoo; one shampoo was a mistake.
  await page.goto(`/pl/app/calendar?date=${visit.date}`);
  await page.getByRole('button', { name: /Jan Kowalski/ }).click();
  const card = page.getByRole('dialog');
  const sold = card.getByTestId('visit-products');
  // The list is by name: 1 = Pomada matowa, 2 = Szampon.
  const options = sold.getByLabel('Wybierz produkt').locator('option');
  await expect(options.nth(1)).toHaveText(/Pomada matowa · 49,00\s*zł · zostało 2 szt\./);
  await sold.getByLabel('Wybierz produkt').selectOption({ index: 1 });
  // Task 703: a part of a piece is not possible — "2.5" stays 2, no browser bubble on "+ Dodaj".
  await sold.getByLabel('Ilość').fill('2.5');
  await expect(sold.getByLabel('Ilość')).toHaveValue('2');
  await sold.getByRole('button', { name: '+ Dodaj' }).click();
  await expect(sold).toContainText(/Pomada matowa × 2/);
  // Task 430: both pomades are sold — none left to choose.
  await expect(options.nth(1)).toHaveText(/Pomada matowa · .* · Brak w magazynie/);
  await expect(options.nth(1)).toBeDisabled();
  await sold.getByLabel('Wybierz produkt').selectOption({ index: 2 });
  await sold.getByRole('button', { name: '+ Dodaj' }).click();
  await expect(sold).toContainText(/Produkty: 128,50\s*zł/);
  await sold.getByRole('button', { name: 'Usuń — Szampon' }).click();
  await expect(sold).toContainText(/Produkty: 98,00\s*zł/);
  await sold.scrollIntoViewIfNeeded();
  await shot(page, '395-a-visit-products');
  await page.keyboard.press('Escape');

  // Task 430: "Brak w magazynie" next to the pomade in "Usługi" → "Produkty" (screenshot 430).
  await page.goto('/pl/app/services');
  await products.scrollIntoViewIfNeeded();
  await expect(products.getByLabel('W magazynie — Pomada matowa')).toHaveValue('0');
  await expect(products.getByTestId('product-out')).toHaveText('Brak w magazynie');
  await shot(page, '430-owner-stock');
  // Task 461: how fast it sells — two pomades at yesterday's visit, none left (no "starczy na").
  await expect(
    products
      .getByTestId('product-row')
      .filter({ has: page.getByLabel('Nazwa — Pomada matowa') })
      .getByTestId('product-pace'),
  ).toHaveText('Sprzedano w 30 dni: 2 szt.');
  await expect(products.getByTestId('product-pace')).toHaveCount(1);
  await shot(page, '461-owner-sold-30-days');

  // Task 434: "Kończy się przy" — three shampoos are already few; both go to "Do zamówienia".
  const shampooRow = products
    .getByTestId('product-row')
    .filter({ has: page.getByLabel('Nazwa — Szampon') });
  await products.getByLabel('W magazynie — Szampon').fill('3');
  await products.getByLabel('Kończy się przy — Szampon').fill('3');
  await shampooRow.getByRole('button', { name: 'Zapisz' }).click();
  await expect(shampooRow.getByTestId('product-low')).toHaveText('Kończy się');
  await expect(products.getByTestId('products-to-order')).toHaveText(
    'Do zamówienia: Pomada matowa (Brak w magazynie), Szampon (zostało 3 szt.)',
  );
  await expect(products.getByLabel('Kończy się przy — Pomada matowa')).toHaveValue('');
  await products.scrollIntoViewIfNeeded();
  await shot(page, '434-owner-low-stock');
  // Task 437: "CSV stanu magazynowego" — the list for the supplier, with what to order.
  const [stockCsv] = await Promise.all([
    page.waitForEvent('download'),
    products.getByRole('button', { name: 'CSV stanu magazynowego' }).click(),
  ]);
  expect(stockCsv.suggestedFilename()).toMatch(/^stock-.+-\d{4}-\d{2}-\d{2}\.csv$/);
  const stockFile = readFileSync((await stockCsv.path())!, 'utf8');
  expect(stockFile).toContain(
    'Produkt;Cena;Sprzedajemy;W magazynie;Kończy się przy;Do zamówienia;Cena zakupu;Dostawca;Sprzedano w 30 dni;Kod kreskowy\r\n',
  );
  expect(stockFile).toContain('Pomada matowa;49,00;tak;0;;tak;20,00;;2;\r\n');
  expect(stockFile).toContain('Szampon;30,50;tak;3;3;tak;;;0;\r\n');
  await shot(page, '437-owner-stock-csv');
  // Task 463: "Dostawca" — the pomade comes from Hairgum; the CSV for that supplier only.
  await expect(products.getByLabel('Dostawca w pliku CSV')).toHaveCount(0);
  const pomadeRow = products
    .getByTestId('product-row')
    .filter({ has: page.getByLabel('Nazwa — Pomada matowa') });
  await products.getByLabel('Dostawca — Pomada matowa').fill('Hairgum');
  await pomadeRow.getByRole('button', { name: 'Zapisz' }).click();
  await expect(products.getByLabel('Dostawca — Pomada matowa')).toHaveValue('Hairgum');
  // Task 465: "Do zamówienia" grouped by supplier — whom to call for what.
  await expect(products.getByTestId('products-to-order')).toHaveText(
    'Do zamówienia: Hairgum — Pomada matowa (Brak w magazynie); bez dostawcy — Szampon (zostało 3 szt.)',
  );
  await products.getByTestId('products-to-order').scrollIntoViewIfNeeded();
  await shot(page, '465-owner-to-order-suppliers');
  await products.getByLabel('Dostawca w pliku CSV').selectOption('Hairgum');
  const [supplierCsv] = await Promise.all([
    page.waitForEvent('download'),
    products.getByRole('button', { name: 'CSV stanu magazynowego' }).click(),
  ]);
  const supplierFile = readFileSync((await supplierCsv.path())!, 'utf8');
  expect(supplierFile).toContain('Pomada matowa;49,00;tak;0;;tak;20,00;Hairgum;2;\r\n');
  expect(supplierFile).not.toContain('Szampon');
  await products.getByLabel('Dostawca w pliku CSV').scrollIntoViewIfNeeded();
  await shot(page, '463-owner-supplier');
  // Task 521: "Kod kreskowy" — the code from the pomade's package; "Szukaj" finds it by the code
  // (a scanner types it like a keyboard, with spaces or not), and says when nothing matches.
  await products.getByLabel('Kod kreskowy — Pomada matowa').fill('5901234 123457');
  await pomadeRow.getByRole('button', { name: 'Zapisz' }).click();
  await expect(products.getByLabel('Kod kreskowy — Pomada matowa')).toHaveValue('5901234123457');
  await products.getByTestId('products-search').fill('5901234123457');
  await expect(products.getByTestId('product-row')).toHaveCount(1);
  await expect(products.getByLabel('Nazwa — Pomada matowa')).toBeVisible();
  await products.getByTestId('products-search').scrollIntoViewIfNeeded();
  await shot(page, '521-owner-barcode-search');
  await products.getByTestId('products-search').fill('szamp');
  await expect(products.getByTestId('product-row')).toHaveCount(1);
  await expect(products.getByLabel('Nazwa — Szampon')).toBeVisible();
  await products.getByTestId('products-search').fill('0000');
  await expect(products.getByTestId('products-search-none')).toHaveText(
    'Nic nie znaleziono — sprawdź nazwę albo kod.',
  );
  await products.getByRole('button', { name: 'Wyczyść' }).click();
  await expect(products.getByTestId('product-row')).toHaveCount(2);
  // Task 524: in the visit card the code from the scanner adds the product — the pomade is sold
  // out (the server says so, nothing is added); an unknown code is named.
  await page.goto(`/pl/app/calendar?date=${visit.date}`);
  await page.getByRole('button', { name: /Jan Kowalski/ }).click();
  const codeSold = page.getByRole('dialog').getByTestId('visit-products');
  // Task 682: "+ Dodaj" is not silently off — an empty or a wrong code is said under the field,
  // and so is no product chosen in the list.
  await codeSold.getByTestId('visit-products-code').press('Enter');
  await expect(codeSold.getByTestId('visit-products-code')).toHaveAccessibleDescription(
    /Uzupełnij to pole\.$/,
  );
  await codeSold.getByTestId('visit-products-code').fill('a!');
  await expect(codeSold.locator('.field-error')).toHaveCount(0);
  await codeSold.getByTestId('visit-products-code').press('Enter');
  await expect(codeSold.getByTestId('visit-products-code')).toHaveAccessibleDescription(
    /Od 3 do 32 znaków: cyfry, litery i „-”\.$/,
  );
  await expect(codeSold.getByTestId('visit-products-code')).toBeFocused();
  await codeSold.scrollIntoViewIfNeeded();
  await shot(page, '682-visit-product-code-required');
  await codeSold.getByRole('button', { name: '+ Dodaj' }).last().click();
  await expect(
    codeSold.getByRole('combobox', { name: 'Wybierz produkt' }),
  ).toHaveAccessibleDescription(/Uzupełnij to pole\.$/);
  await expect(codeSold.getByRole('combobox', { name: 'Wybierz produkt' })).toBeFocused();
  await codeSold.getByTestId('visit-products-code').fill('5901234123457');
  await codeSold.getByTestId('visit-products-code').press('Enter');
  await expect(codeSold).toContainText('Za mało sztuk w magazynie');
  // Task 673: both answers are said under the code field, which keeps the cursor.
  await expect(codeSold.getByTestId('visit-products-code')).toHaveAccessibleDescription(
    /Za mało sztuk w magazynie/,
  );
  await codeSold.getByTestId('visit-products-code').fill('abc 123');
  await expect(codeSold.locator('.field-error')).toHaveCount(0);
  await codeSold.getByTestId('visit-products-code').press('Enter');
  await expect(codeSold).toContainText('Nie ma produktu z kodem ABC123');
  await expect(codeSold.getByTestId('visit-products-code')).toHaveAccessibleDescription(
    /Nie ma produktu z kodem ABC123/,
  );
  await expect(codeSold.getByTestId('visit-products-code')).toBeFocused();
  await expect(codeSold.locator('.alert')).toHaveCount(0);
  await expect(codeSold).toContainText(/Produkty: 98,00\s*zł/);
  await codeSold.scrollIntoViewIfNeeded();
  await shot(page, '524-owner-sale-by-code');
  await shot(page, '673-visit-product-code-error');
  await page.keyboard.press('Escape');
  await page.goto('/pl/app/services');
  await expect(products.getByLabel('Kod kreskowy — Pomada matowa')).toHaveValue('5901234123457');
  // Task 438: "Dostawa" — a new set without a count gets four pieces delivered.
  await products.getByLabel('Nowy produkt').fill('Zestaw');
  await products.getByLabel(/^Cena \(/).fill('80');
  // Task 663: the pomade's barcode again — the server's answer is said under "Kod kreskowy"
  // ("Więcej ▸" opens by itself); a new code lets the set in.
  await products.getByText('Więcej ▸', { exact: true }).click();
  const zestawCode = products.getByLabel(/^Kod kreskowy \(puste/);
  await zestawCode.fill('5901234123457');
  await products.getByText('Więcej ▸', { exact: true }).click();
  await products.getByRole('button', { name: '+ Dodaj produkt' }).click();
  await expect(zestawCode).toBeVisible();
  await expect(zestawCode).toHaveAttribute('aria-invalid', 'true');
  await expect(products.locator('#product-new-barcode-error')).toHaveText(
    'Ten kod kreskowy ma już inny produkt salonu.',
  );
  await zestawCode.fill('');
  await expect(products.locator('#product-new-barcode-error')).toHaveCount(0);
  await products.getByText('Więcej ▸', { exact: true }).click();
  await products.getByRole('button', { name: '+ Dodaj produkt' }).click();
  await expect(products.getByLabel('W magazynie — Zestaw')).toHaveValue('');
  // Task 709: "Przyjmij" with no pieces is not silently off — it says so under the field.
  const zestawDelivery = products.getByLabel('Dostawa — Zestaw');
  await products.getByRole('button', { name: 'Przyjmij — Zestaw' }).click();
  await expect(zestawDelivery).toHaveAttribute('aria-invalid', 'true');
  await expect(zestawDelivery).toBeFocused();
  await expect(
    products.locator(`#${await zestawDelivery.getAttribute('aria-describedby')}`),
  ).toHaveText('Wpisz liczbę sztuk od 1 do 100 000.');
  await shot(page, '709-restock-pieces-empty');
  await zestawDelivery.fill('4');
  await expect(zestawDelivery).not.toHaveAttribute('aria-invalid', 'true');
  await products.getByRole('button', { name: 'Przyjmij — Zestaw' }).click();
  await expect(products.getByLabel('W magazynie — Zestaw')).toHaveValue('4');
  await expect(products.getByLabel('Dostawa — Zestaw')).toHaveValue('');
  await shot(page, '438-owner-restock');
  // Task 441: "Historia" — the delivery, with who and when.
  await products.getByRole('button', { name: 'Historia magazynu — Zestaw' }).click();
  const zestawHistory = products.getByTestId('stock-history');
  await expect(zestawHistory).toContainText(/Dostawa · \+4 szt\. → 4/);
  await zestawHistory.scrollIntoViewIfNeeded();
  await shot(page, '441-owner-stock-history');
  // Task 442: "Wartość magazynu" — 3 shampoos × 30,50 + 4 sets × 80 (no pomades left).
  await expect(products.getByTestId('products-stock-value')).toHaveText(
    /^Wartość magazynu: 411,50\s*zł \(7 szt\.\) — w cenach sprzedaży\.$/,
  );
  // Task 444: "Odpis" — a damaged set leaves the stock, with the reason in the history.
  const zestawWriteOff = zestawHistory.getByTestId('stock-write-off');
  // Task 709: more pieces than in stock — the salon's answer is said under the field, not at the top.
  const zestawPieces = zestawWriteOff.getByLabel('Ile sztuk — Zestaw');
  await zestawPieces.fill('9');
  await zestawWriteOff.getByRole('button', { name: 'Odpis — Zestaw' }).click();
  await expect(zestawPieces).toHaveAttribute('aria-invalid', 'true');
  await expect(zestawPieces).toBeFocused();
  await expect(zestawWriteOff.getByRole('alert')).toHaveText(
    'Za mało sztuk w magazynie — popraw stan w „Produkty”.',
  );
  await expect(products.getByLabel('W magazynie — Zestaw')).toHaveValue('4');
  await zestawHistory.scrollIntoViewIfNeeded();
  await shot(page, '709-write-off-too-many');
  await zestawPieces.fill('1');
  await zestawWriteOff.getByLabel(/^Powód/).fill('uszkodzone');
  await zestawWriteOff.getByRole('button', { name: 'Odpis — Zestaw' }).click();
  await expect(products.getByLabel('W magazynie — Zestaw')).toHaveValue('3');
  await expect(zestawHistory).toContainText(/Odpis · -1 szt\. → 3 · .+ · uszkodzone/);
  await expect(zestawWriteOff.getByLabel('Ile sztuk — Zestaw')).toHaveValue('');
  await zestawHistory.scrollIntoViewIfNeeded();
  await shot(page, '444-owner-write-off');
  // Task 457: "Inwentaryzacja" — only two sets are on the shelf; the difference goes to the history.
  await products.getByRole('button', { name: 'Inwentaryzacja', exact: true }).click();
  const stocktake = products.getByTestId('stocktake');
  await expect(stocktake.getByLabel('Na półce — Zestaw')).toHaveValue('3');
  // Task 721: "Zapisz inwentaryzację" with nothing changed is not silently off — said under the first field.
  await stocktake.getByRole('button', { name: 'Zapisz inwentaryzację' }).click();
  const firstShelf = stocktake.getByTestId('stocktake-row').first().getByRole('textbox');
  await expect(firstShelf).toBeFocused();
  await expect(firstShelf).toHaveAttribute('aria-invalid', 'true');
  await expect(stocktake.getByRole('alert')).toHaveText(
    'Nic się nie zmieniło — wpisz, ile sztuk jest na półce.',
  );
  await stocktake.scrollIntoViewIfNeeded();
  await shot(page, '721-stocktake-nothing-changed');
  // Task 670: a wrong number is said under its own field (red frame, "!").
  await stocktake.getByLabel('Na półce — Zestaw').fill('2,5');
  await expect(stocktake.getByLabel('Na półce — Zestaw')).toHaveAccessibleDescription(
    /Wpisz liczbę od 0 do 100 000\.$/,
  );
  await stocktake.scrollIntoViewIfNeeded();
  await shot(page, '670-stocktake-field-error');
  // Task 721: pressing the button sends the cursor to the wrong number.
  await stocktake.getByRole('button', { name: 'Zapisz inwentaryzację' }).click();
  await expect(stocktake.getByLabel('Na półce — Zestaw')).toBeFocused();
  await stocktake.getByLabel('Na półce — Zestaw').fill('2');
  await expect(stocktake.locator('.field-error')).toHaveCount(0);
  await expect(stocktake.getByTestId('stocktake-diff')).toHaveText('brakuje 1 szt.');
  await stocktake.scrollIntoViewIfNeeded();
  await shot(page, '457-a-owner-stocktake');
  await stocktake.getByRole('button', { name: 'Zapisz inwentaryzację' }).click();
  await expect(products.getByTestId('stocktake-done')).toHaveText(
    'Inwentaryzacja zapisana: zmienione produkty: 1, brakuje 1 szt., nadwyżka 0 szt.',
  );
  await expect(stocktake).toHaveCount(0);
  await expect(products.getByLabel('W magazynie — Zestaw')).toHaveValue('2');
  await products.getByRole('button', { name: 'Historia magazynu — Zestaw' }).click();
  await expect(products.getByTestId('stock-history')).toContainText(
    /Inwentaryzacja · -1 szt\. → 2/,
  );
  await products.getByTestId('stocktake-done').scrollIntoViewIfNeeded();
  await shot(page, '457-owner-stocktake');
  // Task 470: "Tylko do zamówienia" — the file for the supplier without the set (enough of it).
  await products.getByLabel('Dostawca w pliku CSV').selectOption({ label: 'Wszyscy dostawcy' });
  await products.getByLabel('Tylko do zamówienia').check();
  const [toOrderCsv] = await Promise.all([
    page.waitForEvent('download'),
    products.getByRole('button', { name: 'CSV stanu magazynowego' }).click(),
  ]);
  const toOrderFile = readFileSync((await toOrderCsv.path())!, 'utf8');
  expect(toOrderFile).toContain('Pomada matowa;49,00;tak;0;;tak;20,00;Hairgum;2;5901234123457\r\n');
  expect(toOrderFile).toContain('Szampon;30,50;tak;3;3;tak;;;0;\r\n');
  expect(toOrderFile).not.toContain('Zestaw');
  await products.getByLabel('Tylko do zamówienia').scrollIntoViewIfNeeded();
  await shot(page, '470-owner-stock-csv-to-order');
  // The visit card says it too.
  await page.goto(`/pl/app/calendar?date=${visit.date}`);
  await page.getByRole('button', { name: /Jan Kowalski/ }).click();
  await expect(
    page
      .getByRole('dialog')
      .getByTestId('visit-products')
      .getByLabel('Wybierz produkt')
      .locator('option')
      .nth(2),
  ).toHaveText(/Szampon · 30,50\s*zł · zostało 3 szt\. · Kończy się/);
  await page.keyboard.press('Escape');

  // "Raporty": products apart from the visit revenue (the visit itself was not paid).
  await page.goto('/pl/app/reports');
  await page.getByRole('button', { name: 'Ostatnie 30 dni' }).click();
  const report = page.getByTestId('report-products');
  await report.scrollIntoViewIfNeeded();
  await expect(report.getByRole('heading')).toHaveText(/Sprzedaż produktów: 98,00\s*zł/);
  await expect(report).toContainText('Pomada matowa');
  await expect(report).toContainText(/2 szt\. · 98,00\s*zł · marża 58,00\s*zł/);
  // Task 449: "Marża" — 2 pomades × (49 − 20); the shampoo had no purchase price.
  await expect(report.getByTestId('report-products-margin')).toHaveText(
    /^Marża: 58,00\s*zł \(2 szt\. z ceną zakupu: sprzedaż 98,00\s*zł, zakup 40,00\s*zł\)$/,
  );
  await shot(page, '395-b-report-products');
  await shot(page, '449-report-margin');
  // Task 472: the sales by supplier — the pomades come from Hairgum.
  const reportBySupplier = report.getByTestId('report-products-suppliers');
  await expect(report).toContainText('Według dostawców');
  await expect(reportBySupplier).toContainText(/Hairgum\s*2 szt\. · 98,00\s*zł · marża 58,00\s*zł/);
  await reportBySupplier.scrollIntoViewIfNeeded();
  await shot(page, '472-report-products-suppliers');
  // "CSV produktów" (task 422): every sale of the period — date, specialist, quantity, price.
  const [productsCsv] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'CSV produktów' }).click(),
  ]);
  expect(productsCsv.suggestedFilename()).toMatch(/^products-.+\.csv$/);
  const productsFile = readFileSync((await productsCsv.path())!, 'utf8');
  expect(productsFile).toContain('Data;Godzina;Specjalista;Produkt;Ilość;Cena;Wartość');
  // Task 451: with the purchase price and the margin (the owner's file).
  expect(productsFile).toMatch(/;Pomada matowa;2;49,00;98,00;20,00;58,00\r\n/);
  expect(productsFile).not.toContain('Szampon');
  expect(productsFile).toContain('Razem;;;;2;;98,00');
  await page.getByRole('button', { name: 'CSV produktów' }).scrollIntoViewIfNeeded();
  await shot(page, '422-report-products-csv');
  // Task 446: "Odpisy z magazynu" — the damaged set, at today's price.
  const writeOffs = page.getByTestId('report-write-offs');
  await writeOffs.scrollIntoViewIfNeeded();
  await expect(writeOffs.getByRole('heading')).toHaveText(
    /Odpisy z magazynu: 80,00\s*zł \(1 szt\.\)/,
  );
  await expect(writeOffs).toContainText(/Zestaw\s*1 szt\. · 80,00\s*zł/);
  await shot(page, '446-report-write-offs');
  // Task 452: "Dostawy na magazyn" — the four sets (no purchase price: pieces only).
  const deliveries = page.getByTestId('report-deliveries');
  await deliveries.scrollIntoViewIfNeeded();
  await expect(deliveries.getByRole('heading')).toHaveText('Dostawy na magazyn: 4 szt.');
  await expect(deliveries).toContainText(/Zestaw\s*4 szt\./);
  await expect(deliveries.getByTestId('report-deliveries-cost')).toHaveCount(0);
  // Task 468: the set has no supplier — no "Według dostawców" for one group without a name.
  await expect(deliveries.getByTestId('report-deliveries-suppliers')).toHaveCount(0);
  await shot(page, '452-report-deliveries');
  // Task 459: "Różnice inwentaryzacji" — the set missing at the stocktake, at today's price.
  const stocktakes = page.getByTestId('report-stocktakes');
  await stocktakes.scrollIntoViewIfNeeded();
  await expect(stocktakes.getByRole('heading')).toHaveText(
    /^Różnice inwentaryzacji: brakuje 1 szt\. \(80,00\s*zł\), nadwyżka 0 szt\. \(0,00\s*zł\)$/,
  );
  await expect(stocktakes).toContainText(/Zestaw\s*brakuje 1 szt\. · 80,00\s*zł/);
  await shot(page, '459-report-stocktakes');
  // Task 460: "Leżą bez sprzedaży" — the sets and the shampoos lie on the shelf unsold.
  const idle = page.getByTestId('report-idle-products');
  await idle.scrollIntoViewIfNeeded();
  await expect(idle.getByRole('heading')).toHaveText(
    /^Leżą bez sprzedaży: 5 szt\. \(251,50\s*zł\)$/,
  );
  await expect(idle).toContainText(/Zestaw\s*2 szt\. · 160,00\s*zł · jeszcze nie sprzedany/);
  await expect(idle).toContainText(/Szampon\s*3 szt\. · 91,50\s*zł/);
  await expect(idle).not.toContainText('Pomada matowa');
  await shot(page, '460-report-idle-products');
  // Task 455: "CSV historii magazynu" — every change of the stock, with who and why.
  const [historyCsv] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'CSV historii magazynu' }).click(),
  ]);
  expect(historyCsv.suggestedFilename()).toMatch(/^stock-history-.+\.csv$/);
  const historyFile = readFileSync((await historyCsv.path())!, 'utf8');
  expect(historyFile).toContain('Data;Godzina;Produkt;Zmiana;Sztuk;Stan po;Kto;Powód\r\n');
  expect(historyFile).toMatch(/;Zestaw;Dostawa;\+4;4;[^;\r\n]+;\r\n/);
  expect(historyFile).toMatch(/;Zestaw;Odpis;-1;3;[^;\r\n]+;uszkodzone\r\n/);
  expect(historyFile).toMatch(/;Zestaw;Inwentaryzacja;-1;2;[^;\r\n]+;\r\n/);
  expect(historyFile).toMatch(/;Pomada matowa;Sprzedaż przy wizycie;-2;0;/);
  await page.getByRole('button', { name: 'CSV historii magazynu' }).scrollIntoViewIfNeeded();
  await shot(page, '455-report-stock-history-csv');

  // The client card (task 424): what Jan bought, with the total.
  await page.goto('/pl/app/clients');
  await page.locator('.list .list-row').filter({ hasText: 'Jan Kowalski' }).click();
  const bought = page.getByRole('dialog').getByTestId('client-products');
  await bought.scrollIntoViewIfNeeded();
  await expect(bought.getByRole('heading')).toHaveText(/Kupione produkty: 98,00\s*zł/);
  await expect(bought).toContainText(/Pomada matowa × 2 · 98,00\s*zł/);
  await expect(bought).not.toContainText('Szampon');
  await expect(bought).toContainText('Wszystkie zakupy klienta przy wizytach: 2 szt.');
  await shot(page, '424-client-products');
  await page.keyboard.press('Escape');
  await context.close();

  // The business app (its web preview): one more shampoo in the visit card, then the report.
  const businessApp = await serveApp('mobile-business');
  try {
    const app = await (
      await browser.newContext({
        viewport: { width: 390, height: 844 },
        locale: 'pl-PL',
        isMobile: true,
      })
    ).newPage();
    await app.goto(businessApp.url);
    await app.getByLabel('E-mail lub telefon').fill(OWNER);
    await app.getByRole('button', { name: 'Wyślij kod' }).click();
    const mail = await waitForEmail(OWNER, /Kod logowania do aplikacji salonu/);
    await app.getByLabel('Kod', { exact: true }).fill(/\b(\d{6})\b/.exec(mail.text)![1]!);
    await app.getByRole('button', { name: 'Zaloguj się' }).click();
    await expect(app.getByRole('button', { name: 'Dziś' })).toBeVisible();
    // Task 397: "Sklep" → "Produkty" — a new product from the phone.
    await app.getByRole('tab', { name: 'Sklep', exact: true }).click();
    const appList = app.getByTestId('products');
    await appList.getByRole('button', { name: '+ Dodaj produkt', exact: true }).click();
    await appList.getByLabel('Nowy produkt').fill('Wosk');
    await appList.getByLabel('Cena produktu (PLN)').last().fill('25');
    // Task 431: five pieces in stock.
    await appList.getByLabel('W magazynie (szt., puste — nie liczymy)').fill('5');
    await appList.getByRole('button', { name: 'Więcej ▸', exact: true }).click();
    // Task 435: five waxes are already few for this salon.
    await appList.getByLabel('Kończy się przy (szt., puste — bez ostrzeżenia)').fill('5');
    // Task 448: "Cena zakupu" from the phone.
    await appList.getByLabel('Cena zakupu (puste — nie wpisujemy) (PLN)').last().fill('10');
    // Task 464: "Dostawca" from the phone.
    await appList.getByLabel('Dostawca (puste — nie wpisujemy)').last().fill('Barber Hurt');
    // Task 522: "Kod kreskowy" from the phone — spaces dropped, capital letters.
    await appList.getByLabel('Kod kreskowy (puste — nie wpisujemy)').last().fill('gst wosk 1');
    await appList.getByRole('button', { name: 'Zapisz', exact: true }).click();
    await expect(appList.getByText('Wosk', { exact: true })).toBeVisible();
    await expandBusinessRow(app, 'Wosk');
    await expect(appList.getByText('zostało 5 szt. · Kończy się')).toBeVisible();
    await expect(appList.getByText(/^Cena zakupu: 10,00\s*zł$/)).toBeVisible();
    await expect(appList.getByText('Dostawca: Barber Hurt', { exact: true })).toBeVisible();
    await expandBusinessRow(app, 'Pomada matowa');
    await expect(appList.getByText(/^Cena zakupu: 20,00\s*zł$/)).toBeVisible();
    await expect(appList.getByText('Dostawca: Hairgum', { exact: true })).toBeVisible();
    // Both pomades were sold in the cabinet: none left.
    await expect(appList.getByText('Brak w magazynie', { exact: true })).toBeVisible();
    await appList.getByRole('button', { name: 'Magazyn ▸', exact: true }).click();
    // Task 435: what to order — set in the cabinet (Szampon) and here (Wosk).
    await expect(appList.getByTestId('products-to-order')).toHaveText(
      // Task 466: grouped by supplier, as in the cabinet.
      'Do zamówienia: Barber Hurt — Wosk (zostało 5 szt.); Hairgum — Pomada matowa (Brak w magazynie); bez dostawcy — Szampon (zostało 3 szt.)',
    );
    await expect(appList.getByText('Pomada matowa', { exact: true })).toBeVisible();
    await appList.getByRole('button', { name: 'Dodaj produkt' }).scrollIntoViewIfNeeded();
    await shot(app, '397-business-app-products');
    await appList.getByTestId('products-to-order').scrollIntoViewIfNeeded();
    await shot(app, '435-business-app-low-stock');
    await shot(app, '466-business-app-to-order-suppliers');
    // Task 437: "CSV stanu magazynowego" from the phone (saved in the web preview).
    const [appStock] = await Promise.all([
      app.waitForEvent('download'),
      appList.getByRole('button', { name: 'CSV stanu magazynowego' }).click(),
    ]);
    expect(appStock.suggestedFilename()).toMatch(/^stock-.+\.csv$/);
    const appStockFile = readFileSync((await appStock.path())!, 'utf8');
    expect(appStockFile).toContain('Wosk;25,00;tak;5;5;tak;10,00;Barber Hurt;0;GSTWOSK1\r\n');
    await appList.getByRole('button', { name: 'CSV stanu magazynowego' }).scrollIntoViewIfNeeded();
    await shot(app, '437-business-app-stock-csv');
    // Task 464: the file for one supplier only.
    await appList
      .getByRole('button', { name: 'Dostawca w pliku CSV: Barber Hurt', exact: true })
      .click();
    const [appSupplierStock] = await Promise.all([
      app.waitForEvent('download'),
      appList.getByRole('button', { name: 'CSV stanu magazynowego' }).click(),
    ]);
    const appSupplierFile = readFileSync((await appSupplierStock.path())!, 'utf8');
    expect(appSupplierFile).toContain('Wosk;25,00;tak;5;5;tak;10,00;Barber Hurt;0;GSTWOSK1\r\n');
    expect(appSupplierFile).not.toContain('Pomada matowa');
    await appList.getByTestId('stock-csv-supplier').scrollIntoViewIfNeeded();
    await shot(app, '464-business-app-supplier');
    // Task 470: only what to order, from every supplier — not the set (enough of it).
    await appList
      .getByRole('button', { name: 'Dostawca w pliku CSV: Wszyscy dostawcy', exact: true })
      .click();
    await appList.getByRole('button', { name: 'Tylko do zamówienia', exact: true }).click();
    const [appToOrder] = await Promise.all([
      app.waitForEvent('download'),
      appList.getByRole('button', { name: 'CSV stanu magazynowego' }).click(),
    ]);
    const appToOrderFile = readFileSync((await appToOrder.path())!, 'utf8');
    expect(appToOrderFile).toContain('Wosk;25,00;tak;5;5;tak;10,00;Barber Hurt;0;GSTWOSK1\r\n');
    expect(appToOrderFile).toContain('Szampon;30,50;tak;3;3;tak;;;0;\r\n');
    expect(appToOrderFile).toContain('Pomada matowa;');
    expect(appToOrderFile).not.toContain('Zestaw');
    await appList.getByTestId('stock-csv-to-order').scrollIntoViewIfNeeded();
    await shot(app, '470-business-app-stock-csv-to-order');
    // Task 522: "Szukaj" — the pomade by the code written in the cabinet, the wax by its own.
    await expandBusinessRow(app, 'Wosk');
    await expect(appList.getByText('Kod kreskowy: GSTWOSK1', { exact: true })).toBeVisible();
    await appList.getByTestId('products-search').fill('5901234 123457');
    await expandBusinessRow(app, 'Pomada matowa');
    await expect(appList.getByTestId('product-barcode')).toHaveCount(1);
    await expect(appList.getByText('Kod kreskowy: 5901234123457', { exact: true })).toBeVisible();
    await expect(appList.getByText('Pomada matowa', { exact: true })).toBeVisible();
    await appList.getByTestId('products-search').scrollIntoViewIfNeeded();
    await shot(app, '522-business-app-barcode-search');
    await appList.getByTestId('products-search').fill('gstwosk');
    await expandBusinessRow(app, 'Wosk');
    await expect(appList.getByText('Kod kreskowy: GSTWOSK1', { exact: true })).toBeVisible();
    await expect(appList.getByText('Pomada matowa', { exact: true })).toHaveCount(0);
    await appList.getByTestId('products-search').fill('0000');
    await expect(appList.getByTestId('products-search-none')).toHaveText(
      'Nic nie znaleziono — sprawdź nazwę albo kod.',
    );
    await appList.getByTestId('products-search').fill('');
    await app.getByRole('button', { name: '‹ Wróć' }).first().click();
    await expect(app.getByRole('button', { name: 'Dziś' })).toBeVisible();
    const jan = app.getByRole('button', { name: /Jan Kowalski/ }).first();
    for (let back = 0; back < 3 && !(await jan.isVisible()); back++) {
      await app.getByRole('button', { name: 'Poprzedni dzień' }).click();
      await app.waitForTimeout(800);
    }
    await jan.click();
    const appSold = app.getByTestId('visit-products');
    await expect(appSold).toContainText(/Pomada matowa × 2/);
    await appSold.getByRole('button', { name: 'Dodaj produkt — Szampon' }).click();
    await expect(appSold).toContainText(/PRODUKTY: 128,50\s*zł/);
    await appSold.scrollIntoViewIfNeeded();
    await shot(app, '396-business-app-visit-products');
    // Task 431: the pieces left are on the buttons; a sold-out product cannot be added.
    await expect(
      appSold.getByRole('button', { name: 'Dodaj produkt — Pomada matowa' }),
    ).toBeDisabled();
    await expect(appSold).toContainText(/Wosk · 25,00\s*zł · zostało 5 szt\. · Kończy się/);
    await expect(appSold).toContainText(/Szampon · 30,50\s*zł · zostało 2 szt\. · Kończy się/);
    await shot(app, '431-business-app-stock');
    // Task 524: the code typed in the visit card — the pomade is sold out, nothing is added.
    await appSold.getByTestId('visit-products-code').fill('5901234123457');
    await appSold.getByRole('button', { name: '+ Dodaj po kodzie' }).click();
    await expect(appSold).toContainText('Za mało sztuk w magazynie');
    await appSold.getByTestId('visit-products-code').fill('abc123');
    await appSold.getByRole('button', { name: '+ Dodaj po kodzie' }).click();
    await expect(appSold).toContainText('Nie ma produktu z kodem ABC123');
    await expect(appSold).toContainText(/PRODUKTY: 128,50\s*zł/);
    await appSold.scrollIntoViewIfNeeded();
    await shot(app, '524-a-business-app-sale-by-code');
    await app.getByRole('button', { name: '‹ Wróć' }).first().click();
    await openBusinessMenu(app, 'Raporty');
    await app.getByRole('button', { name: 'Ostatnie 30 dni' }).click();
    const appReport = app.getByTestId('report-products');
    await appReport.scrollIntoViewIfNeeded();
    await expect(appReport).toContainText(/Sprzedaż produktów: 128,50\s*zł/);
    await expect(appReport).toContainText(/1 szt\. · 30,50\s*zł/);
    // Task 449: the margin in the app's report too.
    await expect(appReport.getByTestId('report-products-margin')).toHaveText(
      /^Marża: 58,00\s*zł \(2 szt\. z ceną zakupu: sprzedaż 98,00\s*zł, zakup 40,00\s*zł\)$/,
    );
    await shot(app, '396-a-business-app-report-products');
    await shot(app, '449-business-app-margin');
    // "CSV produktów" in the app too (task 423).
    const [appCsv] = await Promise.all([
      app.waitForEvent('download'),
      appReport.getByRole('button', { name: 'CSV produktów' }).click(),
    ]);
    expect(appCsv.suggestedFilename()).toMatch(/^products-.+\.csv$/);
    const appFile = readFileSync((await appCsv.path())!, 'utf8');
    expect(appFile).toContain('Razem;;;;3;;128,50');
    // Task 439: "Dostawa" from the phone — six pomades arrived.
    await app.getByRole('button', { name: '‹ Wróć' }).first().click();
    await app.getByRole('tab', { name: 'Sklep', exact: true }).click();
    await appList.getByRole('button', { name: 'Magazyn ▸', exact: true }).click();
    await expandBusinessRow(app, 'Pomada matowa');
    await appList.getByRole('button', { name: 'Dostawa — Pomada matowa' }).click();
    await appList.getByLabel('Dostawa — Pomada matowa').fill('6');
    await appList.getByRole('button', { name: 'Przyjmij', exact: true }).click();
    await expect(appList.getByText('zostało 6 szt.', { exact: true })).toBeVisible();
    await appList.getByText('zostało 6 szt.', { exact: true }).scrollIntoViewIfNeeded();
    await shot(app, '439-business-app-restock');
    // Task 461: six pomades at two sold in 30 days last ~90 days; two shampoos at one — ~60.
    await expect(
      appList.getByText('Sprzedano w 30 dni: 2 szt. · starczy na ~90 dni', { exact: true }),
    ).toBeVisible();
    await expandBusinessRow(app, 'Szampon');
    await expect(
      appList.getByText('Sprzedano w 30 dni: 1 szt. · starczy na ~60 dni', { exact: true }),
    ).toBeVisible();
    await shot(app, '461-a-business-app-sold-30-days');
    // Task 441: "Historia" in the app — the cabinet's sale and correction, the delivery.
    await expandBusinessRow(app, 'Pomada matowa');
    await appList.getByRole('button', { name: 'Historia magazynu — Pomada matowa' }).click();
    const appHistory = appList.getByTestId('stock-history');
    await expect(appHistory).toContainText(/Dostawa · \+6 szt\. → 6/);
    await expect(appHistory).toContainText(/Sprzedaż przy wizycie · -2 szt\. → 0/);
    await expect(appHistory).toContainText(/Zmiana ręczna · \+2 szt\. → 2/);
    await appHistory.scrollIntoViewIfNeeded();
    await shot(app, '441-business-app-stock-history');
    // Task 442: 6 pomades × 49 + 2 shampoos × 30,50 + 5 waxes × 25 + 2 sets × 80 (one written off,
    // one missing at the stocktake).
    await expect(appList.getByTestId('products-stock-value')).toHaveText(
      /^Wartość magazynu: 640,00\s*zł \(15 szt\.\) — w cenach sprzedaży\.$/,
    );
    await appList.getByTestId('products-stock-value').scrollIntoViewIfNeeded();
    await shot(app, '442-business-app-stock-value');
    // Task 445: "Odpis" from the phone — a pomade used in the salon.
    await appList.getByRole('button', { name: 'Odpis — Pomada matowa' }).click();
    await appList.getByLabel('Odpis — Pomada matowa').fill('1');
    await appList.getByLabel(/^Powód/).fill('zużyte w salonie');
    await appList.getByRole('button', { name: 'Odpisz' }).click();
    await expect(appList.getByText('zostało 5 szt.', { exact: true })).toBeVisible();
    await expect(appHistory).toContainText(/Odpis · -1 szt\. → 5 · .+ · zużyte w salonie/);
    await appHistory.scrollIntoViewIfNeeded();
    await shot(app, '445-business-app-write-off');
    // Task 458: "Inwentaryzacja" from the phone — one wax more on the shelf than written.
    await appList.getByRole('button', { name: 'Inwentaryzacja', exact: true }).click();
    const appStocktake = appList.getByTestId('stocktake');
    await appStocktake.getByLabel('Na półce — Wosk').fill('6');
    await expect(appStocktake.getByText('w systemie: 5 szt. · nadwyżka 1 szt.')).toBeVisible();
    await appStocktake.scrollIntoViewIfNeeded();
    await shot(app, '458-a-business-app-stocktake');
    await appStocktake.getByRole('button', { name: 'Zapisz inwentaryzację' }).click();
    await expect(appList.getByTestId('stocktake-done')).toHaveText(
      'Inwentaryzacja zapisana: zmienione produkty: 1, brakuje 0 szt., nadwyżka 1 szt.',
    );
    // Six waxes are no longer few (the salon's "Kończy się przy" is five).
    await expandBusinessRow(app, 'Wosk');
    await expect(appList.getByText('zostało 6 szt.', { exact: true })).toBeVisible();
    await appList.getByTestId('stocktake-done').scrollIntoViewIfNeeded();
    await shot(app, '458-business-app-stocktake');
    // Task 447: "Odpisy z magazynu" in the app's report — the set and the pomade.
    await app.getByRole('button', { name: '‹ Wróć' }).first().click();
    await openBusinessMenu(app, 'Raporty');
    await app.getByRole('button', { name: 'Ostatnie 30 dni' }).click();
    // Task 472: the sales by supplier in the app — the pomades from Hairgum, the shampoo from nobody.
    const appSalesBySupplier = app.getByTestId('report-products-suppliers');
    await appSalesBySupplier.scrollIntoViewIfNeeded();
    await expect(appSalesBySupplier).toContainText(
      /Hairgum\s*2 szt\. · 98,00\s*zł · marża 58,00\s*zł/,
    );
    await expect(appSalesBySupplier).toContainText(/bez dostawcy\s*1 szt\. · 30,50\s*zł/);
    await shot(app, '472-business-app-products-suppliers');
    const appWriteOffs = app.getByTestId('report-write-offs');
    await appWriteOffs.scrollIntoViewIfNeeded();
    await expect(appWriteOffs).toContainText(/Odpisy z magazynu: 129,00\s*zł \(2 szt\.\)/);
    await expect(appWriteOffs).toContainText(/Zestaw\s*1 szt\. · 80,00\s*zł/);
    await expect(appWriteOffs).toContainText(/Pomada matowa\s*1 szt\. · 49,00\s*zł/);
    await shot(app, '447-business-app-write-offs');
    // Task 459: the set missing in the cabinet's stocktake, the wax extra in the app's.
    const appStocktakes = app.getByTestId('report-stocktakes');
    await appStocktakes.scrollIntoViewIfNeeded();
    await expect(appStocktakes).toContainText(
      /Różnice inwentaryzacji: brakuje 1 szt\. \(80,00\s*zł\), nadwyżka 1 szt\. \(25,00\s*zł\)/,
    );
    await expect(appStocktakes).toContainText(/Wosk\s*nadwyżka 1 szt\. · 25,00\s*zł/);
    await expect(appStocktakes).toContainText(/Zestaw\s*brakuje 1 szt\. · 80,00\s*zł/);
    await shot(app, '459-a-business-app-stocktakes');
    // Task 460: the shampoo sold from the phone; the sets and the waxes still lie unsold.
    const appIdle = app.getByTestId('report-idle-products');
    await appIdle.scrollIntoViewIfNeeded();
    await expect(appIdle).toContainText(/Leżą bez sprzedaży: 8 szt\. \(310,00\s*zł\)/);
    await expect(appIdle).toContainText(/Zestaw\s*2 szt\. · 160,00\s*zł · jeszcze nie sprzedany/);
    await expect(appIdle).toContainText(/Wosk\s*6 szt\. · 150,00\s*zł · jeszcze nie sprzedany/);
    await expect(appIdle).not.toContainText('Szampon');
    await shot(app, '460-a-business-app-idle-products');
    // Task 453: "Dostawy na magazyn" in the app — six pomades at 20 zł and the four sets.
    const appDeliveries = app.getByTestId('report-deliveries');
    await appDeliveries.scrollIntoViewIfNeeded();
    await expect(appDeliveries).toContainText('Dostawy na magazyn: 10 szt.');
    await expect(appDeliveries).toContainText(/Pomada matowa\s*6 szt\. · zakup 120,00\s*zł/);
    await expect(appDeliveries).toContainText(/Zestaw\s*4 szt\./);
    await expect(appDeliveries.getByTestId('report-deliveries-cost')).toHaveText(
      /^Razem w cenach zakupu: 120,00\s*zł$/,
    );
    await shot(app, '453-business-app-deliveries');
    // Task 468: by supplier — the pomades came from Hairgum, the sets from nobody written.
    const appBySupplier = appDeliveries.getByTestId('report-deliveries-suppliers');
    await expect(appBySupplier).toContainText('Według dostawców');
    await expect(appBySupplier).toContainText(/Hairgum\s*6 szt\. · zakup 120,00\s*zł/);
    await expect(appBySupplier).toContainText(/bez dostawcy\s*4 szt\./);
    await appBySupplier.scrollIntoViewIfNeeded();
    await shot(app, '468-business-app-deliveries-suppliers');
    // Task 455: "CSV historii magazynu" from the phone (saved in the web preview).
    const [appHistoryCsv] = await Promise.all([
      app.waitForEvent('download'),
      app.getByRole('button', { name: 'CSV historii magazynu' }).click(),
    ]);
    expect(appHistoryCsv.suggestedFilename()).toMatch(/^stock-history-.+\.csv$/);
    const appHistoryFile = readFileSync((await appHistoryCsv.path())!, 'utf8');
    expect(appHistoryFile).toMatch(/;Pomada matowa;Dostawa;\+6;6;/);
    expect(appHistoryFile).toMatch(/;Pomada matowa;Odpis;-1;5;[^;\r\n]+;zużyte w salonie\r\n/);
    await app.getByRole('button', { name: 'CSV historii magazynu' }).scrollIntoViewIfNeeded();
    await shot(app, '455-business-app-stock-history-csv');
  } finally {
    businessApp.server.close();
  }
});
