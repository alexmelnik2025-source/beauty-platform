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
 * Tasks 546–548: gift vouchers in "Zamknij kasę". Yesterday Jan paid for a 90 zł haircut in cash,
 * 50 zł of it with a gift voucher — so only 40 zł of it is in the till; the same day a 100 zł
 * voucher was sold for cash — that is in the till. The form says so (screenshot 546). A voucher
 * sold in "Bony podarunkowe" with "Jak klient zapłacił za bon" shows how it was paid (547).
 * Task 548: the same in the business app — the till of that day and how vouchers were paid (548,
 * 548-a).
 */

const PASSWORD = 'e2e-password-123';
const run = Date.now().toString(36);
const OWNER = `till-voucher-owner-${run}@example.com`;
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

test('vouchers in the till: a visit paid partly with a voucher, a voucher sold for cash', async ({
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
  // Visits can't be booked in the past: book tomorrow at 10:00 UTC and move it a day back.
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
          phone: '+48600000546',
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
  await json(
    await request.post(`${base}/appointments/${booked.id}/payment`, {
      headers: owner,
      data: { version: visit.version, paid: true, method: 'cash' },
    }),
  );

  const psql = (sql: string) =>
    execFileSync('psql', [
      (process.env.DATABASE_URL ?? '').replace(/\?.*$/, ''),
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      sql,
    ]);
  // Jan's birthday voucher (paid by card when it was sold) pays 50 zł of the visit.
  const birthday = await json<{ id: string }>(
    await request.post(`${base}/gift-vouchers`, {
      headers: owner,
      data: { amountGrosze: 5000, recipient: 'Jan Kowalski', paymentMethod: 'card' },
    }),
  );
  await json(
    await request.post(`${base}/gift-vouchers/${birthday.id}/redeem`, {
      headers: owner,
      data: { amountGrosze: 5000, appointmentId: booked.id },
    }),
  );
  // A 100 zł voucher sold for cash on the day of the visit.
  const sold = await json<{ id: string }>(
    await request.post(`${base}/gift-vouchers`, {
      headers: owner,
      data: { amountGrosze: 10_000, recipient: 'Ewa', paymentMethod: 'cash' },
    }),
  );
  psql(
    `UPDATE gift_voucher SET created_at = (SELECT start_at FROM appointment WHERE id = '${booked.id}') WHERE id IN ('${sold.id}', '${birthday.id}')`,
  );

  const context = await browser.newContext({
    viewport: DESKTOP,
    locale: 'pl-PL',
    extraHTTPHeaders: freshAddress(),
  });
  const page = await context.newPage();
  await page.goto('/pl/login');
  await page.getByLabel('E-mail').fill(OWNER);
  await page.getByLabel('Hasło').fill(PASSWORD);
  await page.getByRole('button', { name: 'Zaloguj się' }).click();
  await page.waitForURL(/\/pl\/app\/calendar/);
  const reminder = page.getByTestId('till-reminder');
  await expect(reminder).toContainText('nie została zamknięta');
  await reminder.getByRole('button', { name: 'Pokaż ten dzień' }).click();
  const till = page.getByTestId('till');
  await till.getByRole('button', { name: 'Zamknij kasę' }).click();
  const form = page.getByTestId('till-close-form');
  await expect(form).toContainText(
    /Powinno być w kasie: 140,00\s*zł \(za wizyty gotówką 40,00\s*zł/,
  );
  await expect(form).toContainText(/Bony podarunkowe sprzedane za gotówkę: 100,00\s*zł/);
  await expect(form).toContainText(/Za wizyty zapłacono bonami: 50,00\s*zł/);
  await shot(page, '546-till-with-vouchers');
  await form.getByLabel(/Gotówka w kasie/).fill('140');
  await form.getByRole('button', { name: 'Zapisz' }).click();
  await expect(till.getByTestId('till-diff')).toHaveText('zgadza się');

  // Task 547: "Nowy bon" — how the client paid for it.
  await page.goto('/pl/app/vouchers');
  const sell = page.getByRole('region', { name: 'Nowy bon' });
  await sell.getByLabel('Kwota bonu').fill('150');
  await sell.getByLabel(/^Dla kogo/).fill('Marek');
  await sell.getByLabel('Jak klient zapłacił za bon').selectOption('card');
  await expect(sell.getByText(/doliczy się do kasy tego dnia/)).toBeVisible();
  await sell.getByRole('button', { name: 'Sprzedaj bon' }).click();
  await expect(sell.getByRole('status')).toContainText('Kod do wpisania na bonie');
  const list = page.getByRole('region', { name: 'Sprzedane bony' });
  const marek = list.getByRole('listitem').filter({ hasText: 'Dla: Marek' });
  await expect(marek).toContainText('zapłacono: Karta');
  const ewa = list.getByRole('listitem').filter({ hasText: 'Dla: Ewa' });
  await expect(ewa).toContainText('zapłacono: Gotówka');
  await shot(page, '547-voucher-payment-method');
  await context.close();

  const businessApp = await serveApp('mobile-business');
  try {
    const phone = await (
      await browser.newContext({
        viewport: { width: 390, height: 844 },
        locale: 'pl-PL',
        isMobile: true,
        extraHTTPHeaders: freshAddress(),
      })
    ).newPage();
    await phone.goto(businessApp.url);
    await phone.getByLabel('E-mail lub telefon').fill(OWNER);
    await phone.getByRole('button', { name: 'Wyślij kod' }).click();
    const mail = await waitForEmail(OWNER, /Kod logowania do aplikacji salonu/);
    await phone.getByLabel('Kod', { exact: true }).fill(/\b(\d{6})\b/.exec(mail.text)![1]!);
    await phone.getByRole('button', { name: 'Zaloguj się' }).click();
    await expect(phone.getByRole('button', { name: 'Dziś' })).toBeVisible();
    const appTill = phone.getByTestId('till');
    for (let back = 0; back < 3 && !(await appTill.isVisible()); back++) {
      await phone.getByRole('button', { name: 'Poprzedni dzień' }).click();
      await phone.waitForTimeout(800);
    }
    await expect(appTill.getByTestId('till-diff')).toHaveText('Zgadza się');
    await appTill.getByRole('button', { name: 'Policz ponownie' }).click();
    const appForm = phone.getByTestId('till-close-form');
    await expect(appForm).toContainText(/Powinno być w kasie: 140,00\s*zł/);
    await expect(appForm).toContainText(/Bony podarunkowe sprzedane za gotówkę: 100,00\s*zł/);
    await expect(appForm).toContainText(/Za wizyty zapłacono bonami: 50,00\s*zł/);
    await appForm.scrollIntoViewIfNeeded();
    await shot(phone, '548-business-app-till-with-vouchers');

    await phone.getByRole('button', { name: 'Dziś' }).click();
    await phone.getByRole('button', { name: 'Bony podarunkowe' }).click();
    await expect(phone.getByRole('heading', { name: 'Bony podarunkowe' })).toBeVisible();
    await expect(phone.getByText('Jak klient zapłacił za bon').first()).toBeVisible();
    await expect(phone.getByText(/Dla: Ewa · zapłacono: Gotówka/)).toBeVisible();
    await expect(phone.getByText(/Dla: Marek · zapłacono: Karta/)).toBeVisible();
    await phone.getByText(/Dla: Ewa · zapłacono: Gotówka/).scrollIntoViewIfNeeded();
    await shot(phone, '548-a-business-app-voucher-payment');
  } finally {
    businessApp.server.close();
  }
});
