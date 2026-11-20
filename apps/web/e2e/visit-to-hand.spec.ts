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
 * Task Q3 (screen D): "Do wydania klientowi" in the cabinet's visit card. A client books on the
 * booking page and puts a pomade and a wax aside for the visit (the visit link's API, screen B).
 * The visit took place: the owner opens its card, sees both products waiting, cancels the wax and
 * hands the pomade over with "Wydaj i dolicz" — it becomes the usual sale under "Produkty" and
 * leaves the stock. Screenshots Q3-D-to-hand, Q3-D-handed.
 */

const PASSWORD = 'e2e-password-123';
const run = Date.now().toString(36);
const OWNER = `to-hand-${run}@example.com`;
const CLIENT = `to-hand-client-${run}@example.com`;
const DESKTOP = { width: 1440, height: 900 };

const shot = (page: Page, name: string) =>
  page.screenshot({ path: `e2e/screenshots/${name}.png`, fullPage: true });

async function json<T>(res: APIResponse): Promise<T> {
  expect(res.ok(), `${res.url()} → ${res.status()} ${await res.text()}`).toBeTruthy();
  return (res.status() === 204 ? undefined : await res.json()) as T;
}

async function owner(api: APIRequestContext) {
  await json(
    await api.post('/v1/auth/register', {
      headers: freshAddress(),
      data: { email: OWNER, password: PASSWORD, name: 'Właściciel' },
    }),
  );
  const mail = await waitForEmail(OWNER, /Potwierdź adres/);
  const token = /token=([^\s&]+)/.exec(mail.text)?.[1];
  await json(
    await api.post('/v1/auth/verify-email', { data: { token: decodeURIComponent(token!) } }),
  );
  const login = await json<{ accessToken: string }>(
    await api.post('/v1/auth/login', {
      headers: freshAddress(),
      data: { email: OWNER, password: PASSWORD, clientType: 'mobile' },
    }),
  );
  const auth = { Authorization: `Bearer ${login.accessToken}` };
  const name = `Do Wydania ${run}`;
  const org = await json<{ id: string }>(
    await api.post('/v1/organizations', { headers: auth, data: { name } }),
  );
  const location = await json<{ id: string; slug: string }>(
    await api.post(`/v1/organizations/${org.id}/locations`, {
      headers: auth,
      data: {
        name,
        addressLine: 'ul. Józefa Bema 91',
        city: 'Warszawa',
        postalCode: '01-233',
        onlineBookingEnabled: true,
        bookingTerms: '# Regulamin\n\nWizyta jest bezpłatna do odwołania.',
        privacyPolicy: `# Prywatność\n\nAdministratorem danych jest ${name}.`,
      },
    }),
  );
  return {
    auth,
    base: `/v1/organizations/${org.id}/locations/${location.id}`,
    slug: location.slug,
  };
}

test('"Do wydania klientowi": the owner hands over a product put aside for the visit (task Q3, screen D)', async ({
  browser,
  request,
}) => {
  const salon = await owner(request);
  const product = (name: string, priceGrosze: number) =>
    request.post(`${salon.base}/products`, {
      headers: salon.auth,
      data: { name, priceGrosze, stockQuantity: 3, inSalonShop: true },
    });
  const pomade = await json<{ id: string }>(await product('Pomada Reuzel różowa', 5900));
  const wax = await json<{ id: string }>(await product('Wosk matowy', 4500));
  const cut = await json<{ id: string }>(
    await request.post(`${salon.base}/services`, {
      headers: salon.auth,
      data: { name: 'Strzyżenie', durationMinutes: 30, priceGrosze: 8000 },
    }),
  );
  const kasia = await json<{ id: string }>(
    await request.post(`${salon.base}/staff`, {
      headers: salon.auth,
      data: { displayName: 'Kasia', serviceIds: [cut.id] },
    }),
  );
  await json(
    await request.put(`${salon.base}/staff/${kasia.id}/working-hours`, {
      headers: salon.auth,
      data: {
        days: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
          weekday,
          intervals: [{ start: '08:00', end: '20:00' }],
        })),
      },
    }),
  );

  // The client books for the day after tomorrow and puts both products aside (screen B).
  const start = new Date();
  start.setUTCDate(start.getUTCDate() + 2);
  start.setUTCHours(12, 0, 0, 0);
  const hold = await json<{ holdId: string; holdToken: string }>(
    await request.post(`/v1/public/locations/${salon.slug}/holds`, {
      data: { serviceId: cut.id, staffId: kasia.id, start: start.toISOString() },
    }),
  );
  await json(
    await request.post(`/v1/public/holds/${hold.holdId}/code`, {
      data: {
        holdToken: hold.holdToken,
        name: 'Anna Kowalska',
        phone: '+48 600 100 201',
        email: CLIENT,
        locale: 'pl',
        acceptTerms: true,
      },
    }),
  );
  const codeMail = await waitForEmail(CLIENT, /Kod potwierdzenia/);
  const confirmed = await json<{ manageToken: string; appointment: { id: string } }>(
    await request.post(`/v1/public/holds/${hold.holdId}/confirm`, {
      data: { holdToken: hold.holdToken, code: /\b(\d{6})\b/.exec(codeMail.text)![1]! },
    }),
  );
  for (const productId of [pomade.id, wax.id]) {
    await json(
      await request.post(`/v1/public/appointments/${confirmed.manageToken}/products`, {
        data: { productId, quantity: 1 },
      }),
    );
  }

  // The visit took place two days earlier than booked (visits can't be booked in the past).
  const booked = await json<{ id: string; version: number }>(
    await request.get(`${salon.base}/appointments/${confirmed.appointment.id}`, {
      headers: salon.auth,
    }),
  );
  execFileSync('psql', [
    (process.env.DATABASE_URL ?? '').replace(/\?.*$/, ''),
    '-v',
    'ON_ERROR_STOP=1',
    '-c',
    `UPDATE appointment SET start_at = start_at - interval '2 days', end_at = end_at - interval '2 days', blocked_until = blocked_until - interval '2 days' WHERE id = '${booked.id}'`,
  ]);
  const visit = await json<{ date: string }>(
    await request.post(`${salon.base}/appointments/${booked.id}/status`, {
      headers: salon.auth,
      data: { version: booked.version, status: 'completed' },
    }),
  );

  const desk = await browser.newContext({
    viewport: DESKTOP,
    locale: 'pl-PL',
    extraHTTPHeaders: freshAddress(),
  });
  const page = await desk.newPage();
  await page.goto('/pl/login');
  await page.getByLabel('E-mail').fill(OWNER);
  await page.getByLabel('Hasło').fill(PASSWORD);
  await page.getByRole('button', { name: 'Zaloguj się' }).click();
  await page.waitForURL(/\/pl\/app\/calendar/);

  await page.goto(`/pl/app/calendar?date=${visit.date}`);
  await page.getByRole('button', { name: /Anna Kowalska/ }).click();
  const card = page.getByRole('dialog');
  const toHand = card.getByTestId('visit-to-hand');
  await expect(toHand.getByText('Do wydania klientowi')).toBeVisible();
  await expect(toHand.getByText('Pomada Reuzel różowa')).toBeVisible();
  await expect(toHand.getByText('Wosk matowy')).toBeVisible();
  await expect(toHand.getByText(/Razem: 104,00\s*zł — płatność przy wizycie/)).toBeVisible();
  await shot(page, 'Q3-D-to-hand');

  // The client didn't want the wax after all.
  await toHand.getByRole('button', { name: 'Anuluj rezerwację — Wosk matowy' }).click();
  await expect(toHand.getByText('Wosk matowy')).toHaveCount(0);
  await expect(toHand.getByText(/Razem: 59,00\s*zł/)).toBeVisible();

  // The pomade is handed over: it is the visit's usual sale now.
  await toHand.getByRole('button', { name: 'Wydaj i dolicz — Pomada Reuzel różowa' }).click();
  await expect(toHand.getByText('✓ Wydano')).toBeVisible();
  await expect(toHand.getByText(/Razem:/)).toHaveCount(0);
  const sold = card.getByTestId('visit-products');
  await expect(sold.getByText('Pomada Reuzel różowa')).toBeVisible();
  await shot(page, 'Q3-D-handed');

  // One piece left the stock.
  const list = await json<{ products: { id: string; stockQuantity: number | null }[] }>(
    await request.get(`${salon.base}/products`, { headers: salon.auth }),
  );
  expect(list.products.find((p) => p.id === pomade.id)?.stockQuantity).toBe(2);
  expect(list.products.find((p) => p.id === wax.id)?.stockQuantity).toBe(3);
  await desk.close();
});
