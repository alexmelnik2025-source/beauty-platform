import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type APIResponse } from '@playwright/test';
import { freshAddress } from './addresses';
import { waitForEmail } from './mailpit';
import { serveApp } from './mobile-app';

async function json<T>(response: APIResponse): Promise<T> {
  expect(
    response.ok(),
    `${response.url()} → ${response.status()} ${await response.text()}`,
  ).toBeTruthy();
  return (response.status() === 204 ? undefined : await response.json()) as T;
}

async function createSalon(api: APIRequestContext) {
  const password = randomUUID();
  const email = `booking-h-owner-${randomUUID()}@example.com`;
  await json(
    await api.post('/v1/auth/register', {
      headers: freshAddress(),
      data: { email, password, name: 'Adam Nowak' },
    }),
  );
  const verification = await waitForEmail(email, /Potwierdź adres/);
  const token = /token=([^\s&]+)/.exec(verification.text)?.[1];
  expect(token).toBeTruthy();
  await json(
    await api.post('/v1/auth/verify-email', { data: { token: decodeURIComponent(token!) } }),
  );
  const login = await json<{ accessToken: string }>(
    await api.post('/v1/auth/login', {
      headers: freshAddress(),
      data: { email, password, clientType: 'mobile' },
    }),
  );
  const headers = { Authorization: `Bearer ${login.accessToken}` };
  const org = await json<{ id: string }>(
    await api.post('/v1/organizations', { headers, data: { name: 'Studio H' } }),
  );
  const salon = await json<{ id: string; slug: string; version: number }>(
    await api.post(`/v1/organizations/${org.id}/locations`, {
      headers,
      data: {
        name: 'Studio H',
        addressLine: 'ul. Bema 91',
        city: 'Warszawa',
        postalCode: '01-233',
        bookingTerms: 'Regulamin rezerwacji',
        privacyPolicy: 'Polityka prywatności',
      },
    }),
  );
  const base = `/v1/organizations/${org.id}/locations/${salon.id}`;
  const service = await json<{ id: string }>(
    await api.post(`${base}/services`, {
      headers,
      data: { name: 'Strzyżenie', durationMinutes: 30, priceGrosze: 9000 },
    }),
  );
  const weekdays = [1, 2, 3, 4, 5, 6, 7];
  for (const displayName of ['Kasia', 'Marek']) {
    const staff = await json<{ id: string }>(
      await api.post(`${base}/staff`, {
        headers,
        data: { displayName, serviceIds: [service.id] },
      }),
    );
    await json(
      await api.put(`${base}/staff/${staff.id}/working-hours`, {
        headers,
        data: {
          days: weekdays.map((weekday) => ({
            weekday,
            intervals: [{ start: '10:00', end: '12:00' }],
          })),
        },
      }),
    );
    if (displayName === 'Kasia') {
      await json(
        await api.put(`${base}/happy-hours`, {
          headers,
          data: {
            rules: [
              { weekdays, start: '10:00', end: '12:00', discountPercent: 20, staffIds: [staff.id] },
            ],
          },
        }),
      );
    }
  }
  return { slug: salon.slug, version: salon.version, base, headers };
}

test.use({
  viewport: { width: 320, height: 700 },
  isMobile: true,
  locale: 'pl-PL',
  timezoneId: 'Europe/Warsaw',
});

test('guest books a discounted time with a specialist and corrects a wrong code', async ({
  page,
  request,
}) => {
  const { slug, base, version, headers } = await createSalon(request);
  const email = `booking-h-client-${randomUUID()}@example.com`;
  await page.setExtraHTTPHeaders(freshAddress());
  const app = await serveApp('mobile-client');
  try {
    await json(
      await request.patch(base, { headers, data: { version, onlineBookingEnabled: true } }),
    );
    await page.goto(`${app.url}/pl/b/${slug}`);
    await page.getByRole('button', { name: 'Umów wizytę', exact: true }).click();
    const availability: URL[] = [];
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (url.pathname === `/v1/public/locations/${slug}/availability`) availability.push(url);
    });
    await page.getByRole('button', { name: /^Strzyżenie,/ }).click();
    await page.getByRole('button', { name: /^Dowolny specjalista,/ }).click();
    await expect(page.getByRole('button', { name: /^\d{2}:\d{2}/ }).first()).toBeVisible();
    expect(availability).toHaveLength(1);
    expect(availability[0]!.searchParams.has('staffId')).toBe(false);

    await page.getByRole('button', { name: '‹ Wróć' }).click();
    await page.getByRole('button', { name: /^Kasia(?:,|$)/ }).click();
    const slot = page.getByRole('button', { name: /^\d{2}:\d{2} .*−20%/ }).first();
    await expect(slot.getByText(/90,00\s*zł/)).toHaveCSS('text-decoration-line', 'line-through');
    await slot.click();
    await expect(page.getByText(/Strzyżenie · Kasia · .*72,00/)).toBeVisible();

    await page.getByLabel('Imię i nazwisko').fill('Ola Nowak');
    const phone = page.getByLabel('Telefon', { exact: true });
    await phone.fill('600 300 400');
    const countdown = page.getByText(/^Termin czeka na Ciebie jeszcze /);
    await expect(countdown).toBeVisible();
    const previousTime = await countdown.innerText();
    await expect(countdown).not.toHaveText(previousTime);
    await expect(phone).toBeFocused();
    await expect(phone).toHaveValue('600 300 400');
    await page.getByRole('textbox', { name: 'E-mail', exact: true }).fill(email);
    await page.getByRole('checkbox', { name: /Akceptuję regulamin/ }).click();
    await page.getByRole('button', { name: 'Wyślij kod' }).click();
    const mail = await waitForEmail(email, /Kod potwierdzenia/);
    const validCode = /\b(\d{6})\b/.exec(mail.text)?.[1];
    expect(validCode).toBeTruthy();
    const code = page.getByLabel('Kod z e-maila');
    const confirm = page.getByRole('button', { name: 'Potwierdź wizytę', exact: true });
    await code.fill(validCode === '000000' ? '111111' : '000000');
    await confirm.click();
    const fieldError = code.locator('..').getByRole('alert');
    await expect(fieldError).toContainText('Kod jest nieprawidłowy');
    await expect(code).toHaveAttribute('aria-invalid', 'true');
    await code.fill(validCode!);
    await expect(fieldError).toHaveCount(0);
    await confirm.click();
    await expect(page.getByRole('heading', { name: 'Do zobaczenia!' })).toBeVisible();
  } finally {
    app.server.close();
    // Restore the public directory shared with the other browser scenarios.
    const current = await json<{ version: number }>(await request.get(base, { headers }));
    await json(
      await request.patch(base, {
        headers,
        data: { version: current.version, onlineBookingEnabled: false },
      }),
    );
  }
});
