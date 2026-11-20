import { execFileSync } from 'node:child_process';
import {
  expect,
  test,
  type APIRequestContext,
  type APIResponse,
  type Page,
} from '@playwright/test';
import { freshAddress } from './addresses';
import { listTo, textOf, waitForEmail } from './mailpit';

/**
 * Task Q3 (screen C): after the visit, the visit link page shows under "Jak było?" what the
 * specialist used ("Na wizycie użyto"). Without a next visit: "Umów kolejną wizytę" opens the
 * booking at the same specialist's times and the products come along — put aside for the new
 * visit right after booking. Back on the old visit's page a product given back can be put aside
 * with "Odłóż na następną wizytę". Screenshots Q3-C-used, Q3-C-booked, Q3-C-saved.
 * Then the client cancels the new visit: "Przenieść produkty na nowy termin?" books another time
 * and the products come along again (Q3-move-cancelled, Q3-move-booked).
 * (Named "shop-…" so it runs after booking.spec.ts, which counts the salons in the catalogue.)
 */

const PASSWORD = 'e2e-password-123';
const run = Date.now().toString(36);
const OWNER = `after-visit-${run}@example.com`;
const CLIENT = `after-visit-client-${run}@example.com`;
const PHONE = { width: 390, height: 844 };

const shot = (page: Page, name: string) =>
  page.screenshot({ path: `e2e/screenshots/${name}.png`, fullPage: true });

async function json<T>(res: APIResponse): Promise<T> {
  expect(res.ok(), `${res.url()} → ${res.status()} ${await res.text()}`).toBeTruthy();
  return (res.status() === 204 ? undefined : await res.json()) as T;
}

/** Runs SQL on the test database (for what the API can't do: visits in the past). */
function sql(statement: string) {
  const url = (process.env.DATABASE_URL ?? '').replace(/\?.*$/, '');
  execFileSync('psql', [url, '-v', 'ON_ERROR_STOP=1', '-c', statement]);
}

/** The newest "Kod potwierdzenia" that came after `before` such emails. */
async function nextCode(before: number): Promise<string> {
  const until = Date.now() + 20_000;
  for (;;) {
    const codes = (await listTo(CLIENT)).filter((m) => /Kod potwierdzenia/.test(m.Subject));
    if (codes.length > before) return /\b(\d{6})\b/.exec(await textOf(codes[0]!.ID))![1]!;
    if (Date.now() > until) throw new Error('No new code');
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

const codeCount = async () =>
  (await listTo(CLIENT)).filter((m) => /Kod potwierdzenia/.test(m.Subject)).length;

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
  const name = `Po Wizycie ${run}`;
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

test('"Na wizycie użyto": put aside for the next visit (task Q3, screen C)', async ({
  browser,
  request,
}) => {
  const salon = await owner(request);
  const product = async (name: string, priceGrosze: number) =>
    json<{ id: string }>(
      await request.post(`${salon.base}/products`, {
        headers: salon.auth,
        data: { name, priceGrosze, stockQuantity: 5, inSalonShop: true },
      }),
    );
  const pomade = await product('Pomada Reuzel różowa', 5900);
  const wax = await product('Wosk matowy', 4500);
  const cut = await json<{ id: string }>(
    await request.post(`${salon.base}/services`, {
      headers: salon.auth,
      data: { name: 'Strzyżenie', durationMinutes: 30, priceGrosze: 8000 },
    }),
  );
  const ilya = await json<{ id: string }>(
    await request.post(`${salon.base}/staff`, {
      headers: salon.auth,
      data: { displayName: 'Ilya', serviceIds: [cut.id] },
    }),
  );
  await json(
    await request.put(`${salon.base}/staff/${ilya.id}/working-hours`, {
      headers: salon.auth,
      data: {
        days: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
          weekday,
          intervals: [{ start: '08:00', end: '20:00' }],
        })),
      },
    }),
  );

  // The first visit, booked online, took place; Ilya sold the pomade and the wax at it.
  const ip = freshAddress();
  const from = new Date().toISOString().slice(0, 10);
  const to = new Date(Date.now() + 6 * 86_400_000).toISOString().slice(0, 10);
  const free = await json<{ slots: { start: string }[] }>(
    await request.get(`/v1/public/locations/${salon.slug}/availability`, {
      params: { serviceId: cut.id, staffId: ilya.id, from, to },
    }),
  );
  const hold = await json<{ holdId: string; holdToken: string }>(
    await request.post(`/v1/public/locations/${salon.slug}/holds`, {
      headers: ip,
      data: { serviceId: cut.id, staffId: ilya.id, start: free.slots[0]!.start },
    }),
  );
  const before = await codeCount();
  await json(
    await request.post(`/v1/public/holds/${hold.holdId}/code`, {
      headers: ip,
      data: {
        holdToken: hold.holdToken,
        name: 'Anna Kowalska',
        phone: '+48600100203',
        email: CLIENT,
        locale: 'pl',
        acceptTerms: true,
      },
    }),
  );
  const first = await json<{ appointment: { id: string }; manageToken: string }>(
    await request.post(`/v1/public/holds/${hold.holdId}/confirm`, {
      headers: ip,
      data: { holdToken: hold.holdToken, code: await nextCode(before) },
    }),
  );
  const id = first.appointment.id;
  sql(
    `UPDATE appointment SET status = 'completed', start_at = start_at - interval '4 days', end_at = end_at - interval '4 days', blocked_until = blocked_until - interval '4 days' WHERE id = '${id}';
     UPDATE appointment_access_token SET expires_at = now() + interval '7 days' WHERE appointment_id = '${id}'`,
  );
  for (const productId of [pomade.id, wax.id]) {
    await json(
      await request.post(`${salon.base}/appointments/${id}/products`, {
        headers: salon.auth,
        data: { productId, quantity: 1 },
      }),
    );
  }

  const context = await browser.newContext({
    viewport: PHONE,
    locale: 'pl-PL',
    isMobile: true,
    extraHTTPHeaders: freshAddress(),
  });
  const page = await context.newPage();
  await page.goto(`/pl/m/${first.manageToken}`);
  const used = page.getByTestId('used-products');
  await expect(used.getByRole('heading', { name: 'Na wizycie użyto' })).toBeVisible();
  await expect(used.getByText('Pomada Reuzel różowa')).toBeVisible();
  await expect(used.getByText('Wosk matowy')).toBeVisible();
  await expect(used.getByText(/Nie masz jeszcze kolejnej wizyty/)).toBeVisible();
  // No next visit yet: nothing to put aside on, one main button.
  await expect(used.getByRole('button', { name: /^Odłóż na następną wizytę/ })).toHaveCount(0);
  await used.scrollIntoViewIfNeeded();
  await shot(page, 'Q3-C-used');

  // "Umów kolejną wizytę": straight to Ilya's times, the products come along.
  await used.getByRole('link', { name: 'Umów kolejną wizytę' }).click();
  // A day ahead, so the visit can still be cancelled online below (2 hours before).
  await page.locator('.day-strip button').nth(2).click();
  await page.locator('.times button').first().click();
  await page.getByLabel('Imię i nazwisko').fill('Anna Kowalska');
  await page.getByLabel('Telefon').fill('600 100 203');
  await page.getByLabel('E-mail').fill(CLIENT);
  await page.getByLabel(/Akceptuję regulamin rezerwacji/).check();
  const sent = await codeCount();
  await page.getByRole('button', { name: 'Wyślij kod' }).click();
  await page.getByLabel('Kod z e-maila').fill(await nextCode(sent));
  await page.getByRole('button', { name: 'Potwierdź wizytę' }).click();
  await expect(page.getByRole('heading', { name: 'Do zobaczenia!' })).toBeVisible();
  const booked = page.getByTestId('booked-products');
  await expect(booked.getByText('Czeka w salonie — zapłacisz przy wizycie')).toHaveCount(2);
  await expect(
    booked.getByText(/Razem za produkty: 104,00\s*zł \(płatność w salonie\)/),
  ).toBeVisible();
  await booked.scrollIntoViewIfNeeded();
  await shot(page, 'Q3-C-booked');
  const manageHref = await page
    .getByRole('link', { name: 'Zmień lub odwołaj wizytę' })
    .getAttribute('href');
  const secondToken = manageHref!.split('/m/')[1]!;
  // The client changes their mind about the wax…
  await booked.getByRole('button', { name: 'Zrezygnuj: Wosk matowy' }).click();
  await expect(booked.getByText('Czeka w salonie — zapłacisz przy wizycie')).toHaveCount(1);

  // …and back on the first visit's page puts it aside again with one tap.
  await page.goto(`/pl/m/${first.manageToken}`);
  await expect(used.getByText(/^✓ Odłożone na wizytę/)).toHaveCount(1);
  await used.getByRole('button', { name: 'Odłóż na następną wizytę: Wosk matowy' }).click();
  await expect(used.getByText(/^✓ Odłożone na wizytę/)).toHaveCount(2);
  await expect(used.getByRole('link', { name: 'Umów kolejną wizytę' })).toHaveCount(0);
  await used.scrollIntoViewIfNeeded();
  await shot(page, 'Q3-C-saved');

  // The new visit is cancelled: the products put aside move to another time with one button.
  await page.goto(`/pl/m/${secondToken}`);
  await page.getByRole('button', { name: 'Odwołaj wizytę' }).click();
  await page.getByRole('button', { name: 'Tak, odwołaj' }).click();
  const move = page.getByTestId('move-products');
  await expect(
    move.getByRole('heading', { name: 'Przenieść produkty na nowy termin?' }),
  ).toBeVisible();
  await expect(move.getByText('Pomada Reuzel różowa')).toBeVisible();
  await expect(move.getByText('Wosk matowy')).toBeVisible();
  await move.scrollIntoViewIfNeeded();
  await shot(page, 'Q3-move-cancelled');
  await move.getByRole('link', { name: 'Wybierz nowy termin' }).click();
  await page.locator('.times button').nth(1).click();
  // Booking with a code signed the client in on this phone: the details are there, no code.
  await expect(page.getByLabel('E-mail')).toHaveValue(CLIENT);
  await page.getByLabel(/Akceptuję regulamin rezerwacji/).check();
  if (await page.getByLabel('E-mail').isEditable()) {
    const again = await codeCount();
    await page.getByRole('button', { name: 'Wyślij kod' }).click();
    await page.getByLabel('Kod z e-maila').fill(await nextCode(again));
  }
  await page.getByRole('button', { name: 'Potwierdź wizytę' }).click();
  await expect(page.getByRole('heading', { name: 'Do zobaczenia!' })).toBeVisible();
  await expect(
    page.getByTestId('booked-products').getByText('Czeka w salonie — zapłacisz przy wizycie'),
  ).toHaveCount(2);
  await page.getByTestId('booked-products').scrollIntoViewIfNeeded();
  await shot(page, 'Q3-move-booked');
  await context.close();
});
