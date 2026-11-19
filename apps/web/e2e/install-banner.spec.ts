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
 * Task Q2 (part 4): "Zainstaluj aplikację" — one small row above a salon's booking page.
 * Chrome on a phone: the row, "Zainstaluj" (the browser's own hints here), × hides it for a month;
 * where the client was is kept, and "Moje wizyty" offers "Dokończ rezerwację" that returns to
 * the same salon and service. iPhone: the Safari steps instead. Screenshots Q2-banner,
 * Q2-banner-ios, Q2-resume, Q2-resume-back.
 */

const PASSWORD = 'e2e-password-123';
const run = Date.now().toString(36);
const PHONE = { width: 390, height: 844 };
const NAME = `Baner Instalacji ${run}`;
const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

const shot = (page: Page, name: string) => page.screenshot({ path: `e2e/screenshots/${name}.png` });

async function json<T>(res: APIResponse): Promise<T> {
  expect(res.ok(), `${res.url()} → ${res.status()} ${await res.text()}`).toBeTruthy();
  return (res.status() === 204 ? undefined : await res.json()) as T;
}

async function onlineSalon(
  api: APIRequestContext,
  part: string,
): Promise<{ slug: string; serviceId: string }> {
  const OWNER = `install-banner-${part}-${run}@example.com`;
  await json(
    await api.post('/v1/auth/register', {
      headers: freshAddress(),
      data: { email: OWNER, password: PASSWORD, name: 'Aleksander Owner' },
    }),
  );
  const mail = await waitForEmail(OWNER, /Potwierdź adres/);
  const token = /token=([^\s&]+)/.exec(mail.text)?.[1];
  await json(
    await api.post('/v1/auth/verify-email', { data: { token: decodeURIComponent(token!) } }),
  );
  const login = await json<{ accessToken: string }>(
    await api.post('/v1/auth/login', {
      headers: freshAddress(),
      data: { email: OWNER, password: PASSWORD, clientType: 'mobile' },
    }),
  );
  const owner = { Authorization: `Bearer ${login.accessToken}` };
  const org = await json<{ id: string }>(
    await api.post('/v1/organizations', { headers: owner, data: { name: NAME } }),
  );
  const location = await json<{ id: string; slug: string }>(
    await api.post(`/v1/organizations/${org.id}/locations`, {
      headers: owner,
      data: {
        name: NAME,
        addressLine: 'ul. Józefa Bema 91',
        city: 'Warszawa',
        postalCode: '01-233',
        onlineBookingEnabled: true,
        bookingTerms: '# Regulamin\n\nWizyta jest bezpłatna do odwołania.',
        privacyPolicy: `# Prywatność\n\nAdministratorem danych jest ${NAME}.`,
      },
    }),
  );
  const base = `/v1/organizations/${org.id}/locations/${location.id}`;
  const service = await json<{ id: string }>(
    await api.post(`${base}/services`, {
      headers: owner,
      data: { name: 'Strzyżenie męskie', durationMinutes: 45, priceGrosze: 9000 },
    }),
  );
  await json(
    await api.post(`${base}/staff`, {
      headers: owner,
      data: { displayName: 'Kasia', serviceIds: [service.id] },
    }),
  );
  return { slug: location.slug, serviceId: service.id };
}

test('the booking page offers the app in one row and continues the booking in it (task Q2)', async ({
  browser,
  request,
}) => {
  const { slug, serviceId } = await onlineSalon(request, 'chrome');
  const phone = await browser.newContext({ viewport: PHONE, isMobile: true, locale: 'pl-PL' });
  try {
    const page = await phone.newPage();
    await page.goto(`/pl/b/${slug}`);
    await expect(page.getByRole('heading', { name: NAME })).toBeVisible();

    // The row above the salon, and the "My visits" manifest so the browser can install it here.
    const banner = page.getByTestId('install-banner');
    await expect(banner.getByText('Zainstaluj aplikację', { exact: true })).toBeVisible();
    await expect(page.locator('link[rel="manifest"]')).toHaveAttribute(
      'href',
      '/manifests/visits-pl.webmanifest',
    );
    // Nothing from the stores yet: no Safari banner, no store links.
    await expect(page.locator('meta[name="apple-itunes-app"]')).toHaveCount(0);
    await shot(page, 'Q2-banner');

    // The booking goes on under the row: the service is chosen, the row stays small.
    await page.getByRole('button', { name: /Strzyżenie męskie/ }).click();
    await expect(page.getByRole('button', { name: /Kasia/ })).toBeVisible();
    await expect(banner).toBeVisible();

    // "Zainstaluj": this browser has no install dialog of its own, so the hints open; where the
    // client is (salon + service) is kept for the app.
    await banner.getByRole('button', { name: 'Zainstaluj' }).click();
    await expect(page.getByTestId('install-banner-help')).toBeVisible();
    const kept = await page.evaluate(() => window.localStorage.getItem('bp_resume_booking'));
    expect(JSON.parse(kept ?? '{}')).toMatchObject({ slug, salonName: NAME, serviceId });

    // "My visits" (where the installed app opens) continues exactly there.
    await page.goto('/pl/c');
    const resume = page.getByTestId('resume-booking');
    await expect(resume.getByText('Dokończ rezerwację')).toBeVisible();
    await expect(resume.getByText(NAME)).toBeVisible();
    await shot(page, 'Q2-resume');
    await resume.getByRole('link', { name: 'Wróć do rezerwacji' }).click();
    await page.waitForURL(new RegExp(`/pl/b/${slug}\\?service=${serviceId}`));
    // Straight at "who": the service is already chosen.
    await expect(page.getByRole('button', { name: /Kasia/ })).toBeVisible();
    await expect(page.locator('.progress [aria-current="step"]')).toHaveText('Specjalista');
    await shot(page, 'Q2-resume-back');
    // Used once: "My visits" no longer offers it.
    await page.goto('/pl/c');
    await expect(page.getByTestId('resume-booking')).toHaveCount(0);

    // × hides the row for a month — also after a reload.
    await page.goto(`/pl/b/${slug}`);
    await expect(banner).toBeVisible();
    await banner.getByRole('button', { name: 'Zamknij' }).click();
    await expect(banner).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole('heading', { name: NAME })).toBeVisible();
    await expect(page.getByTestId('install-banner')).toHaveCount(0);
    // The booking itself is untouched.
    await expect(page.getByRole('button', { name: /Strzyżenie męskie/ })).toBeVisible();
  } finally {
    await phone.close();
  }
});

test('on an iPhone the row shows the Safari steps (task Q2)', async ({ browser, request }) => {
  const { slug } = await onlineSalon(request, 'iphone');
  const iphone = await browser.newContext({
    viewport: PHONE,
    isMobile: true,
    locale: 'pl-PL',
    userAgent: IPHONE_UA,
  });
  try {
    const page = await iphone.newPage();
    await page.goto(`/pl/b/${slug}`);
    const banner = page.getByTestId('install-banner');
    await expect(banner.getByText('Zainstaluj aplikację', { exact: true })).toBeVisible();
    await banner.getByRole('button', { name: 'Zainstaluj' }).click();
    await expect(page.getByText('Otwórz tę stronę w Safari.')).toBeVisible();
    await expect(page.getByText(/Do ekranu początkowego/)).toBeVisible();
    await shot(page, 'Q2-banner-ios');
  } finally {
    await iphone.close();
  }
});

test('in a window on the salon’s own site there is no install row (task Q2)', async ({
  page,
  request,
}) => {
  const { slug } = await onlineSalon(request, 'embed');
  await page.goto(`/pl/b/${slug}?embed=1`);
  await expect(page.getByRole('heading', { name: NAME })).toBeVisible();
  await expect(page.getByTestId('install-banner')).toHaveCount(0);
});
