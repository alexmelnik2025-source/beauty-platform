import {
  expect,
  test,
  type APIRequestContext,
  type APIResponse,
  type Page,
} from '@playwright/test';
import { waitForEmail } from './mailpit';

/**
 * Task 80b/80f: "Pokaż, co chcesz". The owner lets clients add example photos for a service;
 * a client books with a photo (through the API, as the booking page and the app do); the
 * owner sees the photo in the visit card. Screenshots 21p–21q.
 */

const PASSWORD = 'e2e-password-123';
const run = Date.now().toString(36);
const OWNER = `photos-owner-${run}@example.com`;
const CLIENT = `photos-client-${run}@example.com`;
const DESKTOP = { width: 1280, height: 900 };

const shot = (page: Page, name: string) => page.screenshot({ path: `e2e/screenshots/${name}.png` });

async function json<T>(res: APIResponse): Promise<T> {
  expect(res.ok(), `${res.url()} → ${res.status()} ${await res.text()}`).toBeTruthy();
  return (res.status() === 204 ? undefined : await res.json()) as T;
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

/** A small photo drawn in the browser (like the one a phone would send after shrinking). */
async function drawnPhoto(page: Page): Promise<Buffer> {
  const base64 = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 400;
    const ctx = canvas.getContext('2d')!;
    const gradient = ctx.createLinearGradient(0, 0, 320, 400);
    gradient.addColorStop(0, '#c8a46a');
    gradient.addColorStop(1, '#1d1d1b');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 320, 400);
    ctx.fillStyle = '#ffffff';
    ctx.font = '40px sans-serif';
    ctx.fillText('FADE', 100, 210);
    return canvas.toDataURL('image/jpeg', 0.9).split(',')[1]!;
  });
  return Buffer.from(base64, 'base64');
}

test('the owner asks for photos; the client adds one; the specialist sees it', async ({
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
        name: 'Gestalt Barbershop',
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
        bookingTerms: '# Regulamin rezerwacji\n\nRezerwacja jest bezpłatna.',
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

  // ── The owner switches photos on in the service window ─────────────────
  const desk = await browser.newContext({
    viewport: DESKTOP,
    locale: 'pl-PL',
    timezoneId: 'Europe/Warsaw',
  });
  const cabinet = await desk.newPage();
  await cabinet.goto('/pl/login');
  await cabinet.getByLabel('E-mail').fill(OWNER);
  await cabinet.getByLabel('Hasło').fill(PASSWORD);
  await cabinet.getByRole('button', { name: 'Zaloguj się' }).click();
  await cabinet.waitForURL(/\/pl\/app\/calendar/);
  await cabinet.goto('/pl/app/services');
  await cabinet.getByRole('button', { name: /Strzyżenie fade/ }).click();
  const dialog = cabinet.getByRole('dialog');
  const ask = dialog.getByRole('checkbox', { name: /Klient może dodać zdjęcia-inspiracje/ });
  await expect(ask).not.toBeChecked();
  await ask.check();
  await shot(cabinet, '21p-owner-service-wish-photos');
  await dialog.getByRole('button', { name: 'Zapisz' }).click();
  await expect(dialog).toBeHidden();
  const page = await json<{ services: { id: string; wishPhotos: boolean }[] }>(
    await request.get(`/v1/public/locations/${location.slug}`),
  );
  expect(page.services.find((s) => s.id === service.id)?.wishPhotos).toBe(true);

  // ── A client books with an example photo ───────────────────────────────
  const free = await json<{ slots: { start: string; date: string }[] }>(
    await request.get(`/v1/public/locations/${location.slug}/availability`, {
      params: {
        serviceId: service.id,
        staffId: staff.id,
        from: new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10),
        to: new Date(Date.now() + 4 * 86_400_000).toISOString().slice(0, 10),
      },
    }),
  );
  const slot = free.slots[0]!;
  const hold = await json<{ holdId: string; holdToken: string }>(
    await request.post(`/v1/public/locations/${location.slug}/holds`, {
      data: { serviceId: service.id, staffId: staff.id, start: slot.start },
    }),
  );
  await json(
    await request.post(`/v1/public/holds/${hold.holdId}/photos`, {
      headers: { 'X-Hold-Token': hold.holdToken, 'Content-Type': 'image/jpeg' },
      data: await drawnPhoto(cabinet),
    }),
  );
  await json(
    await request.post(`/v1/public/holds/${hold.holdId}/code`, {
      data: {
        holdToken: hold.holdToken,
        name: 'Piotr Zieliński',
        phone: '+48600300400',
        email: CLIENT,
        locale: 'pl',
        acceptTerms: true,
      },
    }),
  );
  const mail = await waitForEmail(CLIENT, /Kod potwierdzenia/);
  const booked = await json<{ appointment: { id: string } }>(
    await request.post(`/v1/public/holds/${hold.holdId}/confirm`, {
      data: { holdToken: hold.holdToken, code: /\b(\d{6})\b/.exec(mail.text)![1] },
    }),
  );

  // ── The visit card: the photo from the client ──────────────────────────
  await cabinet.goto(`/pl/app/calendar?date=${slot.date}`);
  await cabinet.getByRole('button', { name: /Piotr Zieliński/ }).click();
  const photos = cabinet.getByRole('region', { name: 'Zdjęcia od klienta' });
  await expect(photos).toBeVisible();
  const img = photos.getByRole('img', { name: 'Zdjęcie od klienta 1' });
  await expect(img).toBeVisible();
  expect(
    await img.evaluate(async (el) => {
      const image = el as HTMLImageElement;
      await image.decode();
      return image.naturalWidth;
    }),
  ).toBe(320);
  await expect(photos).toContainText('Zdjęcia zostaną usunięte');
  await shot(cabinet, '21q-owner-visit-wish-photos');
  const list = await json<{ items: unknown[] }>(
    await request.get(`${base}/appointments/${booked.appointment.id}/photos`, { headers: owner }),
  );
  expect(list.items).toHaveLength(1);
  await desk.close();
});
