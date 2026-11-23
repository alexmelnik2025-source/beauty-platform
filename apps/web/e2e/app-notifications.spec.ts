import { expect, test, type APIRequestContext, type APIResponse } from '@playwright/test';
import { freshAddress } from './addresses';
import { waitForEmail } from './mailpit';
import { serveApp } from './mobile-app';

const PASSWORD = 'e2e-password-123';
const ADDRESS = freshAddress();
const OWNER = `app-notifications-owner-${Date.now().toString(36)}@example.com`;

async function json<T>(res: APIResponse): Promise<T> {
  expect(res.ok(), `${res.url()} → ${res.status()} ${await res.text()}`).toBeTruthy();
  return (res.status() === 204 ? undefined : await res.json()) as T;
}

async function verifiedUser(api: APIRequestContext, email: string, name: string) {
  await json(
    await api.post('/v1/auth/register', {
      headers: ADDRESS,
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
      headers: ADDRESS,
      data: { email, password: PASSWORD, clientType: 'mobile' },
    }),
  );
  return { Authorization: `Bearer ${login.accessToken}` };
}

test('business app shows new bookings and keeps their read state', async ({ browser, request }) => {
  const owner = await verifiedUser(request, OWNER, 'Aleksander Owner');
  const org = await json<{ id: string }>(
    await request.post('/v1/organizations', { headers: owner, data: { name: 'GESTALT' } }),
  );
  const location = await json<{ id: string; slug: string; version: number }>(
    await request.post(`/v1/organizations/${org.id}/locations`, {
      headers: owner,
      data: {
        name: 'Notifications Barbershop',
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
      data: { name: 'Strzyżenie', durationMinutes: 45, priceGrosze: 9000 },
    }),
  );
  const staff = await json<{ id: string }>(
    await request.post(`${base}/staff`, {
      headers: owner,
      data: { displayName: 'Kasia', serviceIds: [service.id] },
    }),
  );
  await json(
    await request.put(`${base}/staff/${staff.id}/working-hours`, {
      headers: owner,
      data: {
        days: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
          weekday,
          intervals: [{ start: '09:00', end: '18:00' }],
        })),
      },
    }),
  );

  const app = await serveApp('mobile-business');
  const context = await browser.newContext({
    viewport: { width: 320, height: 844 },
    isMobile: true,
    locale: 'pl-PL',
    timezoneId: 'Europe/Warsaw',
    extraHTTPHeaders: ADDRESS,
  });
  try {
    const phone = await context.newPage();
    await phone.goto(app.url);
    await phone.getByLabel('E-mail lub telefon').fill(OWNER);
    await phone.getByRole('button', { name: 'Wyślij kod' }).click();
    const mail = await waitForEmail(OWNER, /Kod logowania do aplikacji salonu/);
    await phone.getByLabel('Kod', { exact: true }).fill(/\b(\d{6})\b/.exec(mail.text)![1]!);
    await phone.getByRole('button', { name: 'Zaloguj się' }).click();

    const bell = phone.getByRole('button', { name: /^Powiadomienia(?: \(\d+\))?$/ });
    const back = phone.getByRole('button', { name: '‹ Wróć', exact: true });
    const readAll = phone.getByRole('button', { name: 'Oznacz wszystkie jako przeczytane' });
    await bell.click();
    await expect(phone.getByRole('heading', { name: 'Powiadomienia' })).toBeVisible();
    await expect(phone.getByText('Nie ma powiadomień w tym salonie.')).toBeVisible();
    await expect(readAll).toBeHidden();
    await back.click();

    const publicPath = `/v1/public/locations/${location.slug}`;
    const clientAddress = freshAddress();
    const from = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
    const availability = await json<{ slots: { start: string }[] }>(
      await request.get(`${publicPath}/availability`, {
        params: { serviceId: service.id, staffId: staff.id, from, to: from },
      }),
    );
    const hold = await json<{ holdId: string; holdToken: string }>(
      await request.post(`${publicPath}/holds`, {
        headers: clientAddress,
        data: { serviceId: service.id, staffId: staff.id, start: availability.slots[0]!.start },
      }),
    );
    const email = OWNER.replace('-owner-', '-client-');
    await json(
      await request.post(`/v1/public/holds/${hold.holdId}/code`, {
        headers: clientAddress,
        data: {
          holdToken: hold.holdToken,
          name: 'Anna Kowalska',
          phone: '+48600300400',
          email,
          locale: 'pl',
          acceptTerms: true,
        },
      }),
    );
    const bookingMail = await waitForEmail(email, /Kod potwierdzenia/);
    await json(
      await request.post(`/v1/public/holds/${hold.holdId}/confirm`, {
        headers: clientAddress,
        data: { holdToken: hold.holdToken, code: /\b(\d{6})\b/.exec(bookingMail.text)![1]! },
      }),
    );

    await bell.click();
    const unread = phone.getByRole('button', {
      name: /^Nowe: Nowa wizyta online, .* Anna Kowalska$/,
    });
    const read = phone.getByRole('button', { name: /^Nowa wizyta online, .* Anna Kowalska$/ });
    await expect(unread).toBeVisible();
    await expect(phone.getByText('Anna Kowalska · Strzyżenie · Kasia')).toBeVisible();
    await expect(readAll).toBeVisible();
    await readAll.click();
    await expect(read).toBeVisible();
    await expect(unread).toBeHidden();
    await expect(readAll).toBeHidden();
    await back.click();
    await bell.click();
    await expect(read).toBeVisible();
    await expect(unread).toBeHidden();
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
