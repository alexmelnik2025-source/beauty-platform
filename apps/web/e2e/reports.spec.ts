import {
  expect,
  test,
  type APIRequestContext,
  type APIResponse,
  type Page,
} from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { waitForEmail } from './mailpit';

/**
 * Task 14: the owner's report — two visits two days ago (one paid, one "did not come"), then
 * "Raporty" with a custom period. Screenshots 74 (desktop) and 74a (phone).
 */

const PASSWORD = 'e2e-password-123';
const run = Date.now().toString(36);
const OWNER = `reports-owner-${run}@example.com`;
const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1440, height: 900 };

const shot = (page: Page, name: string) => page.screenshot({ path: `e2e/screenshots/${name}.png` });

async function json<T>(res: APIResponse): Promise<T> {
  expect(res.ok(), `${res.url()} → ${res.status()} ${await res.text()}`).toBeTruthy();
  return (res.status() === 204 ? undefined : await res.json()) as T;
}

/** Moves a visit booked for tomorrow two days back, straight in the e2e database. */
function moveToThePast(appointmentId: string) {
  const url = (process.env.DATABASE_URL ?? '').replace(/\?.*$/, '');
  execFileSync('psql', [
    url,
    '-v',
    'ON_ERROR_STOP=1',
    '-c',
    `UPDATE appointment SET start_at = start_at - interval '2 days', end_at = end_at - interval '2 days', blocked_until = blocked_until - interval '2 days' WHERE id = '${appointmentId}'`,
  ]);
}

async function verifiedUser(api: APIRequestContext, email: string, name: string) {
  await json(await api.post('/v1/auth/register', { data: { email, password: PASSWORD, name } }));
  const mail = await waitForEmail(email, /Potwierdź adres/);
  const token = /token=([^\s&]+)/.exec(mail.text)?.[1];
  expect(token, 'verification link').toBeTruthy();
  await json(
    await api.post('/v1/auth/verify-email', { data: { token: decodeURIComponent(token!) } }),
  );
  const login = await json<{ accessToken: string }>(
    await api.post('/v1/auth/login', { data: { email, password: PASSWORD, clientType: 'mobile' } }),
  );
  return { Authorization: `Bearer ${login.accessToken}` };
}

async function signIn(page: Page, email: string) {
  await page.goto('/pl/login');
  await page.getByLabel('E-mail').fill(email);
  await page.getByLabel('Hasło').fill(PASSWORD);
  await page.getByRole('button', { name: 'Zaloguj się' }).click();
  await page.waitForURL(/\/pl\/app\/calendar/);
}

test('the owner sees what happened at the salon in "Raporty"', async ({ browser, request }) => {
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
  const haircut = await json<{ id: string }>(
    await request.post(`${base}/services`, {
      headers: owner,
      data: { name: 'Strzyżenie męskie', durationMinutes: 45, priceGrosze: 9000, bufferMinutes: 0 },
    }),
  );
  const staff = await json<{ id: string }>(
    await request.post(`${base}/staff`, {
      headers: owner,
      data: { displayName: 'Kasia', serviceIds: [haircut.id] },
    }),
  );
  const tomorrow = Math.ceil((Date.now() + 86_400_000) / 300_000) * 300_000;
  const outcomes = [
    { name: 'Jan Nowak', phone: '+48600100201', status: 'completed', paid: true },
    { name: 'Ewa Zielińska', phone: '+48600100202', status: 'no_show', paid: false },
  ];
  for (const [i, o] of outcomes.entries()) {
    const booked = await json<{ id: string }>(
      await request.post(`${base}/appointments`, {
        headers: owner,
        data: {
          serviceId: haircut.id,
          staffId: staff.id,
          start: new Date(tomorrow + i * 3_600_000).toISOString(),
          customer: { name: o.name, phone: o.phone },
          allowOutsideHours: true,
        },
      }),
    );
    moveToThePast(booked.id);
    const current = await json<{ version: number }>(
      await request.get(`${base}/appointments/${booked.id}`, { headers: owner }),
    );
    const marked = await json<{ version: number }>(
      await request.post(`${base}/appointments/${booked.id}/status`, {
        headers: owner,
        data: { version: current.version, status: o.status },
      }),
    );
    if (o.paid) {
      await json(
        await request.post(`${base}/appointments/${booked.id}/payment`, {
          headers: owner,
          data: { version: marked.version, paid: true },
        }),
      );
    }
  }

  const context = await browser.newContext({ viewport: DESKTOP, locale: 'pl-PL' });
  const page = await context.newPage();
  await signIn(page, OWNER);
  await page.getByRole('link', { name: 'Raporty' }).click();
  await page.waitForURL(/\/pl\/app\/reports$/);
  await expect(page.getByRole('heading', { name: 'Raporty', level: 1 })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Ten miesiąc' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  // Two days ago may be last month: a custom period of the last week covers it.
  await page.getByRole('button', { name: 'Własny okres' }).click();
  const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
  const inTwoDays = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
  await page.getByLabel('Od', { exact: true }).fill(weekAgo);
  await page.getByLabel('Do', { exact: true }).fill(inTwoDays);
  const totals = page.getByRole('list', { name: 'Podsumowanie' });
  await expect(totals).toContainText('Zapłacono');
  await expect(totals).toContainText('90,00');
  await expect(totals).toContainText('50% nieobecności');
  await expect(totals).toContainText('Nowi: 1');
  const byStaff = page.getByRole('table', { name: 'Specjaliści' });
  await expect(byStaff.getByRole('row', { name: /Kasia/ })).toContainText('90,00');
  await expect(page.getByRole('table', { name: 'Usługi' })).toContainText('Strzyżenie męskie');
  await shot(page, '74-owner-reports');

  // On a phone: from "More".
  const phone = await browser.newContext({ viewport: PHONE, locale: 'pl-PL', isMobile: true });
  const mobile = await phone.newPage();
  await signIn(mobile, OWNER);
  await mobile.goto('/pl/app/more');
  await mobile.getByRole('main').getByRole('link', { name: 'Raporty' }).click();
  await expect(mobile.getByRole('heading', { name: 'Raporty', level: 1 })).toBeVisible();
  await expect(
    mobile
      .getByRole('list', { name: 'Podsumowanie' })
      .or(mobile.getByText('W tym okresie nie było wizyt.')),
  ).toBeVisible();
  await shot(mobile, '74a-owner-reports-phone');
  await phone.close();
  await context.close();
});
