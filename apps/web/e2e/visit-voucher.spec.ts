import {
  expect,
  test,
  type APIRequestContext,
  type APIResponse,
  type Page,
} from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { freshAddress } from './addresses';
import { waitForEmail } from './mailpit';
import { serveApp } from './mobile-app';

/**
 * Task 541: "Zapłać bonem" in the visit card. Jan came for a 90 zł haircut and pays 50 zł of it
 * with the 50 zł voucher he got for his birthday: the code typed as it is printed, the amount
 * filled in from the visit price and changed; the payment is listed in the card (screenshot
 * 541) and in the voucher's own history, marked with the service. A code of no voucher is named.
 * Task 542: the same in the business app — the other 40 zł from a second voucher (screenshot 542).
 * Task 545: the card says what is left to pay ("Do dopłaty za wizytę: 40,00 zł") or that the
 * vouchers covered the whole visit.
 */

const PASSWORD = 'e2e-password-123';
const run = Date.now().toString(36);
const OWNER = `visit-voucher-owner-${run}@example.com`;
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

test('the client pays a part of the visit with a gift voucher in the visit card', async ({
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
        customer: { name: 'Jan Kowalski', phone: '+48600000541' },
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
  const voucher = await json<{ id: string; code: string }>(
    await request.post(`${base}/gift-vouchers`, {
      headers: owner,
      data: { amountGrosze: 5000, recipient: 'Jan Kowalski' },
    }),
  );

  const context = await browser.newContext({
    viewport: DESKTOP,
    locale: 'pl-PL',
    timezoneId: 'Europe/Warsaw',
    // Sign-ins from an address of its own: the API limits them per address.
    extraHTTPHeaders: freshAddress(),
  });
  const page = await context.newPage();
  await page.goto('/pl/login');
  await page.getByLabel('E-mail').fill(OWNER);
  await page.getByLabel('Hasło').fill(PASSWORD);
  await page.getByRole('button', { name: 'Zaloguj się' }).click();
  await page.waitForURL(/\/pl\/app/);
  await page.goto(`/pl/app/calendar?date=${visit.date}`);
  await page.getByRole('button', { name: /Jan Kowalski/ }).click();

  const card = page.getByRole('dialog').getByTestId('visit-vouchers');
  await card.getByRole('button', { name: 'Klient płaci bonem podarunkowym?' }).click();
  // What is left to pay for the visit is filled in.
  await expect(card.getByTestId('visit-voucher-amount')).toHaveValue('90');
  // Task 682: no code yet — said under "Kod bonu" (the button is not silently off).
  await card.getByRole('button', { name: 'Zapłać bonem' }).click();
  await expect(card.getByTestId('visit-voucher-code')).toHaveAccessibleDescription(
    'Uzupełnij to pole.',
  );
  await expect(card.getByTestId('visit-voucher-code')).toBeFocused();
  await shot(page, '682-visit-voucher-code-required');
  // A code of no voucher: said so, nothing is taken.
  await card.getByTestId('visit-voucher-code').fill('ZZZZ-ZZZZ');
  await card.getByRole('button', { name: 'Zapłać bonem' }).click();
  await expect(card).toContainText('Nie ma bonu z tym kodem w tym salonie.');
  // Task 673: under "Kod bonu", which keeps the cursor.
  await expect(card.getByTestId('visit-voucher-code')).toHaveAccessibleDescription(
    /Nie ma bonu z tym kodem w tym salonie\.$/,
  );
  await expect(card.getByTestId('visit-voucher-code')).toBeFocused();
  await shot(page, '673-visit-voucher-code-error');
  // More than is left on the voucher: the server refuses.
  const printed = `${voucher.code.slice(0, 4)}-${voucher.code.slice(4)}`;
  await card.getByTestId('visit-voucher-code').fill(printed.toLowerCase());
  await card.getByRole('button', { name: 'Zapłać bonem' }).click();
  await expect(card).toContainText('Na bonie zostało mniej');
  // Task 673: under the amount.
  await expect(card.getByTestId('visit-voucher-amount')).toHaveAccessibleDescription(
    /Na bonie zostało mniej/,
  );
  await expect(card.getByTestId('visit-voucher-code')).not.toHaveAttribute('aria-invalid', 'true');
  await shot(page, '673-visit-voucher-amount-error');
  await card.getByTestId('visit-voucher-amount').fill('50');
  await card.getByRole('button', { name: 'Zapłać bonem' }).click();
  await expect(card.getByRole('status')).toHaveText(
    /Zapłacono bonem 50,00\s?zł\. Zostało 0,00\s?zł\./,
  );
  await expect(card).toContainText(/Zapłacono bonem: 50,00\s?zł/);
  // Task 545: what the client still pays for the visit.
  await expect(card.getByTestId('visit-voucher-left')).toHaveText(
    /Do dopłaty za wizytę: 40,00\s?zł/,
  );
  await expect(card.getByText(printed)).toBeVisible();
  await card.scrollIntoViewIfNeeded();
  await shot(page, '541-visit-paid-with-voucher');

  // The voucher's own history: the payment, with the service it was for.
  const details = await json<{
    voucher: { balanceGrosze: number };
    uses: { amountGrosze: number; note: string | null; appointmentId: string | null }[];
  }>(await request.get(`${base}/gift-vouchers/${voucher.id}`, { headers: owner }));
  expect(details.voucher.balanceGrosze).toBe(0);
  expect(details.uses).toEqual([
    expect.objectContaining({
      amountGrosze: 5000,
      note: 'Strzyżenie męskie',
      appointmentId: booked.id,
    }),
  ]);
  await context.close();

  // Task 542: the business app — the 40 zł left are paid with a second voucher.
  const second = await json<{ id: string; code: string }>(
    await request.post(`${base}/gift-vouchers`, {
      headers: owner,
      data: { amountGrosze: 10000 },
    }),
  );
  const businessApp = await serveApp('mobile-business');
  try {
    const phone = await browser.newContext({
      viewport: { width: 390, height: 844 },
      locale: 'pl-PL',
      timezoneId: 'Europe/Warsaw',
      isMobile: true,
      extraHTTPHeaders: freshAddress(),
    });
    const app = await phone.newPage();
    await app.goto(businessApp.url);
    await app.getByLabel('E-mail lub telefon').fill(OWNER);
    await app.getByRole('button', { name: 'Wyślij kod' }).click();
    const mail = await waitForEmail(OWNER, /Kod logowania do aplikacji salonu/);
    await app.getByLabel('Kod', { exact: true }).fill(/\b(\d{6})\b/.exec(mail.text)![1]!);
    await app.getByRole('button', { name: 'Zaloguj się' }).click();
    await expect(app.getByRole('button', { name: 'Dziś' })).toBeVisible();
    const jan = app.getByRole('button', { name: /Jan Kowalski/ }).first();
    for (let back = 0; back < 3 && !(await jan.isVisible()); back++) {
      await app.getByRole('button', { name: 'Poprzedni dzień' }).click();
      await app.waitForTimeout(800);
    }
    await jan.click();
    const section = app.getByTestId('visit-vouchers');
    await expect(section).toContainText(/Zapłacono bonem: 50,00\s?zł/);
    await section.getByRole('button', { name: 'Klient płaci bonem podarunkowym?' }).click();
    await expect(section.getByTestId('visit-voucher-amount')).toHaveValue('40');
    await section.getByTestId('visit-voucher-code').fill(second.code);
    await section.getByRole('button', { name: 'Zapłać bonem' }).click();
    await expect(section).toContainText(/Zapłacono bonem 40,00\s?zł\. Zostało 60,00\s?zł\./);
    await expect(section).toContainText(/Zapłacono bonem: 90,00\s?zł/);
    await expect(section.getByTestId('visit-voucher-left')).toHaveText('Bon pokrył całą wizytę.');
    await expect(section).toContainText(`${second.code.slice(0, 4)}-${second.code.slice(4)}`);
    await section.scrollIntoViewIfNeeded();
    await shot(app, '542-business-app-visit-paid-with-voucher');
    await phone.close();
  } finally {
    businessApp.server.close();
  }
});
