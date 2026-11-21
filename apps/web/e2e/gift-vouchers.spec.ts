import {
  expect,
  test,
  type APIRequestContext,
  type APIResponse,
  type Page,
} from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { freshAddress } from './addresses';
import { waitForEmail } from './mailpit';
import { serveApp } from './mobile-app';

/**
 * Task 491: "Bony podarunkowe" in the cabinet. The owner sells a 200 zł voucher for Jan, finds it
 * by the code typed in small letters, takes 120 zł with it and sees 80 zł left in the list
 * (screenshots 491, 491a); then cancels a voucher sold by mistake (screenshot 491b).
 * Task 494: "Pobierz CSV bonów" (screenshot 494); task 534: "Pobierz CSV płatności bonami".
 * Task 496: "Drukuj bon" — the card to hand to the client (screenshot 496).
 * Task 499: "Zmień bon" — a last day and the names fixed (screenshot 499).
 * Tasks 501–502: "Kończą się w ciągu 30 dni", the list filtered and searched (screenshots 501, 502).
 * Task 531: "Cofnij płatność" — a payment noted by mistake is undone (screenshot 531).
 * Task 493: the vouchers in the cabinet's report (screenshot 493); task 551: by how they were paid
 * (screenshot 551).
 * Task 492: the same in the business app — the code checked, a payment taken and a new voucher
 * sold on the phone (screenshots 492, 492a); task 495: "Pobierz CSV bonów" there (screenshot 495),
 * task 535: "Pobierz CSV płatności bonami";
 * task 497: "Wyślij bon" as a message (screenshot 497); task 500: "Zmień bon" (screenshot 500);
 * tasks 501, 503: "Wkrótce wygasa" and "Pokaż" in the list (screenshots 501a, 503); task 532:
 * "Cofnij płatność" (screenshot 532).
 */

const PASSWORD = 'e2e-password-123';
const run = Date.now().toString(36);
const OWNER = `voucher-owner-${run}@example.com`;

const shot = (page: Page, name: string) =>
  page.screenshot({ path: `e2e/screenshots/${name}.png`, fullPage: true });

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

test('the owner sells a gift voucher, takes a payment with it and cancels another', async ({
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
  // A voucher sold earlier by mistake.
  const mistake = await json<{ code: string }>(
    await request.post(`/v1/organizations/${org.id}/locations/${location.id}/gift-vouchers`, {
      headers: owner,
      data: { amountGrosze: 5000, recipient: 'Pomyłka' },
    }),
  );

  const desk = await browser.newContext({ locale: 'pl-PL', timezoneId: 'Europe/Warsaw' });
  const page = await desk.newPage();
  await page.goto('/pl/login');
  await page.getByLabel('E-mail').fill(OWNER);
  await page.getByLabel('Hasło').fill(PASSWORD);
  await page.getByRole('button', { name: 'Zaloguj się' }).click();
  await page.waitForURL(/\/pl\/app/);
  await page.goto('/pl/app/vouchers');
  await expect(page.getByRole('heading', { name: 'Bony podarunkowe', level: 1 })).toBeVisible();

  // "Nowy bon": 200 zł for Jan.
  const sell = page.getByRole('region', { name: 'Nowy bon' });
  await sell.getByLabel('Kwota bonu').fill('200');
  await sell.getByLabel(/^Dla kogo/).fill('Jan Kowalski');
  await sell.getByLabel(/^Notatka/).fill('Na urodziny');
  await sell.getByRole('button', { name: 'Sprzedaj bon' }).click();
  const soldText = await sell.getByRole('status').textContent();
  const code = /Kod do wpisania na bonie: ([A-Z0-9]{8})/.exec(soldText ?? '')?.[1];
  expect(code, soldText ?? '').toBeTruthy();

  const list = page.getByRole('region', { name: 'Sprzedane bony' });
  await expect(list.getByText(code!)).toBeVisible();
  await expect(list.getByText(/Do wykorzystania na ważnych bonach: 250,00\s?zł/)).toBeVisible();

  // "Sprawdź bon": the code as a client might say it — small letters with a dash.
  const check = page.getByRole('region', { name: 'Sprawdź bon' });
  await check.getByLabel('Kod bonu').fill(`${code!.slice(0, 4).toLowerCase()}-${code!.slice(4)}`);
  await check.getByRole('button', { name: 'Sprawdź' }).click();
  const card = check.getByRole('group', { name: code! });
  await expect(card.getByText(/Zostało 200,00\s?zł z 200,00\s?zł/)).toBeVisible();
  await expect(card.getByText('Dla: Jan Kowalski')).toBeVisible();
  await expect(card.getByText('Bonem jeszcze nie płacono.')).toBeVisible();
  await shot(page, '491');

  // Task 496: "Drukuj bon" — only the card with the salon, the amount, for whom and the code.
  await page.evaluate(() => {
    const w = window as unknown as { printed: number };
    w.printed = 0;
    window.print = () => {
      w.printed++;
    };
  });
  await card.getByRole('button', { name: 'Drukuj bon' }).click();
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { printed: number }).printed))
    .toBe(1);
  await page.emulateMedia({ media: 'print' });
  const printed = page.getByTestId('voucher-print');
  await expect(printed).toBeVisible();
  await expect(printed.getByText('Bon podarunkowy')).toBeVisible();
  await expect(printed.getByText(/200,00\s?zł/)).toBeVisible();
  await expect(printed.getByText(`${code!.slice(0, 4)}-${code!.slice(4)}`)).toBeVisible();
  await expect(printed.getByText('Dla: Jan Kowalski')).toBeVisible();
  await shot(page, '496');
  await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
  await page.emulateMedia({ media: 'screen' });
  await expect(page.locator('html')).not.toHaveClass(/print-voucher/);
  await expect(printed).toBeHidden();

  // More than is left is refused; 120 zł is taken.
  await card.getByLabel('Kwota do zapłaty bonem').fill('250');
  await card.getByRole('button', { name: 'Zapłać bonem' }).click();
  await expect(card.getByText('Na bonie zostało mniej', { exact: false })).toBeVisible();
  await card.getByLabel('Kwota do zapłaty bonem').fill('120');
  await card.getByLabel(/^Za co/).fill('Strzyżenie i broda');
  await card.getByRole('button', { name: 'Zapłać bonem' }).click();
  await expect(card.getByRole('status')).toHaveText(
    /Zapłacono bonem 120,00\s?zł\. Zostało 80,00\s?zł\./,
  );
  await expect(card.getByText(/Strzyżenie i broda/)).toBeVisible();
  await expect(list.getByText(/Do wykorzystania na ważnych bonach: 130,00\s?zł/)).toBeVisible();
  await shot(page, '491a');

  // Task 531: a payment noted by mistake is undone — the amount goes back to the voucher.
  await card.getByLabel('Kwota do zapłaty bonem').fill('30');
  await card.getByRole('button', { name: 'Zapłać bonem' }).click();
  await expect(card.getByRole('status')).toHaveText(/Zostało 50,00\s?zł\./);
  const wrong = card.getByRole('listitem').filter({ hasText: /\b30,00/ });
  await wrong.getByRole('button', { name: 'Cofnij płatność' }).click();
  await wrong.getByRole('button', { name: 'Tak, cofnij' }).click();
  await expect(card.getByRole('status')).toHaveText(
    /Płatność 30,00\s?zł cofnięta — na bonie zostało 80,00\s?zł\./,
  );
  await expect(wrong.getByText(/Cofnięta/)).toBeVisible();
  await expect(wrong.getByRole('button', { name: 'Cofnij płatność' })).toHaveCount(0);
  await shot(page, '531');

  // Task 499: "Zmień bon" — a last day next summer, both names; the amount stays.
  const year = new Date().getFullYear() + 1;
  await card.getByRole('button', { name: 'Zmień bon' }).click();
  const edit = card.getByRole('form', { name: `Zmień bon ${code!}` });
  await expect(edit.getByText('Kwoty bonu nie zmienisz.', { exact: false })).toBeVisible();
  await expect(edit.getByLabel('Ważny do')).toBeFocused();
  await expect(edit.getByLabel('Dla kogo')).toHaveValue('Jan Kowalski');
  await edit.getByLabel('Ważny do').fill(`${year}-06-30`);
  await edit.getByLabel('Dla kogo').fill('Jan i Ola Kowalscy');
  await shot(page, '499');
  await edit.getByRole('button', { name: 'Zapisz' }).click();
  await expect(card.getByRole('status')).toHaveText(`Zapisano zmiany bonu ${code!}.`);
  // The form closed: the cursor is back on "Zmień bon".
  await expect(card.getByRole('button', { name: 'Zmień bon' })).toBeFocused();
  await expect(card.getByText('Dla: Jan i Ola Kowalscy')).toBeVisible();
  await expect(card.getByText(/Ważny do .*30 czerwca/)).toBeVisible();
  await expect(card.getByText(/Zostało 80,00\s?zł z 200,00\s?zł/)).toBeVisible();
  await expect(list.getByText('Dla: Jan i Ola Kowalscy')).toBeVisible();
  await shot(page, '499a');

  // The voucher sold by mistake is cancelled.
  await list.getByRole('button', { name: `Anuluj bon ${mistake.code}` }).click();
  await list.getByRole('button', { name: 'Tak, anuluj' }).click();
  await expect(list.getByRole('status')).toHaveText(`Bon ${mistake.code} anulowany.`);
  await expect(list.getByText(/Do wykorzystania na ważnych bonach: 80,00\s?zł/)).toBeVisible();
  await expect(list.getByRole('listitem').getByText('Anulowany', { exact: true })).toBeVisible();
  await shot(page, '491b');

  // Task 494: "Pobierz CSV bonów" — every voucher for the accountant.
  const [vouchersCsv] = await Promise.all([
    page.waitForEvent('download'),
    list.getByRole('button', { name: 'Pobierz CSV bonów' }).click(),
  ]);
  expect(vouchersCsv.suggestedFilename()).toMatch(/^vouchers-.+-\d{4}-\d{2}-\d{2}\.csv$/);
  const vouchersText = await readFile((await vouchersCsv.path())!, 'utf8');
  expect(vouchersText).toContain('Kod;Data sprzedaży;Sprzedał(a);Dla kogo;Kwota;Wykorzystano');
  expect(vouchersText).toContain(';200,00;120,00;80,00;');
  expect(vouchersText).toContain(`${mistake.code};`);
  expect(vouchersText).toContain(';Anulowany;');
  await shot(page, '494');

  // Task 534: "Pobierz CSV płatności bonami" — every payment, the undone one with its day.
  const [usesCsv] = await Promise.all([
    page.waitForEvent('download'),
    list.getByRole('button', { name: 'Pobierz CSV płatności bonami' }).click(),
  ]);
  expect(usesCsv.suggestedFilename()).toMatch(/^voucher-payments-.+-\d{4}-\d{2}-\d{2}\.csv$/);
  const usesText = await readFile((await usesCsv.path())!, 'utf8');
  expect(usesText).toContain(
    'Data;Godzina;Kod bonu;Dla kogo;Kwota;Za co;Przyjął(a);Cofnięta;Wizyta;Specjalista wizyty',
  );
  expect(usesText).toContain(
    `;${code!};Jan i Ola Kowalscy;120,00;Strzyżenie i broda;Aleksander Owner;;;\r\n`,
  );
  expect(usesText).toMatch(/;Jan i Ola Kowalscy;30,00;;Aleksander Owner;\d{4}-\d{2}-\d{2};;\r\n/);

  // Task 493: the report — one voucher sold (the cancelled one left out), 120 zł paid with
  // vouchers, 80 zł left today.
  await page.goto('/pl/app/reports');
  await page.getByRole('button', { name: 'Ostatnie 30 dni' }).click();
  const section = page.getByTestId('report-gift-vouchers');
  await expect(section.getByText(/Sprzedane bony: 1 \(200,00\s?zł\)/)).toBeVisible();
  await expect(section.getByText(/Zapłacono bonami: 120,00\s?zł \(płatności: 1\)/)).toBeVisible();
  await expect(
    section.getByText(/Do wykorzystania na ważnych bonach dziś: 80,00\s?zł/),
  ).toBeVisible();
  // Task 551: the voucher sold by how the client paid for it (not given here).
  await expect(section.getByTestId('report-vouchers-sold-by')).toHaveText(
    /w tym Nie podano: 1 \(200,00\s?zł\)/,
  );
  await section.scrollIntoViewIfNeeded();
  await section.screenshot({ path: 'e2e/screenshots/493.png' });
  await section.screenshot({ path: 'e2e/screenshots/551.png' });

  // Task 501: a voucher for Marek that ends in 10 days.
  const soonDay = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10);
  const soon = await json<{ code: string }>(
    await request.post(`/v1/organizations/${org.id}/locations/${location.id}/gift-vouchers`, {
      headers: owner,
      data: { amountGrosze: 3000, recipient: 'Marek', validUntil: soonDay },
    }),
  );
  await page.goto('/pl/app/vouchers');
  const all = page.getByRole('region', { name: 'Sprzedane bony' });
  await expect(all.getByTestId('vouchers-expiring')).toHaveText(
    /Kończą się w ciągu 30 dni: 1 szt\., do wykorzystania 30,00\s?zł/,
  );
  const soonRow = all.getByRole('listitem').filter({ hasText: soon.code });
  await expect(soonRow.getByText('Wkrótce wygasa')).toBeVisible();
  await expect(all.getByRole('listitem')).toHaveCount(3);
  await shot(page, '501');

  // Task 502: only the ones ending soon; then a search by name over all of them.
  await all.getByRole('combobox', { name: 'Pokaż' }).selectOption({ label: 'Wkrótce wygasają' });
  await expect(all.getByRole('listitem')).toHaveCount(1);
  await expect(all.getByText(soon.code)).toBeVisible();
  await all.getByRole('combobox', { name: 'Pokaż' }).selectOption({ label: 'Wszystkie' });
  await all.getByLabel('Szukaj: kod lub dla kogo').fill('kowal');
  await expect(all.getByRole('listitem')).toHaveCount(1);
  await expect(all.getByText('Dla: Jan i Ola Kowalscy')).toBeVisible();
  await shot(page, '502');
  await all.getByLabel('Szukaj: kod lub dla kogo').fill(mistake.code.slice(0, 4).toLowerCase());
  await expect(all.getByRole('listitem')).toHaveCount(1);
  await all.getByRole('combobox', { name: 'Pokaż' }).selectOption({ label: 'Ważny' });
  await expect(all.getByText('Żaden bon nie pasuje.')).toBeVisible();
  await desk.close();
});

test('business app: check a gift voucher, pay with it and sell a new one', async ({
  browser,
  request,
}) => {
  const email = `voucher-app-${run}@example.com`;
  const owner = await verifiedUser(request, email, 'Aleksander Owner');
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
  const voucher = await json<{ code: string }>(
    await request.post(`/v1/organizations/${org.id}/locations/${location.id}/gift-vouchers`, {
      headers: owner,
      data: { amountGrosze: 15000, recipient: 'Ola' },
    }),
  );

  const businessApp = await serveApp('mobile-business');
  try {
    const address = freshAddress();
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      locale: 'pl-PL',
      timezoneId: 'Europe/Warsaw',
      isMobile: true,
      extraHTTPHeaders: address,
      permissions: ['clipboard-read', 'clipboard-write'],
    });
    const phone = await context.newPage();
    await phone.goto(businessApp.url);
    await phone.getByLabel('E-mail lub telefon').fill(email);
    await phone.getByRole('button', { name: 'Wyślij kod' }).click();
    const mail = await waitForEmail(email, /Kod logowania do aplikacji salonu/);
    await phone.getByLabel('Kod', { exact: true }).fill(/\b(\d{6})\b/.exec(mail.text)![1]!);
    await phone.getByRole('button', { name: 'Zaloguj się' }).click();
    await expect(phone.getByRole('button', { name: 'Dziś' })).toBeVisible();

    await phone.getByRole('button', { name: 'Więcej', exact: true }).click();
    await phone.getByRole('button', { name: 'Bony podarunkowe' }).click();
    await expect(phone.getByRole('heading', { name: 'Bony podarunkowe' })).toBeVisible();
    await phone.getByLabel('Kod bonu').fill(voucher.code.toLowerCase());
    await phone.getByRole('button', { name: 'Sprawdź', exact: true }).click();
    await expect(phone.getByText(`${voucher.code} · Ważny`).first()).toBeVisible();
    await expect(phone.getByText('Dla: Ola').first()).toBeVisible();
    await phone.getByLabel('Kwota do zapłaty bonem').fill('50');
    await phone.getByRole('button', { name: 'Zapłać bonem' }).click();
    await expect(
      phone.getByText(/Zapłacono bonem 50,00\s?zł\. Zostało 100,00\s?zł\./),
    ).toBeVisible();
    await shot(phone, '492');

    // Task 532: a payment of 20 zł noted by mistake is undone — the amount goes back.
    await phone.getByLabel('Kwota do zapłaty bonem').fill('20');
    await phone.getByRole('button', { name: 'Zapłać bonem' }).click();
    await expect(
      phone.getByText(/Zapłacono bonem 20,00\s?zł\. Zostało 80,00\s?zł\./),
    ).toBeVisible();
    await phone.getByRole('button', { name: /^Cofnij płatność 20,00/ }).click();
    await phone.getByRole('button', { name: 'Tak, cofnij' }).click();
    await expect(
      phone.getByText(/Płatność 20,00\s?zł cofnięta — na bonie zostało 100,00\s?zł\./),
    ).toBeVisible();
    await expect(phone.getByText(/^Cofnięta /)).toBeVisible();
    await expect(phone.getByRole('button', { name: /^Cofnij płatność 20,00/ })).toHaveCount(0);
    await shot(phone, '532');

    // Task 497: "Wyślij bon" — the voucher as a message (in the web preview it is copied).
    await phone.getByRole('button', { name: 'Wyślij bon' }).click();
    await expect(phone.getByText('Bon skopiowany — wklej go w wiadomości.')).toBeVisible();
    const sent = await phone.evaluate(() => navigator.clipboard.readText());
    expect(sent).toContain('Bon podarunkowy — Gestalt Barbershop');
    expect(sent).toMatch(/Zostało 100,00\s?zł z 150,00\s?zł/);
    expect(sent).toContain('Dla: Ola');
    expect(sent).toContain(`Kod: ${voucher.code.slice(0, 4)}-${voucher.code.slice(4)}`);
    await shot(phone, '497');

    // Task 500: "Zmień bon" — a last day and the full name; the amount stays.
    const editUntil = `${new Date().getFullYear() + 1}-03-31`;
    await phone.getByRole('button', { name: 'Zmień bon' }).click();
    await expect(phone.getByText('Kwoty bonu nie zmienisz.', { exact: false })).toBeVisible();
    // The card's fields come before the "Nowy bon" ones.
    await phone
      .getByLabel(/^Ważny do/)
      .first()
      .fill(editUntil);
    await expect(phone.getByLabel(/^Dla kogo/).first()).toHaveValue('Ola');
    await phone
      .getByLabel(/^Dla kogo/)
      .first()
      .fill('Ola Nowak');
    await phone.getByRole('button', { name: 'Zapisz zmiany' }).click();
    await expect(phone.getByText(`Zapisano zmiany bonu ${voucher.code}.`)).toBeVisible();
    await expect(phone.getByText('Dla: Ola Nowak').first()).toBeVisible();
    await expect(phone.getByText(/Zostało 100,00\s?zł z 150,00\s?zł/).first()).toBeVisible();
    await shot(phone, '500');

    // A new voucher: 100 zł until the end of next year.
    const until = `${new Date().getFullYear() + 1}-12-31`;
    await phone.getByLabel('Kwota bonu').fill('100');
    await phone.getByLabel(/^Ważny do/).fill(until);
    await phone.getByLabel(/^Dla kogo/).fill('Piotr');
    await phone.getByRole('button', { name: 'Sprzedaj bon' }).click();
    await expect(
      phone.getByText(/Bon sprzedany\. Kod do wpisania na bonie: [A-Z0-9]{8}/),
    ).toBeVisible();
    await expect(phone.getByText(/Do wykorzystania na ważnych bonach: 200,00\s?zł/)).toBeVisible();
    await shot(phone, '492a');

    // Task 495: "Pobierz CSV bonów" on the phone (in the browser preview — a download).
    const [appCsv] = await Promise.all([
      phone.waitForEvent('download'),
      phone.getByRole('button', { name: 'Pobierz CSV bonów' }).click(),
    ]);
    const appCsvText = await readFile((await appCsv.path())!, 'utf8');
    expect(appCsvText).toContain(`${voucher.code};`);
    expect(appCsvText).toContain(';Ola Nowak;150,00;50,00;100,00;');
    expect(appCsvText).toContain(';Piotr;100,00;0,00;100,00;');
    await shot(phone, '495');

    // Task 535: "Pobierz CSV płatności bonami" on the phone — the undone 20 zł with its day.
    const [appUses] = await Promise.all([
      phone.waitForEvent('download'),
      phone.getByRole('button', { name: 'Pobierz CSV płatności bonami' }).click(),
    ]);
    const appUsesText = await readFile((await appUses.path())!, 'utf8');
    expect(appUsesText).toContain(`;${voucher.code};Ola Nowak;50,00;;Aleksander Owner;;;\r\n`);
    expect(appUsesText).toMatch(/;Ola Nowak;20,00;;Aleksander Owner;\d{4}-\d{2}-\d{2};;\r\n/);

    // Tasks 501, 503: a voucher for Marek that ends in 10 days — marked in the list and opened
    // from it without typing the code.
    const soonDay = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10);
    const soon = await json<{ code: string }>(
      await request.post(`/v1/organizations/${org.id}/locations/${location.id}/gift-vouchers`, {
        headers: owner,
        data: { amountGrosze: 3000, recipient: 'Marek', validUntil: soonDay },
      }),
    );
    await phone.getByRole('button', { name: '‹ Wróć' }).click();
    await phone.getByRole('button', { name: 'Więcej', exact: true }).click();
    await phone.getByRole('button', { name: 'Bony podarunkowe' }).click();
    await expect(
      phone.getByText(/Kończą się w ciągu 30 dni: 1 szt\., do wykorzystania 30,00\s?zł/),
    ).toBeVisible();
    await expect(phone.getByText('Wkrótce wygasa')).toHaveCount(1);
    await shot(phone, '501a');
    await phone.getByRole('button', { name: `Pokaż ${soon.code}` }).click();
    await expect(phone.getByText(`${soon.code} · Ważny`).first()).toBeVisible();
    await expect(phone.getByRole('button', { name: 'Zapłać bonem' })).toBeVisible();
    await expect(phone.getByText('Bonem jeszcze nie płacono.')).toBeVisible();
    await expect(phone.getByLabel('Kod bonu')).toHaveValue(soon.code);
    await shot(phone, '503');
    await context.close();
  } finally {
    businessApp.server.close();
  }
});
