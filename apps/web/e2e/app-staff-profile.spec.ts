import {
  expect,
  test,
  type APIRequestContext,
  type APIResponse,
  type Page,
} from '@playwright/test';
import { waitForEmail } from './mailpit';
import { serveApp } from './mobile-app';

/**
 * Tasks 326–329: specialists in "Grafik zespołu" of the business app (web preview of
 * apps/mobile-business). The owner puts Kasia first (329), changes her profile — name,
 * description, specialties, services (326–327) — switches her off (she stays on the list, marked)
 * and adds a new specialist without an account (328). Screenshots 326–329. Task 339: her photo
 * from the gallery (the file chooser in the web preview), then removed. Screenshot 339.
 */

const PASSWORD = 'e2e-password-123';
const run = Date.now().toString(36);
const OWNER = `app-staff-owner-${run}@example.com`;
const PHONE = { width: 390, height: 844 };
// An address of this test only (sign-ups and codes are limited per address).
const OWNER_IP = { 'x-forwarded-for': '198.51.100.98' };

/** A small square photo drawn in the browser (task 339). */
async function drawnPhoto(page: Page, text: string): Promise<Buffer> {
  const base64 = await page.evaluate((label) => {
    const canvas = document.createElement('canvas');
    canvas.width = 300;
    canvas.height = 300;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#1d1d1b';
    ctx.fillRect(0, 0, 300, 300);
    ctx.fillStyle = '#c8a46a';
    ctx.font = '72px sans-serif';
    ctx.fillText(label, 80, 175);
    return canvas.toDataURL('image/jpeg', 0.9).split(',')[1]!;
  }, text);
  return Buffer.from(base64, 'base64');
}

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

type Staff = {
  id: string;
  displayName: string;
  bio: string | null;
  specialties: string[];
  customSpecialty: string | null;
  active: boolean;
  sortOrder: number;
  serviceIds: string[];
  photoUrl: string | null;
};

test('business app: the owner orders, edits, switches off and adds specialists', async ({
  browser,
  request,
}) => {
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
  const kasia = await json<Staff>(
    await request.post(`${base}/staff`, {
      headers: owner,
      data: { displayName: 'Kasia', specialties: ['barber'] },
    }),
  );
  const ilian = await json<Staff>(
    await request.post(`${base}/staff`, { headers: owner, data: { displayName: 'Ilian' } }),
  );
  const haircut = await json<{ id: string }>(
    await request.post(`${base}/services`, {
      headers: owner,
      data: {
        name: 'Strzyżenie',
        durationMinutes: 45,
        priceGrosze: 12000,
        staffIds: [kasia.id, ilian.id],
      },
    }),
  );
  const beard = await json<{ id: string }>(
    await request.post(`${base}/services`, {
      headers: owner,
      data: { name: 'Broda', durationMinutes: 30, priceGrosze: 8000, staffIds: [kasia.id] },
    }),
  );

  const businessApp = await serveApp('mobile-business');
  try {
    const context = await browser.newContext({
      viewport: PHONE,
      locale: 'pl-PL',
      timezoneId: 'Europe/Warsaw',
      isMobile: true,
      extraHTTPHeaders: OWNER_IP,
    });
    const phone = await context.newPage();
    await phone.goto(businessApp.url);
    await phone.getByLabel('E-mail lub telefon').fill(OWNER);
    await phone.getByRole('button', { name: 'Wyślij kod' }).click();
    const code = await waitForEmail(OWNER, /Kod logowania do aplikacji salonu/);
    await phone.getByLabel('Kod', { exact: true }).fill(/\b(\d{6})\b/.exec(code.text)![1]!);
    await phone.getByRole('button', { name: 'Zaloguj się' }).click();
    await expect(phone.getByRole('button', { name: 'Dziś' })).toBeVisible();

    // ── 329: Kasia first ───────────────────────────────────────────────────
    await phone.getByRole('button', { name: 'Grafik zespołu' }).click();
    await expect(phone.getByRole('heading', { name: 'Grafik zespołu' })).toBeVisible();
    await expect(phone.getByRole('button', { name: 'Wyżej: Ilian' })).toBeDisabled();
    await phone.getByRole('button', { name: 'Niżej: Ilian' }).click();
    await expect(phone.getByText('Kolejność zapisana.')).toBeVisible();
    await expect(phone.getByRole('button', { name: 'Wyżej: Kasia' })).toBeDisabled();
    await shot(phone, '329-business-app-staff-order');

    // ── 326–327: Kasia's profile ───────────────────────────────────────────
    await phone.getByRole('button', { name: 'Kasia', exact: true }).click();
    await expect(phone.getByRole('heading', { name: 'Grafik: Kasia' })).toBeVisible();
    await expect(phone.getByText('Usługi: 2 z 2')).toBeVisible();
    await phone.getByRole('button', { name: 'Zmień profil' }).click();
    await expect(phone.getByLabel('Imię dla klientów')).toHaveValue('Kasia');
    await phone.getByLabel('Imię dla klientów').fill('Kasia Nowak');
    await phone.getByLabel('Opis', { exact: true }).fill('Fade i broda, 8 lat w zawodzie.');
    await phone.getByRole('button', { name: 'Fryzjer', exact: true }).click();
    await phone.getByLabel('Inna specjalizacja').fill('Trycholog');
    await phone.getByRole('checkbox', { name: 'Broda' }).click();
    await shot(phone, '326-business-app-staff-profile');
    await phone.getByRole('button', { name: 'Zapisz profil' }).click();
    await expect(phone.getByText('Profil zapisany.')).toBeVisible();
    await expect(phone.getByRole('heading', { name: 'Grafik: Kasia Nowak' })).toBeVisible();
    await expect(phone.getByText('Barber, Fryzjer, Trycholog')).toBeVisible();
    await expect(phone.getByText('Usługi: 1 z 2')).toBeVisible();
    await shot(phone, '327-business-app-staff-profile-saved');

    // ── 339: Kasia's photo from the gallery, then removed ─────────────────
    const chooser = phone.waitForEvent('filechooser', { timeout: 15_000 });
    await phone.getByRole('button', { name: '+ Dodaj zdjęcie' }).click();
    await (
      await chooser
    ).setFiles({
      name: 'kasia.jpg',
      mimeType: 'image/jpeg',
      buffer: await drawnPhoto(phone, 'KN'),
    });
    await expect(phone.getByText('Zdjęcie zapisane', { exact: false })).toBeVisible();
    await expect(phone.getByLabel('Zdjęcie: Kasia Nowak')).toBeVisible();
    await expect(phone.getByRole('button', { name: 'Zmień zdjęcie' })).toBeVisible();
    await shot(phone, '339-business-app-staff-photo');
    const withPhoto = await json<Staff[]>(await request.get(`${base}/staff`, { headers: owner }));
    expect(withPhoto.find((x) => x.id === kasia.id)?.photoUrl).toBeTruthy();
    await phone.getByRole('button', { name: 'Usuń zdjęcie' }).click();
    await expect(phone.getByText('Usunąć zdjęcie? Klienci zobaczą inicjały.')).toBeVisible();
    await phone.getByRole('button', { name: 'Tak, usuń' }).click();
    await expect(phone.getByText('Zdjęcie usunięte.')).toBeVisible();
    await expect(phone.getByRole('button', { name: '+ Dodaj zdjęcie' })).toBeVisible();

    // ── 326: Kasia does not take clients for now — she stays on the list ──
    await phone.getByRole('button', { name: 'Zmień profil' }).click();
    await phone.getByLabel('Przyjmuje klientów').click();
    await phone.getByRole('button', { name: 'Zapisz profil' }).click();
    // The form shows the same hint before saving — wait until the server has saved it, or the
    // team list read on "Wróć" may still be the old one (flaky on main, 12.11.2026).
    await expect(phone.getByText('Profil zapisany.')).toBeVisible();
    await expect(
      phone.getByText('Wyłączony — klienci go nie widzą', { exact: false }),
    ).toBeVisible();
    await phone.getByRole('button', { name: '‹ Wróć' }).click();
    await expect(phone.getByRole('heading', { name: 'Grafik zespołu' })).toBeVisible();
    await expect(phone.getByRole('button', { name: 'Kasia Nowak', exact: true })).toBeVisible();
    await expect(phone.getByText('nie przyjmuje')).toBeVisible();
    await shot(phone, '326a-business-app-staff-inactive');

    // ── 328: a new specialist without an account ───────────────────────────
    await phone.getByRole('button', { name: '+ Dodaj specjalistę' }).click();
    await phone.getByLabel('Imię nowego specjalisty').fill('Marek');
    await phone.getByRole('button', { name: 'Dodaj', exact: true }).click();
    await expect(phone.getByRole('heading', { name: 'Grafik: Marek' })).toBeVisible();
    await expect(phone.getByText('Specjalista dodany.', { exact: false })).toBeVisible();
    await expect(phone.getByText('Usługi: 2 z 2')).toBeVisible();
    await shot(phone, '328-business-app-new-specialist');
    await context.close();
  } finally {
    businessApp.server.close();
  }

  const staff = await json<Staff[]>(await request.get(`${base}/staff`, { headers: owner }));
  const byName = Object.fromEntries(staff.map((s) => [s.displayName, s]));
  expect(byName['Kasia Nowak']).toMatchObject({
    id: kasia.id,
    bio: 'Fade i broda, 8 lat w zawodzie.',
    specialties: ['barber', 'hairdresser'],
    customSpecialty: 'Trycholog',
    active: false,
    sortOrder: 0,
    serviceIds: [haircut.id],
    photoUrl: null,
  });
  expect(byName['Ilian']).toMatchObject({ sortOrder: 10, active: true });
  expect(byName['Marek']).toMatchObject({ sortOrder: 20, active: true });
  expect([...byName['Marek']!.serviceIds].sort()).toEqual([haircut.id, beard.id].sort());
});
