import { execFileSync } from 'node:child_process';
import { expect, test, type APIResponse, type Page } from '@playwright/test';
import { freshAddress } from './addresses';
import { listTo, waitForEmail } from './mailpit';
import { serveApp } from './mobile-app';

/**
 * Task 165d: "your specialist". A client went to Kasia twice; in the client app "Moje wizyty"
 * shows "Twoi specjaliści" with Kasia, and "Umów u: Kasia" opens her free times at once.
 * Screenshots 165d, 165d-a. Task 292: "Historia" on the site starts with "Twoje wizyty" — 3 visits,
 * the two paid ones in total (screenshot 292).
 */

const PASSWORD = 'e2e-password-123';
const run = Date.now().toString(36);
const OWNER = `fav-owner-${run}@example.com`;
const CLIENT = `fav-client-${run}@example.com`;
const SALON = `Ulubiony Barber ${run}`;
const PHONE = { width: 390, height: 844 };

const shot = (page: Page, name: string) => page.screenshot({ path: `e2e/screenshots/${name}.png` });

async function json<T>(res: APIResponse): Promise<T> {
  expect(res.ok(), `${res.url()} → ${res.status()} ${await res.text()}`).toBeTruthy();
  return (res.status() === 204 ? undefined : await res.json()) as T;
}

/** Visits can't be booked in the past: book ahead, then move them back and mark them done. */
function tookPlace(appointmentId: string, daysAgo: number, paid = false) {
  const url = (process.env.DATABASE_URL ?? '').replace(/\?.*$/, '');
  const shift = `interval '${daysAgo + 3} days'`;
  const paidAt = paid ? ', paid_at = now()' : '';
  execFileSync('psql', [
    url,
    '-v',
    'ON_ERROR_STOP=1',
    '-c',
    `UPDATE appointment SET status = 'completed', start_at = start_at - ${shift}, end_at = end_at - ${shift}, blocked_until = blocked_until - ${shift}${paidAt} WHERE id = '${appointmentId}'`,
  ]);
}

test('"Twoi specjaliści" in the client app books the usual specialist in one tap', async ({
  browser,
  request,
}) => {
  const ownerIp = freshAddress();
  await json(
    await request.post('/v1/auth/register', {
      headers: ownerIp,
      data: { email: OWNER, password: PASSWORD, name: 'Aleksander Owner' },
    }),
  );
  const mail = await waitForEmail(OWNER, /Potwierdź adres/);
  const verify = /token=([^\s&]+)/.exec(mail.text)?.[1];
  await json(
    await request.post('/v1/auth/verify-email', {
      data: { token: decodeURIComponent(verify!) },
    }),
  );
  const login = await json<{ accessToken: string }>(
    await request.post('/v1/auth/login', {
      headers: ownerIp,
      data: { email: OWNER, password: PASSWORD, clientType: 'mobile' },
    }),
  );
  const owner = { Authorization: `Bearer ${login.accessToken}` };
  const org = await json<{ id: string }>(
    await request.post('/v1/organizations', { headers: owner, data: { name: SALON } }),
  );
  const location = await json<{ id: string; slug: string }>(
    await request.post(`/v1/organizations/${org.id}/locations`, {
      headers: owner,
      data: {
        name: SALON,
        addressLine: 'ul. Józefa Bema 91',
        city: 'Warszawa',
        postalCode: '01-233',
        onlineBookingEnabled: true,
        bookingTerms: '# Regulamin\n\nWizyta jest bezpłatna do odwołania.',
        privacyPolicy: '# Prywatność\n\nAdministratorem danych jest salon.',
      },
    }),
  );
  const base = `/v1/organizations/${org.id}/locations/${location.id}`;
  const service = await json<{ id: string }>(
    await request.post(`${base}/services`, {
      headers: owner,
      data: { name: 'Strzyżenie fade', durationMinutes: 45, priceGrosze: 9000 },
    }),
  );
  for (const name of ['Kasia', 'Marek']) {
    const staff = await json<{ id: string }>(
      await request.post(`${base}/staff`, {
        headers: owner,
        data: { displayName: name, serviceIds: [service.id] },
      }),
    );
    await json(
      await request.put(`${base}/staff/${staff.id}/working-hours`, {
        headers: owner,
        data: {
          days: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
            weekday,
            intervals: [{ start: '08:00', end: '21:00' }],
          })),
        },
      }),
    );
  }
  const salon = await json<{ staff: { id: string; displayName: string }[] }>(
    await request.get(`/v1/public/locations/${location.slug}`),
  );
  const kasia = salon.staff.find((s) => s.displayName === 'Kasia')!.id;
  const marek = salon.staff.find((s) => s.displayName === 'Marek')!.id;

  // Two visits with Kasia and one with Marek, booked by the client, then in the past.
  const clientIp = freshAddress();
  const day = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
  async function book(staffId: string, index: number): Promise<string> {
    const free = await json<{ slots: { start: string }[] }>(
      await request.get(`/v1/public/locations/${location.slug}/availability`, {
        headers: clientIp,
        params: { serviceId: service.id, staffId, from: day, to: day },
      }),
    );
    const hold = await json<{ holdId: string; holdToken: string }>(
      await request.post(`/v1/public/locations/${location.slug}/holds`, {
        headers: clientIp,
        data: { serviceId: service.id, staffId, start: free.slots[index]!.start },
      }),
    );
    await json(
      await request.post(`/v1/public/holds/${hold.holdId}/code`, {
        headers: clientIp,
        data: {
          holdToken: hold.holdToken,
          name: 'Piotr Zieliński',
          phone: '+48 600 300 200',
          email: CLIENT,
          locale: 'pl',
          acceptTerms: true,
        },
      }),
    );
    await expect
      .poll(
        async () =>
          (await listTo(CLIENT)).filter((m) => /Kod potwierdzenia/.test(m.Subject)).length,
      )
      .toBeGreaterThan(index);
    const codeMail = await waitForEmail(CLIENT, /Kod potwierdzenia/);
    const confirmed = await json<{ appointment: { id: string } }>(
      await request.post(`/v1/public/holds/${hold.holdId}/confirm`, {
        headers: clientIp,
        data: { holdToken: hold.holdToken, code: /\b(\d{6})\b/.exec(codeMail.text)![1] },
      }),
    );
    return confirmed.appointment.id;
  }
  tookPlace(await book(kasia, 0), 40, true);
  tookPlace(await book(marek, 1), 20, true);
  tookPlace(await book(kasia, 2), 10);

  // ── The client app ───────────────────────────────────────────────────
  const clientApp = await serveApp('mobile-client');
  const phone = await browser.newContext({
    viewport: PHONE,
    isMobile: true,
    locale: 'pl-PL',
    timezoneId: 'Europe/Warsaw',
    extraHTTPHeaders: clientIp,
  });
  try {
    const app = await phone.newPage();
    await app.goto(clientApp.url);
    await app.getByLabel('E-mail', { exact: true }).fill(CLIENT);
    await app.getByRole('button', { name: 'Wyślij kod' }).click();
    const signIn = await waitForEmail(CLIENT, /Kod logowania do Twoich wizyt/);
    await app.getByLabel('Kod z e-maila').fill(/\b(\d{6})\b/.exec(signIn.text)![1]!);
    await app.getByRole('button', { name: 'Zaloguj się' }).click();
    const mine = app.getByRole('region', { name: 'Twoi specjaliści' });
    await expect(mine.getByText('Kasia', { exact: true })).toBeVisible();
    await expect(mine.getByText('Strzyżenie fade · wizyty: 2')).toBeVisible();
    await expect(mine.getByText('Marek', { exact: true })).toHaveCount(0);
    await shot(app, '165d-client-app-my-specialists');
    await mine.getByRole('button', { name: 'Umów u: Kasia' }).click();
    await expect(app.getByRole('heading', { name: 'Wybierz termin' })).toBeVisible();
    await shot(app, '165d-a-client-app-book-my-specialist');
    // Task 180e: signed in - the visit is booked without a code, with the account's email.
    await app
      .getByRole('button', { name: /^\d{2}:\d{2}$/ })
      .first()
      .click();
    await expect(app.getByRole('heading', { name: 'Twoje dane' })).toBeVisible();
    await expect(app.getByText('Jesteś zalogowany(-a) — kod nie jest potrzebny.')).toBeVisible();
    await expect(app.getByRole('textbox', { name: 'E-mail', exact: true })).toHaveValue(CLIENT);
    await expect(app.getByRole('button', { name: 'Wyślij kod' })).toHaveCount(0);
    await app.getByRole('textbox', { name: 'Imię i nazwisko' }).fill('Piotr Zieliński');
    await app.getByRole('textbox', { name: 'Telefon' }).fill('600 300 200');
    await app.getByRole('checkbox', { name: /Akceptuję regulamin rezerwacji/ }).click();
    await shot(app, '180e-b-client-app-signed-in-details');
    await app.getByRole('button', { name: 'Potwierdź wizytę' }).click();
    await expect(app.getByRole('heading', { name: 'Do zobaczenia!' })).toBeVisible();
    await shot(app, '180e-c-client-app-signed-in-booked');
  } finally {
    await phone.close();
    clientApp.server.close();
  }

  // ── Task 203: the same "Twoi specjaliści" on the site's "Moje wizyty" ────
  const site = await browser.newContext({
    viewport: PHONE,
    isMobile: true,
    locale: 'pl-PL',
    timezoneId: 'Europe/Warsaw',
    extraHTTPHeaders: clientIp,
  });
  try {
    const page = await site.newPage();
    await page.goto('/pl/c');
    const loginCode = /Kod logowania do Twoich wizyt/;
    const codesBefore = (await listTo(CLIENT)).filter((m) => loginCode.test(m.Subject)).length;
    await page.getByLabel('E-mail').fill(CLIENT);
    await page.getByRole('button', { name: 'Wyślij kod' }).click();
    await expect
      .poll(async () => (await listTo(CLIENT)).filter((m) => loginCode.test(m.Subject)).length)
      .toBeGreaterThan(codesBefore);
    const mail = await waitForEmail(CLIENT, loginCode);
    await page.getByLabel('Kod z e-maila').fill(/\b(\d{6})\b/.exec(mail.text)![1]!);
    await page.getByRole('button', { name: 'Zaloguj się' }).click();
    const mine = page.getByRole('region', { name: 'Twoi specjaliści' });
    await expect(mine.getByText('Kasia', { exact: true })).toBeVisible();
    await expect(mine.getByText('Strzyżenie fade · wizyty: 2')).toBeVisible();
    await expect(mine.getByText('Marek', { exact: true })).toHaveCount(0);
    await shot(page, '203-site-my-specialists');
    // Task 292: "Twoje wizyty" on top of the past visits.
    await page.getByRole('button', { name: 'Historia' }).click();
    const summary = page.getByRole('region', { name: 'Twoje wizyty' });
    await expect(summary.getByText(/^Odbyte wizyty: 3 · od \d{1,2} \S+ \d{4}/)).toBeVisible();
    await expect(summary.getByText(/^Zapłacono łącznie: 180,00\s?zł$/)).toBeVisible();
    await shot(page, '292-site-visit-summary');
    await page.getByRole('button', { name: 'Nadchodzące' }).click();
    await mine.getByRole('link', { name: 'Umów u: Kasia' }).click();
    // The booking page starts on Kasia's free times for the same service.
    await expect(page).toHaveURL(/\/pl\/b\/.+\?service=.+&staff=.+/);
    await expect(page.locator('.times button').first()).toBeVisible();
    await shot(page, '203-a-site-book-my-specialist');
  } finally {
    await site.close();
  }
});
