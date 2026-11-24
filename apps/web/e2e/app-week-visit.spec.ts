import { expect, test, type APIResponse, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { freshAddress } from './addresses';
import { waitForEmail } from './mailpit';
import { serveApp } from './mobile-app';

const zone = 'Europe/Warsaw';

async function json<T>(response: APIResponse): Promise<T> {
  await expect(response).toBeOK();
  return response.json();
}

// ScrollView can hide overflow even when the document itself is exactly 320 px wide.
async function expectFitsPhone(page: Page) {
  const layout = await page.evaluate(() => {
    const width = document.documentElement.clientWidth;
    const clipped = Array.from(
      document.querySelectorAll<HTMLElement>(
        '#root [role="button"], #root input, #root div[dir="auto"]',
      ),
    )
      .filter((el) => {
        const rect = el.getBoundingClientRect();
        return (
          rect.width > 0 &&
          (rect.left < -1 || rect.right > width + 1 || el.scrollWidth > el.clientWidth + 1)
        );
      })
      .map((el) => el.getAttribute('aria-label') ?? el.textContent);
    return { width, clipped };
  });
  expect(layout).toEqual({ width: 320, clipped: [] });
}

test.use({
  viewport: { width: 320, height: 844 },
  isMobile: true,
  locale: 'pl-PL',
  timezoneId: zone,
});

test('business app: browse weeks, mark attendance, move a visit and unblock time', async ({
  page,
  request,
}) => {
  const email = `week-visit-${Date.now().toString(36)}@example.com`;
  const headers = freshAddress();
  const credentials = { email, password: 'e2e-password-123' };
  await expect(
    await request.post('/v1/auth/register', {
      headers,
      data: { ...credentials, name: 'Anna Nowak' },
    }),
  ).toBeOK();
  const verification = await waitForEmail(email, /Potwierdź adres/);
  const token = /token=([^\s&]+)/.exec(verification.text)![1]!;
  await expect(
    await request.post('/v1/auth/verify-email', {
      headers,
      data: { token: decodeURIComponent(token) },
    }),
  ).toBeOK();
  const login = await json<{ accessToken: string }>(
    await request.post('/v1/auth/login', {
      headers,
      data: { ...credentials, clientType: 'mobile' },
    }),
  );
  const owner = { Authorization: `Bearer ${login.accessToken}` };
  const org = await json<{ id: string }>(
    await request.post('/v1/organizations', { headers: owner, data: { name: 'Studio Warszawa' } }),
  );
  const location = await json<{ id: string }>(
    await request.post(`/v1/organizations/${org.id}/locations`, {
      headers: owner,
      data: {
        name: 'Pracownia fryzjerska na Starym Mieście',
        addressLine: 'ul. Długa 1',
        city: 'Warszawa',
        postalCode: '00-001',
      },
    }),
  );
  const base = `/v1/organizations/${org.id}/locations/${location.id}`;
  const service = await json<{ id: string }>(
    await request.post(`${base}/services`, {
      headers: owner,
      data: { name: 'Strzyżenie', durationMinutes: 30, priceGrosze: 8000 },
    }),
  );
  const staff = await json<{ id: string }>(
    await request.post(`${base}/staff`, {
      headers: owner,
      data: { displayName: 'Katarzyna Nowak-Kowalska', serviceIds: [service.id] },
    }),
  );
  await expect(
    await request.put(`${base}/staff/${staff.id}/working-hours`, {
      headers: owner,
      data: {
        days: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
          weekday,
          intervals: [{ start: '09:00', end: '16:00' }],
        })),
      },
    }),
  ).toBeOK();

  const today = new Intl.DateTimeFormat('en-CA', { timeZone: zone }).format(new Date());
  const nextWeek = new Date(today);
  nextWeek.setUTCDate(nextWeek.getUTCDate() + 7);
  const date = nextWeek.toISOString().slice(0, 10);
  const book = async (hour: string, name: string, phone: string) =>
    json<{ id: string }>(
      await request.post(`${base}/appointments`, {
        headers: owner,
        data: {
          staffId: staff.id,
          serviceId: service.id,
          start: `${date}T${hour}:00Z`,
          customer: { name, phone },
        },
      }),
    );
  const past = await book('09:00', 'Jan Nowak', '+48600001001');
  await book('12:00', 'Ewa Lis', '+48600001002');
  // Attendance requires a started visit. Age only this fixture in the e2e database.
  execFileSync(
    'psql',
    [
      (process.env.DATABASE_URL ?? '').split('?')[0]!,
      '-v',
      'ON_ERROR_STOP=1',
      '-v',
      `id=${past.id}`,
    ],
    {
      input: `UPDATE appointment SET start_at = start_at - interval '14 days',
      end_at = end_at - interval '14 days', blocked_until = blocked_until - interval '14 days'
      WHERE id = :'id';`,
    },
  );

  const app = await serveApp('mobile-business');
  const button = (name: string | RegExp) => page.getByRole('button', { name, exact: true });
  const bookedDay = button(/wizyty: 1/);
  try {
    await page.setExtraHTTPHeaders(headers);
    await page.goto(app.url);
    await page.getByLabel('E-mail lub telefon').fill(email);
    await button('Wyślij kod').click();
    const mail = await waitForEmail(email, /Kod logowania do aplikacji salonu/);
    await page.getByLabel('Kod', { exact: true }).fill(/\b(\d{6})\b/.exec(mail.text)![1]!);
    await button('Zaloguj się').click();

    await button('Tydzień').click();
    await expect(page.getByText('Wizyty w tygodniu: 0')).toBeVisible();
    await page.addStyleTag({ content: 'html { -webkit-text-size-adjust: 130% !important; }' });
    await page.route('**/calendar?from=*&to=*', (route) => route.abort(), { times: 1 });
    await button('Poprzedni tydzień').click();
    await expect(page.getByRole('alert')).toContainText('Brak połączenia');
    await button('Odśwież').click();
    await expect(bookedDay).toBeVisible();
    await expectFitsPhone(page);
    await bookedDay.click();
    // A malformed price in the detail response must be identified beside Cena.
    await page.route(
      `**/appointments/${past.id}`,
      async (route) => {
        const response = await route.fetch();
        await route.fulfill({ response, json: { ...(await response.json()), priceGrosze: -1 } });
      },
      { times: 1 },
    );
    await button(/^\d\d:\d\d Jan Nowak · Strzyżenie$/).click();
    await expect(page.getByText('Potwierdzona', { exact: true })).toBeVisible();
    const priceError = page.getByText('Cena', { exact: true }).locator('..').getByRole('alert');
    await expect(priceError).toContainText('! Cena to liczba');
    await button('Przyszedł').click();
    await expect(page.getByText('Odbyła się', { exact: true })).toBeVisible();
    await expect(priceError).toHaveCount(0);
    const tipField = page.getByTestId('tip-field');
    const tip = tipField.getByRole('textbox');
    await tip.fill('-1');
    await expect(tipField.getByRole('alert')).toContainText('! Wpisz kwotę');
    await expect(button('Zapisz napiwek')).toBeDisabled();
    await tip.fill('12,50');
    await page.route('**/appointments/*/tip', (route) => route.abort(), { times: 1 });
    await button('Zapisz napiwek').click();
    await expect(tipField.getByRole('alert')).toContainText('Brak połączenia');
    await expect(tip).toHaveValue('12,50');
    await button('Zapisz napiwek').click();
    await expect(button('Zapisz napiwek')).toBeDisabled();
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expectFitsPhone(page);
    await button('‹ Wróć').click();
    await expect(button(/Jan Nowak · Strzyżenie/)).toContainText('Zakończona');

    await button('Tydzień').click();
    await button('Ten tydzień').click();
    await expect(page.getByText('Wizyty w tygodniu: 0')).toBeVisible();
    await button('Następny tydzień').click();
    await bookedDay.click();
    await button(/^\d\d:\d\d Ewa Lis · Strzyżenie$/).click();
    await button('Odwołaj wizytę').click();
    const reason = page.getByLabel('Powód (klient go zobaczy)');
    await reason.fill('   ');
    await button('Odwołaj wizytę').click();
    await expect(reason.locator('..').getByRole('alert')).toHaveText('! Wpisz powód odwołania.');
    await reason.fill('Zmiana planów');
    await expect(page.getByRole('alert')).toHaveCount(0);
    await button('Odwołaj wizytę').click();
    await page.route('**/appointments/*/cancel', (route) => route.abort(), { times: 1 });
    await button('Tak, odwołaj').click();
    await expect(reason.locator('..').getByRole('alert')).toContainText('Brak połączenia');
    await expect(reason).toHaveValue('Zmiana planów');
    await button('Nie').click();
    await button('Zamknij').click();
    await button('Przenieś').click();
    await button('Następny dzień').click();
    await expect(button('09:00')).toBeVisible();
    await expectFitsPhone(page);
    await button('09:00').click();
    await expect(page.getByText(/^Przenieść na .*09:00\?$/)).toBeVisible();
    await expectFitsPhone(page);
    await page.route('**/appointments/*/reschedule', (route) => route.abort(), { times: 1 });
    await button('Tak').click();
    await expect(page.getByRole('alert')).toContainText('Brak połączenia');
    await expect(page.getByText(/^Przenieść na .*09:00\?$/)).toBeVisible();
    await button('Tak').click();
    await expect(page.getByText(/^Wizyta przeniesiona\./)).toBeVisible();
    await expect(page.getByRole('heading', { name: '09:00–09:30' })).toBeVisible();
    await button('‹ Wróć').click();
    await expect(page.getByText('Brak wizyt tego dnia.')).toBeVisible();
    await button('Następny dzień').click();
    await expect(button('09:00 Ewa Lis · Strzyżenie')).toBeVisible();

    await button('+ Zablokuj czas').click();
    await button('Cały salon').click();
    await page.getByLabel('Powód (np. przerwa)').fill('Przerwa obiadowa');
    await expectFitsPhone(page);
    await button('Zablokuj').click();
    await expect(page.getByText('12:00–13:00 · Cały salon')).toBeVisible();
    await expect(page.getByText('Przerwa obiadowa')).toBeVisible();
    await button('Odblokuj 12:00–13:00').click();
    await button('Tak, odblokuj').click();
    await expect(page.getByText('Czas odblokowany.')).toBeVisible();
    await expect(page.getByText('Przerwa obiadowa')).toHaveCount(0);
  } finally {
    app.server.close();
  }
});
