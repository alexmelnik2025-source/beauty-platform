import {
  expect,
  test,
  type APIRequestContext,
  type APIResponse,
  type Page,
} from '@playwright/test';
import { freshAddress } from './addresses';
import { waitForEmail } from './mailpit';

/**
 * Task 491: "Bony podarunkowe" in the cabinet. The owner sells a 200 zł voucher for Jan, finds it
 * by the code typed in small letters, takes 120 zł with it and sees 80 zł left in the list
 * (screenshots 491, 491a); then cancels a voucher sold by mistake (screenshot 491b).
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
  await expect(list.getByText('Anulowany')).toBeVisible();
  await shot(page, '491b');
  await desk.close();
});
