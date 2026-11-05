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
 * Task 165b: reviews after the visit. The salon switches reviews on; a client whose visit took
 * place opens the visit link (the "Jak było?" email opens it at #review), gives 5 stars with a
 * few words; the salon page shows the average, the specialists' averages and the reviews —
 * without the client's name. In the cabinet, "Opinie": the settings and the reviews with the
 * client's name. Screenshots 165b-1 … 165b-4.
 */

const PASSWORD = 'e2e-password-123';
const run = Date.now().toString(36);
const OWNER = `reviews-owner-${run}@example.com`;
const SALON = `Gestalt Opinie ${run}`;
const PHONE = { width: 390, height: 844 };
const OWNER_IP = freshAddress();

const shot = (page: Page, name: string) => page.screenshot({ path: `e2e/screenshots/${name}.png` });

async function json<T>(res: APIResponse): Promise<T> {
  expect(res.ok(), `${res.url()} → ${res.status()} ${await res.text()}`).toBeTruthy();
  return (res.status() === 204 ? undefined : await res.json()) as T;
}

async function verifiedUser(api: APIRequestContext, email: string, name: string) {
  await json(
    await api.post('/v1/auth/register', {
      headers: OWNER_IP,
      data: { email, password: PASSWORD, name },
    }),
  );
  const mail = await waitForEmail(email, /Potwierdź adres/);
  const token = /token=([^\s&]+)/.exec(mail.text)?.[1];
  expect(token, 'verification link').toBeTruthy();
  await json(
    await api.post('/v1/auth/verify-email', {
      headers: OWNER_IP,
      data: { token: decodeURIComponent(token!) },
    }),
  );
  const login = await json<{ accessToken: string }>(
    await api.post('/v1/auth/login', {
      headers: OWNER_IP,
      data: { email, password: PASSWORD, clientType: 'mobile' },
    }),
  );
  return { Authorization: `Bearer ${login.accessToken}` };
}

/** Visits can't be booked in the past: the visit is moved 2 days back and marked as it went. */
function tookPlace(appointmentId: string) {
  const url = (process.env.DATABASE_URL ?? '').replace(/\?.*$/, '');
  execFileSync('psql', [
    url,
    '-v',
    'ON_ERROR_STOP=1',
    '-c',
    `UPDATE appointment SET status = 'completed', start_at = start_at - interval '4 days', end_at = end_at - interval '4 days', blocked_until = blocked_until - interval '4 days' WHERE id = '${appointmentId}';
     UPDATE appointment_access_token SET expires_at = now() + interval '7 days' WHERE appointment_id = '${appointmentId}'`,
  ]);
}

test('a client reviews the visit; the salon page shows the reviews', async ({
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
        name: SALON,
        addressLine: 'ul. Józefa Bema 91',
        city: 'Warszawa',
        postalCode: '01-233',
      },
    }),
  );
  const base = `/v1/organizations/${org.id}/locations/${location.id}`;
  await json(
    await request.patch(base, {
      headers: owner,
      data: {
        version: location.version,
        onlineBookingEnabled: true,
        bookingTerms: '# Regulamin\n\nWizyta jest bezpłatna do odwołania.',
        privacyPolicy: '# Polityka prywatności\n\nAdministratorem danych jest GESTALT.',
      },
    }),
  );
  const service = await json<{ id: string }>(
    await request.post(`${base}/services`, {
      headers: owner,
      data: { name: 'Strzyżenie fade', durationMinutes: 45, priceGrosze: 9000 },
    }),
  );
  const staff: Record<string, string> = {};
  for (const name of ['Ilya', 'Nazar']) {
    const s = await json<{ id: string }>(
      await request.post(`${base}/staff`, {
        headers: owner,
        data: { displayName: name, serviceIds: [service.id] },
      }),
    );
    await json(
      await request.put(`${base}/staff/${s.id}/working-hours`, {
        headers: owner,
        data: {
          days: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
            weekday,
            intervals: [{ start: '09:00', end: '18:00' }],
          })),
        },
      }),
    );
    staff[name] = s.id;
  }
  const settings = await json<{ enabled: boolean; version: number }>(
    await request.put(`${base}/review-settings`, {
      headers: owner,
      data: { version: 0, enabled: true, requestHours: 2 },
    }),
  );
  expect(settings).toMatchObject({ enabled: true, version: 1 });

  /** Books online as a client of its own address; returns the visit id and its link token. */
  async function book(staffName: string, email: string, name: string) {
    const ip = freshAddress();
    const from = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
    const to = new Date(Date.now() + 6 * 86_400_000).toISOString().slice(0, 10);
    const free = await json<{ slots: { start: string }[] }>(
      await request.get(`/v1/public/locations/${location.slug}/availability`, {
        params: { serviceId: service.id, staffId: staff[staffName]!, from, to },
      }),
    );
    const hold = await json<{ holdId: string; holdToken: string }>(
      await request.post(`/v1/public/locations/${location.slug}/holds`, {
        headers: ip,
        data: { serviceId: service.id, staffId: staff[staffName], start: free.slots[0]!.start },
      }),
    );
    await json(
      await request.post(`/v1/public/holds/${hold.holdId}/code`, {
        headers: ip,
        data: {
          holdToken: hold.holdToken,
          name,
          phone: '+48600300400',
          email,
          locale: 'pl',
          acceptTerms: true,
        },
      }),
    );
    const mail = await waitForEmail(email, /Kod potwierdzenia/);
    const booked = await json<{ appointment: { id: string }; manageToken: string }>(
      await request.post(`/v1/public/holds/${hold.holdId}/confirm`, {
        headers: ip,
        data: { holdToken: hold.holdToken, code: /\b(\d{6})\b/.exec(mail.text)![1] },
      }),
    );
    tookPlace(booked.appointment.id);
    return booked.manageToken;
  }

  // Two earlier reviews, written through the API (as the app does).
  const marta = await book('Ilya', `reviews-marta-${run}@example.com`, 'Marta Nowak');
  await json(
    await request.put(`/v1/public/appointments/${marta}/review`, {
      data: { rating: 5, text: 'Najlepszy fade w Warszawie. Polecam!' },
    }),
  );
  const jan = await book('Nazar', `reviews-jan-${run}@example.com`, 'Jan Kowalski');
  await json(await request.put(`/v1/public/appointments/${jan}/review`, { data: { rating: 4 } }));

  // ── The client opens the visit link from the "Jak było?" email ─────────
  const piotr = await book('Ilya', `reviews-piotr-${run}@example.com`, 'Piotr Zieliński');
  const phone = await browser.newContext({ viewport: PHONE, locale: 'pl-PL' });
  const page = await phone.newPage();
  await page.goto(`/pl/m/${piotr}#review`);
  const form = page.getByRole('region', { name: 'Twoja opinia' });
  await expect(form).toBeVisible();
  await expect(form).toContainText('Jak oceniasz wizytę u Ilya?');
  const send = form.getByRole('button', { name: 'Wyślij opinię' });
  await expect(send).toBeDisabled();
  await form.getByRole('radio', { name: '5 z 5' }).click();
  await form.getByLabel('Kilka słów (opcjonalnie)').fill('Szybko i dokładnie, miła atmosfera.');
  await shot(page, '165b-1-review-form');
  await send.click();
  await expect(form.getByRole('status')).toHaveText('Dziękujemy za opinię!');
  await expect(form).toContainText('Szybko i dokładnie, miła atmosfera.');
  await expect(form.getByRole('button', { name: 'Zmień opinię' })).toBeVisible();
  await shot(page, '165b-2-review-sent');

  // ── The salon page: average, specialists, reviews without names ───────
  await page.goto(`/pl/b/${location.slug}`);
  const reviews = page.locator('details.salon-reviews');
  await expect(reviews).toContainText('4,7 · opinie: 3');
  await reviews.locator('summary').click();
  await expect(reviews.getByRole('button', { name: /Ilya ★ 5,0 \(2\)/ })).toBeVisible();
  await expect(reviews.getByRole('button', { name: /Nazar ★ 4,0 \(1\)/ })).toBeVisible();
  await expect(reviews).toContainText('Najlepszy fade w Warszawie. Polecam!');
  await expect(reviews).not.toContainText('Marta');
  await shot(page, '165b-3-salon-reviews');
  await reviews.getByRole('button', { name: /Nazar/ }).click();
  await expect(reviews.locator('.review-list > li')).toHaveCount(1);
  await phone.close();

  // ── The cabinet: "Opinie" with the settings and the client names ──────
  const desk = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    locale: 'pl-PL',
    timezoneId: 'Europe/Warsaw',
    extraHTTPHeaders: OWNER_IP,
  });
  const cabinet = await desk.newPage();
  await cabinet.goto('/pl/login');
  await cabinet.getByLabel('E-mail').fill(OWNER);
  await cabinet.getByLabel('Hasło').fill(PASSWORD);
  await cabinet.getByRole('button', { name: 'Zaloguj się' }).click();
  await cabinet.waitForURL(/\/pl\/app\/calendar/);
  await cabinet.getByRole('link', { name: 'Opinie' }).first().click();
  await cabinet.waitForURL(/\/pl\/app\/reviews$/);
  const settingsForm = cabinet.getByRole('form', { name: 'Ustawienia opinii' });
  await expect(settingsForm.getByLabel('Zbieraj opinie po wizycie')).toBeChecked();
  await settingsForm.getByLabel('Poproś o opinię po').selectOption('3');
  await settingsForm.getByRole('button', { name: 'Zapisz' }).click();
  await expect(settingsForm.getByRole('status')).toHaveText('Zapisano.');
  const list = cabinet.getByRole('region', { name: 'Opinie' });
  await expect(list).toContainText('4,7 · opinie: 3');
  await expect(list.locator('.list-row').first()).toContainText('Piotr Zieliński');
  await expect(list).toContainText('Marta Nowak');
  await shot(cabinet, '165b-4-cabinet-reviews');
  const saved = await json<{ requestHours: number; version: number }>(
    await request.get(`${base}/review-settings`, { headers: owner }),
  );
  expect(saved).toMatchObject({ requestHours: 3, version: 2 });
  await desk.close();
});
