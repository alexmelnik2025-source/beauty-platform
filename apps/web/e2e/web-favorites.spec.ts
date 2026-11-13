import {
  expect,
  test,
  type APIRequestContext,
  type APIResponse,
  type Page,
} from '@playwright/test';
import { freshAddress } from './addresses';
import { listTo, waitForEmail } from './mailpit';

/**
 * Task 404: "Ulubione" in "Moje wizyty" on the site (screenshot 404); task 405: "♡ Dodaj do
 * ulubionych" on a salon page for a client signed in on this device (screenshot 405); task 406:
 * "Poleć salon znajomym" on a salon page (screenshot 406); task 409: "Pokaż kod QR" there (409).
 */

const PASSWORD = 'e2e-password-123';
const run = Date.now().toString(36);
const PHONE = { width: 390, height: 844 };
const SALON = `Ulubiony salon ${run}`;
const CLIENT = `web-fav-${run}@example.com`;

const shot = (page: Page, name: string) => page.screenshot({ path: `e2e/screenshots/${name}.png` });

async function json<T>(res: APIResponse): Promise<T> {
  expect(res.ok(), `${res.url()} → ${res.status()} ${await res.text()}`).toBeTruthy();
  return (res.status() === 204 ? undefined : await res.json()) as T;
}

async function owner(api: APIRequestContext): Promise<Record<string, string>> {
  const email = `web-fav-owner-${run}@example.com`;
  await json(
    await api.post('/v1/auth/register', {
      headers: freshAddress(),
      data: { email, password: PASSWORD, name: 'Aleksander Owner' },
    }),
  );
  const mail = await waitForEmail(email, /Potwierdź adres/);
  const token = /token=([^\s&]+)/.exec(mail.text)?.[1];
  await json(
    await api.post('/v1/auth/verify-email', { data: { token: decodeURIComponent(token!) } }),
  );
  const login = await json<{ accessToken: string }>(
    // Logins too are limited per address (30 in 15 minutes): one of its own.
    await api.post('/v1/auth/login', {
      headers: freshAddress(),
      data: { email, password: PASSWORD, clientType: 'mobile' },
    }),
  );
  return { Authorization: `Bearer ${login.accessToken}` };
}

async function salon(
  api: APIRequestContext,
  auth: Record<string, string>,
  name: string,
  place: { latitude: number; longitude: number },
  team: { name: string; languages: string[]; specialties: string[] }[],
): Promise<string> {
  const org = await json<{ id: string }>(
    await api.post('/v1/organizations', { headers: auth, data: { name } }),
  );
  const location = await json<{ id: string; slug: string }>(
    await api.post(`/v1/organizations/${org.id}/locations`, {
      headers: auth,
      data: {
        name,
        addressLine: 'ul. Długa 1',
        city: 'Gdynia',
        postalCode: '80-001',
        ...place,
        onlineBookingEnabled: true,
        bookingTerms: '# Regulamin\n\nWizyta jest bezpłatna do odwołania.',
        privacyPolicy: `# Prywatność\n\nAdministratorem danych jest ${name}.`,
      },
    }),
  );
  const base = `/v1/organizations/${org.id}/locations/${location.id}`;
  const service = await json<{ id: string }>(
    await api.post(`${base}/services`, {
      headers: auth,
      data: { name: 'Usługa', durationMinutes: 30, priceGrosze: 5000 },
    }),
  );
  for (const member of team) {
    await json(
      await api.post(`${base}/staff`, {
        headers: auth,
        data: {
          displayName: member.name,
          languages: member.languages,
          specialties: member.specialties,
          serviceIds: [service.id],
        },
      }),
    );
  }
  return location.slug;
}

test('a signed-in client saves a salon on its page and finds it in "Ulubione"', async ({
  browser,
  request,
}) => {
  const auth = await owner(request);
  const slug = await salon(request, auth, SALON, { latitude: 54.36, longitude: 18.64 }, [
    { name: 'Kasia', languages: ['pl'], specialties: ['barber'] },
  ]);

  const site = await browser.newContext({
    viewport: PHONE,
    isMobile: true,
    locale: 'pl-PL',
    timezoneId: 'Europe/Warsaw',
    extraHTTPHeaders: freshAddress(),
  });
  try {
    const page = await site.newPage();
    // Not signed in: no heart on the salon page.
    await page.goto(`/pl/b/${slug}`);
    await expect(page.getByRole('heading', { level: 1, name: SALON })).toBeVisible();
    await expect(page.getByRole('button', { name: '♡ Dodaj do ulubionych' })).toHaveCount(0);

    // Task 406: "Poleć salon znajomym" — the share sheet gets the salon's name and link (the
    // test stands in for the phone's sheet); without a share sheet the link is copied.
    await page.evaluate(() => {
      const w = window as unknown as { shared?: ShareData };
      Object.defineProperty(navigator, 'share', {
        configurable: true,
        value: async (data: ShareData) => {
          w.shared = data;
        },
      });
    });
    await page.getByRole('button', { name: 'Poleć salon znajomym' }).click();
    const shared = await page.evaluate(() => (window as unknown as { shared?: ShareData }).shared);
    expect(shared?.url).toMatch(new RegExp(`/pl/b/${slug}$`));
    expect(shared?.text).toBe(`${SALON} — umów się online: ${shared?.url}`);
    await page.evaluate(() => {
      Object.defineProperty(navigator, 'share', { configurable: true, value: undefined });
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: async () => undefined },
      });
    });
    await page.getByRole('button', { name: 'Poleć salon znajomym' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Link skopiowany' })).toBeVisible();
    await shot(page, '406-salon-page-share');
    // Task 409: the page's QR code for a friend next to you.
    await page.getByRole('button', { name: 'Pokaż kod QR' }).click();
    const qr = page.getByRole('img', { name: 'Kod QR salonu' });
    await expect(qr).toBeVisible();
    await expect(qr.locator('path')).toHaveCount(1);
    await qr.scrollIntoViewIfNeeded();
    await shot(page, '409-salon-page-qr');
    await page.getByRole('button', { name: 'Ukryj kod QR' }).click();
    await expect(qr).toHaveCount(0);

    await page.goto('/pl/c');
    const loginCode = /Kod logowania do Twoich wizyt/;
    const before = (await listTo(CLIENT)).filter((m) => loginCode.test(m.Subject)).length;
    await page.getByLabel('E-mail').fill(CLIENT);
    await page.getByRole('button', { name: 'Wyślij kod' }).click();
    await expect
      .poll(async () => (await listTo(CLIENT)).filter((m) => loginCode.test(m.Subject)).length)
      .toBeGreaterThan(before);
    const mail = await waitForEmail(CLIENT, loginCode);
    await page.getByLabel('Kod z e-maila').fill(/\b(\d{6})\b/.exec(mail.text)![1]!);
    await page.getByRole('button', { name: 'Zaloguj się' }).click();
    await page.getByRole('button', { name: 'Ulubione', exact: true }).click();
    await expect(
      page.getByText('Nie masz jeszcze ulubionych salonów.', { exact: false }),
    ).toBeVisible();

    // Task 405: the heart on the salon page.
    await page.goto(`/pl/b/${slug}`);
    await page.getByRole('button', { name: '♡ Dodaj do ulubionych' }).click();
    const saved = page.getByRole('button', { name: 'Usuń z ulubionych' });
    await expect(saved).toHaveText('♥ W ulubionych');
    await shot(page, '405-salon-page-favorite');
    // It stays saved after a reload.
    await page.reload();
    await expect(page.getByRole('button', { name: 'Usuń z ulubionych' })).toHaveText(
      '♥ W ulubionych',
    );

    // Task 416: the favourite salons on the home page.
    await page.goto('/pl');
    const homeFavorites = page.getByRole('region', { name: 'Ulubione' });
    await expect(homeFavorites.getByRole('link', { name: `♥ ${SALON}` })).toBeVisible();
    await homeFavorites.scrollIntoViewIfNeeded();
    await shot(page, '416-home-favorites');

    // Task 404: "Ulubione" in "Moje wizyty" (task 416: ?tab=favorites opens it).
    await page.goto('/pl/c?tab=favorites');
    await expect(page.getByRole('button', { name: 'Ulubione', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    const card = page.getByRole('article', { name: SALON });
    await expect(card.getByRole('link', { name: 'Umów wizytę' })).toBeVisible();
    await shot(page, '404-site-favorites');
    await card.getByRole('button', { name: `Usuń z ulubionych: ${SALON}` }).click();
    await expect(page.getByRole('article', { name: SALON })).toHaveCount(0);
    await expect(
      page.getByText('Nie masz jeszcze ulubionych salonów.', { exact: false }),
    ).toBeVisible();
  } finally {
    await site.close();
  }
});
