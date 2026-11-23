import { expect, test, type APIRequestContext, type APIResponse } from '@playwright/test';
import { freshAddress } from './addresses';
import { waitForEmail } from './mailpit';
import { serveApp } from './mobile-app';

const PASSWORD = 'e2e-password-123';
const run = Date.now().toString(36);
const OWNER = `app-client-voucher-reviews-owner-${run}@example.com`;
const SALON = `Studio Bony i Opinie ${run}`;

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

test('client app checks voucher balance and browses salon reviews in Polish at 320 px', async ({
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

  const app = await serveApp('mobile-client');
  const context = await browser.newContext({
    viewport: { width: 320, height: 844 },
    isMobile: true,
    locale: 'pl-PL',
    timezoneId: 'Europe/Warsaw',
    extraHTTPHeaders: freshAddress(),
  });
  try {
    // Control the review pages so the narrow-screen test can cover pagination with two reviews.
    const fiveStars = {
      id: 'review-five',
      rating: 5,
      text: 'Świetne strzyżenie, na pewno wrócę.',
      staffId: 'kasia',
      staffName: 'Kasia',
      serviceName: 'Strzyżenie męskie',
      reply: 'Dziękujemy za wizytę!',
      repliedAt: '2026-11-21T12:00:00Z',
      createdAt: '2026-11-20T12:00:00Z',
    };
    const fourStars = {
      ...fiveStars,
      id: 'review-four',
      rating: 4,
      text: 'Bardzo miła obsługa.',
      reply: null,
      repliedAt: null,
    };
    await context.route(
      (url) => url.pathname === `/v1/public/locations/${location.slug}/reviews`,
      async (route) => {
        const query = new URL(route.request().url()).searchParams;
        const filtered = query.get('rating') === '4';
        const secondPage = query.get('before') === fiveStars.id;
        await route.fulfill({
          json: {
            enabled: true,
            count: 2,
            average: 4.5,
            stars: [0, 0, 0, 1, 1],
            staff: [{ staffId: 'kasia', displayName: 'Kasia', count: 2, average: 4.5 }],
            items: [filtered || secondPage ? fourStars : fiveStars],
            nextBefore: filtered || secondPage ? null : fiveStars.id,
          },
        });
      },
    );

    const phone = await context.newPage();
    await phone.goto(app.url);
    await expect(async () => {
      await phone.getByRole('button', { name: 'Znajdź salon', exact: true }).click();
      await expect(phone.getByRole('heading', { name: 'Znajdź salon' })).toBeVisible({
        timeout: 3000,
      });
    }).toPass({ timeout: 20000 });
    await phone.getByLabel('Czego szukasz? Usługa, salon, miasto lub ulica').fill(SALON);
    await phone
      .getByRole('article', { name: SALON })
      .getByRole('button', { name: 'Zobacz salon' })
      .click();

    await phone.getByRole('button', { name: 'Masz bon podarunkowy? Sprawdź, ile zostało' }).click();
    const code = phone.getByLabel('Kod bonu');
    const check = phone.getByRole('button', { name: 'Sprawdź', exact: true });
    await expect(check).toBeDisabled();
    await code.fill('ZZZZ-ZZZZ');
    await check.click();
    const error = phone.getByText('Ten salon nie ma bonu z takim kodem. Sprawdź litery i cyfry.');
    await expect(error).toBeVisible();
    await expect(code).toHaveAttribute('aria-invalid', 'true');

    const formattedCode = `${voucher.code.slice(0, 4)}-${voucher.code.slice(4)}`.toLowerCase();
    await code.fill(formattedCode);
    await expect(error).toBeHidden();
    await check.click();
    const balance = phone.getByRole('status').filter({ hasText: 'Zostało' });
    await expect(balance).toContainText(/Zostało 150,00\s*zł z 200,00\s*zł/);
    await expect(balance).toContainText('Ważny · Ważny do');
    await expect(phone.getByText('Jan Kowalski')).toHaveCount(0);

    const reviews = phone.getByRole('region', { name: 'Opinie', exact: true });
    await expect(reviews).toContainText('★ 4,5 · opinie: 2');
    await expect(reviews.getByText(fiveStars.text)).toBeVisible();
    await expect(reviews.getByText(fiveStars.reply)).toBeVisible();
    const more = reviews.getByRole('button', { name: 'Pokaż więcej' });
    await more.click();
    await expect(reviews.getByText(fourStars.text)).toBeVisible();
    await expect(reviews.getByText(fiveStars.text)).toBeVisible();
    await expect(more).toBeHidden();
    const fourStarFilter = reviews.getByRole('radio', { name: '★ 4 (1)' });
    await fourStarFilter.click();
    await expect(fourStarFilter).toHaveAttribute('aria-checked', 'true');
    await expect(reviews.getByText(fiveStars.text)).toBeHidden();
    await expect(reviews.getByText(fourStars.text)).toBeVisible();
    await reviews.getByRole('radio', { name: 'Wszystkie oceny' }).click();
    await expect(reviews.getByText(fiveStars.text)).toBeVisible();
    await expect(reviews.getByText(fourStars.text)).toBeHidden();

    const dimensions = await phone.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      content: document.documentElement.scrollWidth,
    }));
    expect(dimensions).toEqual({ viewport: 320, content: 320 });
  } finally {
    await context.close();
    app.server.close();
    await json(
      await request.patch(base, {
        headers: owner,
        data: { version: online.version, onlineBookingEnabled: false },
      }),
    );
  }
});
