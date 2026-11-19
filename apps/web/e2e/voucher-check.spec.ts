import { expect, test, type APIRequestContext, type APIResponse } from '@playwright/test';
import { freshAddress } from './addresses';
import { waitForEmail } from './mailpit';

/**
 * Task 537: "Sprawdź bon" on the salon page. The salon sold a 200 zł gift voucher and the client
 * already paid 50 zł with it. On the salon page the client opens "Masz bon podarunkowy?", types
 * a wrong code (the salon has no such voucher), then the right one in small letters with a dash —
 * and sees "Zostało 150,00 zł z 200,00 zł" and the last day (screenshot 537). Nothing about who the
 * voucher is for is shown.
 */

const PASSWORD = 'e2e-password-123';
const run = Date.now().toString(36);
const OWNER = `voucher-check-owner-${run}@example.com`;
const PHONE = { width: 390, height: 844 };

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

test('the client checks what is left on a gift voucher on the salon page', async ({
  browser,
  request,
}) => {
  const owner = await verifiedUser(request, OWNER, 'Aleksander Owner');
  const org = await json<{ id: string }>(
    await request.post('/v1/organizations', { headers: owner, data: { name: 'GESTALT' } }),
  );
  const location = await json<{ id: string; slug: string; version: number }>(
    await request.post(`/v1/organizations/${org.id}/locations`, {
      headers: owner,
      data: {
        // A name of its own: while it takes online bookings it is in the public catalogue.
        name: 'Voucher Check Barbershop',
        addressLine: 'ul. Józefa Bema 91',
        city: 'Warszawa',
        postalCode: '01-233',
      },
    }),
  );
  const base = `/v1/organizations/${org.id}/locations/${location.id}`;
  const online = await json<{ version: number }>(
    await request.patch(base, {
      headers: owner,
      data: {
        version: location.version,
        onlineBookingEnabled: true,
        bookingTerms: '# Regulamin rezerwacji\n\nRezerwacja jest bezpłatna.',
        privacyPolicy: '# Polityka prywatności\n\nAdministratorem danych jest GESTALT.',
      },
    }),
  );
  const service = await json<{ id: string }>(
    await request.post(`${base}/services`, {
      headers: owner,
      data: { name: 'Strzyżenie męskie', durationMinutes: 45, priceGrosze: 9000 },
    }),
  );
  await json(
    await request.post(`${base}/staff`, {
      headers: owner,
      data: { displayName: 'Kasia', serviceIds: [service.id] },
    }),
  );
  const until = new Date(Date.now() + 90 * 86_400_000).toISOString().slice(0, 10);
  const voucher = await json<{ id: string; code: string }>(
    await request.post(`${base}/gift-vouchers`, {
      headers: owner,
      data: { amountGrosze: 20000, recipient: 'Jan Kowalski', validUntil: until },
    }),
  );
  await json(
    await request.post(`${base}/gift-vouchers/${voucher.id}/redeem`, {
      headers: owner,
      data: { amountGrosze: 5000 },
    }),
  );

  const context = await browser.newContext({ viewport: PHONE });
  const page = await context.newPage();
  await page.goto(`/pl/b/${location.slug}`);
  await expect(page.getByRole('heading', { name: 'Voucher Check Barbershop' })).toBeVisible();
  await page.getByRole('button', { name: 'Masz bon podarunkowy? Sprawdź, ile zostało' }).click();
  const section = page.getByRole('region', { name: 'Sprawdź bon podarunkowy' });
  const code = section.getByLabel('Kod bonu');

  await code.fill('ZZZZ-ZZZZ');
  await section.getByRole('button', { name: 'Sprawdź', exact: true }).click();
  await expect(section.getByRole('alert')).toHaveText(
    'Ten salon nie ma bonu z takim kodem. Sprawdź litery i cyfry.',
  );

  await code.fill(`${voucher.code.slice(0, 4).toLowerCase()}-${voucher.code.slice(4)}`);
  await section.getByRole('button', { name: 'Sprawdź', exact: true }).click();
  const result = section.getByRole('status');
  await expect(result).toContainText(/Zostało 150,00\s?zł z 200,00\s?zł/);
  await expect(result).toContainText('Ważny · Ważny do');
  await expect(result).toContainText('Bonem płacisz w salonie, przy wizycie.');
  await expect(section.getByRole('alert')).toHaveCount(0);
  await expect(page.getByText('Jan Kowalski')).toHaveCount(0);
  await section.scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'e2e/screenshots/537.png' });
  await context.close();

  // Out of the public catalogue again: other tests count its salons.
  await json(
    await request.patch(base, {
      headers: owner,
      data: { version: online.version, onlineBookingEnabled: false },
    }),
  );
});
