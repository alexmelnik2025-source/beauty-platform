import {
  expect,
  test,
  type APIRequestContext,
  type APIResponse,
  type Page,
} from '@playwright/test';
import { freshAddress } from './addresses';
import { waitForEmail } from './mailpit';
import { serveApp } from './mobile-app';

/**
 * Task 491: "Bony podarunkowe" in the cabinet. The owner sells a 200 zł voucher for Jan, finds it
 * by the code typed in small letters, takes 120 zł with it and sees 80 zł left in the list
 * (screenshots 491, 491a); then cancels a voucher sold by mistake (screenshot 491b).
 * Task 493: the vouchers in the cabinet's report (screenshot 493).
 * Task 492: the same in the business app — the code checked, a payment taken and a new voucher
 * sold on the phone (screenshots 492, 492a).
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

  // The voucher sold by mistake is cancelled.
  await list.getByRole('button', { name: `Anuluj bon ${mistake.code}` }).click();
  await list.getByRole('button', { name: 'Tak, anuluj' }).click();
  await expect(list.getByRole('status')).toHaveText(`Bon ${mistake.code} anulowany.`);
  await expect(list.getByText(/Do wykorzystania na ważnych bonach: 80,00\s?zł/)).toBeVisible();
  await expect(list.getByText('Anulowany', { exact: true })).toBeVisible();
  await shot(page, '491b');

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
  await section.scrollIntoViewIfNeeded();
  await section.screenshot({ path: 'e2e/screenshots/493.png' });
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
    });
    const phone = await context.newPage();
    await phone.goto(businessApp.url);
    await phone.getByLabel('E-mail lub telefon').fill(email);
    await phone.getByRole('button', { name: 'Wyślij kod' }).click();
    const mail = await waitForEmail(email, /Kod logowania do aplikacji salonu/);
    await phone.getByLabel('Kod', { exact: true }).fill(/\b(\d{6})\b/.exec(mail.text)![1]!);
    await phone.getByRole('button', { name: 'Zaloguj się' }).click();
    await expect(phone.getByRole('button', { name: 'Dziś' })).toBeVisible();

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
    await context.close();
  } finally {
    businessApp.server.close();
  }
});
