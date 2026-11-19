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

/**
 * Task 541: "Zapłać bonem" in the visit card. Jan came for a 90 zł haircut and pays 50 zł of it
 * with the 50 zł voucher he got for his birthday: the code typed as it is printed, the amount
 * filled in from the visit price and changed; the payment is listed in the card (screenshot
 * 541) and in the voucher's own history, marked with the service. A code of no voucher is named.
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

  const context = await browser.newContext({ viewport: DESKTOP, locale: 'pl-PL' });
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
  // A code of no voucher: said so, nothing is taken.
  await card.getByTestId('visit-voucher-code').fill('ZZZZ-ZZZZ');
  await card.getByRole('button', { name: 'Zapłać bonem' }).click();
  await expect(card).toContainText('Nie ma bonu z tym kodem w tym salonie.');
  // More than is left on the voucher: the server refuses.
  const printed = `${voucher.code.slice(0, 4)}-${voucher.code.slice(4)}`;
  await card.getByTestId('visit-voucher-code').fill(printed.toLowerCase());
  await card.getByRole('button', { name: 'Zapłać bonem' }).click();
  await expect(card).toContainText('Na bonie zostało mniej');
  await card.getByTestId('visit-voucher-amount').fill('50');
  await card.getByRole('button', { name: 'Zapłać bonem' }).click();
  await expect(card.getByRole('status')).toHaveText(
    /Zapłacono bonem 50,00\s?zł\. Zostało 0,00\s?zł\./,
  );
  await expect(card).toContainText(/Zapłacono bonem: 50,00\s?zł/);
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
});
