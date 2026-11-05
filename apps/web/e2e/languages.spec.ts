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
 * Launch task L5, part 4: Turkish and Albanian. A client in Istanbul opens the salon's short
 * link on a Turkish phone, books in Turkish, gets the code and the confirmation in Turkish with
 * the price in lira, and opens the visit link — then switches it to Albanian. The salon
 * dashboard keeps its four fully translated languages. Screenshots 71–71e.
 */

const PASSWORD = 'e2e-password-123';
const run = Date.now().toString(36);
const OWNER = `tr-owner-${run}@example.com`;
const CLIENT = `ayse-${run}@example.com`;
const PHONE = { width: 390, height: 844 };

const shot = (page: Page, name: string) => page.screenshot({ path: `e2e/screenshots/${name}.png` });

async function json<T>(res: APIResponse): Promise<T> {
  expect(res.ok(), `${res.url()} → ${res.status()} ${await res.text()}`).toBeTruthy();
  return (res.status() === 204 ? undefined : await res.json()) as T;
}

async function istanbulSalon(api: APIRequestContext): Promise<string> {
  await json(
    await api.post('/v1/auth/register', {
      headers: freshAddress(),
      data: { email: OWNER, password: PASSWORD, name: 'Emre Kaya' },
    }),
  );
  const mail = await waitForEmail(OWNER, /Potwierdź adres/);
  const token = /token=([^\s&]+)/.exec(mail.text)?.[1];
  await json(
    await api.post('/v1/auth/verify-email', { data: { token: decodeURIComponent(token!) } }),
  );
  const login = await json<{ accessToken: string }>(
    await api.post('/v1/auth/login', {
      data: { email: OWNER, password: PASSWORD, clientType: 'mobile' },
    }),
  );
  const owner = { Authorization: `Bearer ${login.accessToken}` };
  const org = await json<{ id: string }>(
    await api.post('/v1/organizations', { headers: owner, data: { name: 'Berber Moda' } }),
  );
  const location = await json<{ id: string; slug: string }>(
    await api.post(`/v1/organizations/${org.id}/locations`, {
      headers: owner,
      data: {
        name: 'Berber Moda',
        addressLine: 'Moda Cd. 1',
        city: 'İstanbul',
        postalCode: '34710',
        timezone: 'Europe/Istanbul',
        currency: 'TRY',
        defaultLocale: 'tr',
        minLeadMinutes: 180,
        onlineBookingEnabled: true,
        bookingTerms: '# Rezervasyon koşulları\n\nRandevu ücretsizdir.',
        privacyPolicy: '# Gizlilik politikası\n\nVeri sorumlusu Berber Moda’dır.',
      },
    }),
  );
  const base = `/v1/organizations/${org.id}/locations/${location.id}`;
  const service = await json<{ id: string }>(
    await api.post(`${base}/services`, {
      headers: owner,
      data: { name: 'Saç kesimi', durationMinutes: 45, priceGrosze: 50000, bufferMinutes: 0 },
    }),
  );
  const staff = await json<{ id: string }>(
    await api.post(`${base}/staff`, {
      headers: owner,
      data: { displayName: 'Emre', specialties: ['barber'], serviceIds: [service.id] },
    }),
  );
  await json(
    await api.put(`${base}/staff/${staff.id}/working-hours`, {
      headers: owner,
      data: {
        days: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
          weekday,
          intervals: [{ start: '08:00', end: '21:00' }],
        })),
      },
    }),
  );
  return location.slug;
}

test('a client books in Turkish and reads the visit in Albanian', async ({ browser, request }) => {
  const slug = await istanbulSalon(request);

  const phone = await browser.newContext({
    viewport: PHONE,
    isMobile: true,
    locale: 'tr-TR',
    timezoneId: 'Europe/Istanbul',
    // A client of its own (the API limits holds per address): the main scenario has already
    // held five times from this computer in the last ten minutes.
    extraHTTPHeaders: { 'x-forwarded-for': '203.0.113.71' },
  });
  const client = await phone.newPage();
  // The short link opens booking in the phone's language.
  await client.goto(`/s/${slug}`);
  await client.waitForURL(new RegExp(`/tr/b/${slug}`));
  await expect(client.locator('html')).toHaveAttribute('lang', 'tr');
  await expect(client.getByRole('heading', { name: 'Berber Moda' })).toBeVisible();
  const languages = client.getByRole('navigation', { name: 'Dil' });
  await expect(languages.getByRole('link')).toHaveText(['PL', 'UK', 'RU', 'EN', 'TR', 'SQ']);
  await shot(client, '71-booking-turkish');

  await client.getByRole('button', { name: /Saç kesimi/ }).click();
  await expect(client.getByRole('button', { name: /Herhangi bir uzman/ })).toBeVisible();
  await expect(client.getByRole('button', { name: /Emre/ }).locator('.c-specialty')).toHaveText(
    'Berber',
  );
  await client.getByRole('button', { name: /Emre/ }).click();
  await expect(client.locator('.times button').first()).toBeVisible();
  const errors: string[] = [];
  client.on('pageerror', (e) => errors.push(e.message));
  await client.locator('.times button').first().click();

  try {
    await expect(client.getByText(/Bu saat sizin için/)).toBeVisible();
  } catch (failure) {
    // Show what the page says instead (an error message or a crash) in the CI log.
    await shot(client, '71-debug-after-time');
    const text = await client.locator('body').innerText();
    throw new Error(`${String(failure)}\nPage errors: ${errors.join(' | ')}\nPage: ${text}`);
  }
  await expect(client.getByLabel('Ülke kodu')).toHaveValue('TR');
  await client.getByLabel('Ad soyad').fill('Ayşe Yılmaz');
  await client.getByLabel('Telefon').fill('+90 532 100 20 00');
  await client.getByLabel('E-posta').fill(CLIENT);
  await client.getByLabel(/rezervasyon koşullarını/).check();
  await expect(client.getByRole('link', { name: 'gizlilik politikasını' })).toHaveAttribute(
    'href',
    `/tr/b/${slug}/privacy`,
  );
  await shot(client, '71b-booking-turkish-details');
  await client.getByRole('button', { name: 'Kod gönder' }).click();

  const codeMail = await waitForEmail(CLIENT, /Rezervasyon onay kodunuz/);
  const code = /\b(\d{6})\b/.exec(codeMail.text)![1]!;
  await client.getByLabel('E-postadaki kod').fill(code);
  await client.getByRole('button', { name: 'Randevuyu onayla' }).click();
  await expect(client.getByRole('heading', { name: 'Görüşmek üzere!' })).toBeVisible();
  await shot(client, '71c-booking-turkish-done');

  const confirmation = await waitForEmail(CLIENT, /Randevunuz onaylandı/);
  expect(confirmation.text).toContain('Hizmet: Saç kesimi');
  expect(confirmation.text).toContain('₺');
  const manageLink = /(\/tr\/m\/\S+)/.exec(confirmation.text)![1]!;
  await client.goto(manageLink);
  await expect(client.getByText('Onaylandı')).toBeVisible();
  await expect(client.getByRole('button', { name: 'Randevuyu iptal et' })).toBeVisible();
  await shot(client, '71d-visit-turkish');

  await client.getByRole('navigation', { name: 'Dil' }).getByRole('link', { name: 'SQ' }).click();
  await client.waitForURL(/\/sq\/m\//);
  await expect(client.getByText('Takimi juaj')).toBeVisible();
  await expect(client.getByText('Konfirmuar')).toBeVisible();
  await expect(client.getByRole('button', { name: 'Anulo takimin' })).toBeVisible();
  await shot(client, '71e-visit-albanian');
  await phone.close();
});

test('the salon dashboard offers only its fully translated languages', async ({ page }) => {
  await page.goto('/tr/login');
  const languages = page.getByRole('navigation', { name: 'Dil' });
  await expect(languages.getByRole('link')).toHaveText(['PL', 'UK', 'RU', 'EN']);
});
