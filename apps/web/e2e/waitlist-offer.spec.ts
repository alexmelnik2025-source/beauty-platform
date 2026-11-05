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
 * Task 164: a time frees up on a full day — it is held for the first client on the waiting list
 * for 15 minutes. The client opens the link from the email, adds a phone (the list had none) and
 * takes the time; the visit is booked. Screenshots 164–164a. (Who gets it next when the client says
 * no or does not answer is covered by apps/api/test/waitlist.spec.ts.)
 */

const PASSWORD = 'e2e-password-123';
const run = Date.now().toString(36);
const OWNER = `offer-owner-${run}@example.com`;
const ANNA = `offer-anna-${run}@example.com`;
const PHONE = { width: 390, height: 844 };

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
    // From an address of its own: sign-ins are limited per address (30 in 15 minutes).
    await api.post('/v1/auth/login', {
      headers: freshAddress(),
      data: { email, password: PASSWORD, clientType: 'mobile' },
    }),
  );
  return { Authorization: `Bearer ${login.accessToken}` };
}

test('a freed time is held for the first client on the list, who takes it from the email', async ({
  browser,
  request,
}) => {
  // The waiting list is checked once a minute on the server.
  test.setTimeout(180_000);
  const owner = await verifiedUser(request, OWNER, 'Aleksander Owner');
  const org = await json<{ id: string }>(
    await request.post('/v1/organizations', { headers: owner, data: { name: 'GESTALT' } }),
  );
  const location = await json<{ id: string; slug: string; version: number }>(
    await request.post(`/v1/organizations/${org.id}/locations`, {
      headers: owner,
      data: {
        name: `Lista ${run}`,
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
        // Task 164: the salon holds a freed time 15 minutes for the first client on the list.
        waitlistHoldMinutes: 15,
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
  const staff = await json<{ id: string }>(
    await request.post(`${base}/staff`, {
      headers: owner,
      data: { displayName: 'Kasia', serviceIds: [service.id] },
    }),
  );
  // One visit fits a day: 10:00–10:45.
  await json(
    await request.put(`${base}/staff/${staff.id}/working-hours`, {
      headers: owner,
      data: {
        days: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
          weekday,
          intervals: [{ start: '10:00', end: '10:45' }],
        })),
      },
    }),
  );
  // The day after tomorrow is full.
  const free = await json<{ slots: { start: string; date: string }[] }>(
    await request.get(`/v1/public/locations/${location.slug}/availability`, {
      params: {
        serviceId: service.id,
        from: new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10),
        to: new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10),
      },
    }),
  );
  const taken = free.slots[0]!;
  const visit = await json<{ id: string; version: number }>(
    await request.post(`${base}/appointments`, {
      headers: owner,
      data: {
        serviceId: service.id,
        staffId: staff.id,
        start: taken.start,
        customer: { name: 'Jan Nowak', phone: '+48600000001' },
      },
    }),
  );

  // Anna waits for that day (no phone on the list).
  await json(
    await request.post(`/v1/public/locations/${location.slug}/waitlist`, {
      headers: freshAddress(),
      data: {
        serviceId: service.id,
        staffId: staff.id,
        date: taken.date,
        name: 'Anna Kowalska',
        email: ANNA,
        acceptTerms: true,
      },
    }),
  );
  // The salon cancels the visit: the time is held for Anna and she gets the offer email.
  await json(
    await request.post(`${base}/appointments/${visit.id}/cancel`, {
      headers: owner,
      data: { version: visit.version, reason: 'Choroba' },
    }),
  );
  const offer = await waitForEmail(ANNA, /Termin czeka na Ciebie/, 120_000);
  expect(offer.text).toContain('15 minut');
  const link = /\/pl\/wo\/([\w-]+)/.exec(offer.text)?.[1];
  expect(link, 'offer link').toBeTruthy();

  const context = await browser.newContext({
    viewport: PHONE,
    locale: 'pl-PL',
    timezoneId: 'Europe/Warsaw',
  });
  const page = await context.newPage();
  await page.goto(`/pl/wo/${link}`);
  await expect(page.getByRole('heading', { name: 'Zwolnił się termin' })).toBeVisible();
  await expect(page.getByText('Strzyżenie męskie')).toBeVisible();
  await expect(page.getByText(/Trzymamy go dla Ciebie do/)).toBeVisible();
  const take = page.getByRole('button', { name: 'Biorę ten termin' });
  await expect(take).toBeDisabled();
  await page.getByLabel('Telefon').fill('+48 600 111 222');
  await shot(page, '164-waitlist-offer');
  await take.click();
  await expect(page.getByText('Gotowe! Wizyta zarezerwowana.')).toBeVisible();
  await shot(page, '164a-waitlist-offer-booked');
  await context.close();

  // The salon's calendar has Anna's visit at that time.
  const day = await json<{ items?: { customer?: { name: string } | null }[] }>(
    await request.get(`${base}/appointments`, {
      headers: owner,
      params: { from: taken.date, to: taken.date },
    }),
  );
  expect(JSON.stringify(day)).toContain('Anna Kowalska');
});
