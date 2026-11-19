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
 * Task Q2 (part 6): a QR code for each specialist. In the cabinet's "Instagram i Twoja strona"
 * the owner picks a specialist and gets their code (PNG, SVG, print — only that card). The code
 * carries `?utm_source=qr&staff=…`: the booking page says whose code it was and, after the
 * service, opens that specialist's times at once. Screenshots Q2-staff-qr, Q2-staff-qr-page,
 * Q2-staff-qr-time.
 */

const PASSWORD = 'e2e-password-123';
const run = Date.now().toString(36);
const PHONE = { width: 390, height: 844 };
const NAME = `Kod Specjalisty ${run}`;
const OWNER = `staff-qr-${run}@example.com`;

const shot = (page: Page, name: string) => page.screenshot({ path: `e2e/screenshots/${name}.png` });

async function json<T>(res: APIResponse): Promise<T> {
  expect(res.ok(), `${res.url()} → ${res.status()} ${await res.text()}`).toBeTruthy();
  return (res.status() === 204 ? undefined : await res.json()) as T;
}

async function salonWithTwoSpecialists(api: APIRequestContext) {
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
  const haircut = await json<{ id: string }>(
    await api.post(`${base}/services`, {
      headers: owner,
      data: { name: 'Strzyżenie męskie', durationMinutes: 45, priceGrosze: 9000 },
    }),
  );
  const beard = await json<{ id: string }>(
    await api.post(`${base}/services`, {
      headers: owner,
      data: { name: 'Broda', durationMinutes: 30, priceGrosze: 6000 },
    }),
  );
  await json(
    await api.post(`${base}/staff`, {
      headers: owner,
      data: { displayName: 'Kasia', serviceIds: [haircut.id] },
    }),
  );
  const marek = await json<{ id: string }>(
    await api.post(`${base}/staff`, {
      headers: owner,
      data: { displayName: 'Marek Łódzki', serviceIds: [haircut.id, beard.id] },
    }),
  );
  return { slug: location.slug, marekId: marek.id };
}

async function signIn(page: Page) {
  await page.goto('/pl/login');
  await page.getByLabel('E-mail').fill(OWNER);
  await page.getByLabel('Hasło').fill(PASSWORD);
  await page.getByRole('button', { name: 'Zaloguj się' }).click();
  await page.waitForURL(/\/pl\/app\/calendar/);
}

test('each specialist gets a QR code and the code opens their booking (task Q2)', async ({
  browser,
  page,
  request,
}) => {
  const { slug, marekId } = await salonWithTwoSpecialists(request);
  const staffLink = `/s/${slug}?utm_source=qr&staff=${marekId}`;

  // The cabinet: nothing until a specialist is picked, then their card.
  await signIn(page);
  await page.goto('/pl/app/settings');
  const pick = page.getByLabel('Specjalista', { exact: true });
  await expect(pick).toBeVisible();
  await expect(page.getByRole('img', { name: /Kod QR rezerwacji u/ })).toHaveCount(0);
  // The salon's own code is still the only one — the old buttons stay unambiguous.
  await expect(page.getByRole('button', { name: 'Drukuj' })).toHaveCount(1);
  await pick.selectOption({ label: 'Marek Łódzki' });
  const staffQr = page.getByRole('img', { name: 'Kod QR rezerwacji u Marek Łódzki' });
  await expect(staffQr).toBeVisible();
  await expect(staffQr.locator('svg title')).toHaveText(
    new RegExp(`${staffLink.replace(/[?&]/g, '\\$&')}$`),
  );
  const card = page.locator('.qr-print').filter({ has: staffQr });
  await expect(card.getByText('Marek Łódzki')).toBeVisible();
  await expect(card.getByText(NAME)).toBeVisible();
  await expect(card.getByText('Zeskanuj i umów wizytę')).toBeVisible();
  await card.scrollIntoViewIfNeeded();
  await shot(page, 'Q2-staff-qr');

  // PNG with the specialist's name in the file name.
  const actions = card.locator('xpath=..').locator('.salon-qr__actions');
  const [png] = await Promise.all([
    page.waitForEvent('download'),
    actions.getByRole('button', { name: 'Pobierz PNG' }).click(),
  ]);
  expect(png.suggestedFilename()).toBe(`qr-${slug}-marek-lodzki.png`);
  const [svgFile] = await Promise.all([
    page.waitForEvent('download'),
    actions.getByRole('button', { name: 'Pobierz SVG' }).click(),
  ]);
  expect(svgFile.suggestedFilename()).toBe(`qr-${slug}-marek-lodzki.svg`);

  // "Drukuj" of the specialist's card prints that card only — not the salon's.
  await page.evaluate(() => {
    const w = window as unknown as { printed: number };
    w.printed = 0;
    window.print = () => {
      w.printed++;
    };
  });
  await actions.getByRole('button', { name: 'Drukuj' }).click();
  expect(await page.evaluate(() => (window as unknown as { printed: number }).printed)).toBe(1);
  await expect(card).toHaveClass(/qr-print--printing/);
  await expect(page.locator('.qr-print').first()).not.toHaveClass(/qr-print--printing/);
  await page.emulateMedia({ media: 'print' });
  await expect(staffQr).toBeVisible();
  await expect(page.getByRole('img', { name: 'Kod QR rezerwacji', exact: true })).toBeHidden();
  await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
  await page.emulateMedia({ media: 'screen' });
  await expect(card).not.toHaveClass(/qr-print--printing/);
  await expect(page.locator('html')).not.toHaveClass(/print-qr/);

  // A client scans the code: the salon's page says whose code it was…
  const phone = await browser.newContext({ viewport: PHONE, isMobile: true, locale: 'pl-PL' });
  try {
    const client = await phone.newPage();
    await client.goto(staffLink);
    await client.waitForURL(new RegExp(`/pl/b/${slug}\\?utm_source=qr&staff=${marekId}`));
    await expect(client.getByRole('heading', { name: NAME })).toBeVisible();
    const note = client.getByTestId('qr-staff');
    await expect(note).toHaveText(/Rezerwujesz u: Marek Łódzki/);
    // Both services are there: the client still chooses what, only "who" is settled.
    await expect(client.getByRole('button', { name: /Strzyżenie męskie/ })).toBeVisible();
    await expect(client.getByRole('button', { name: /Broda/ })).toBeVisible();
    await shot(client, 'Q2-staff-qr-page');

    // …and after the service his times open at once — no "who" step.
    await client.getByRole('button', { name: /Broda/ }).click();
    await expect(client.locator('.progress [aria-current="step"]')).toHaveText('Termin');
    await expect(client.getByText('Marek Łódzki — wolne terminy')).toBeVisible();
    await expect(client.getByRole('button', { name: /Kasia/ })).toHaveCount(0);
    await shot(client, 'Q2-staff-qr-time');

    // "Back" still lets the client pick someone else.
    await client.getByRole('button', { name: 'Wstecz' }).click();
    await expect(client.locator('.progress [aria-current="step"]')).toHaveText('Specjalista');
    await expect(client.getByRole('button', { name: /Marek Łódzki/ })).toBeVisible();

    // "Inny specjalista" on the first step forgets the code's specialist.
    await client.goto(staffLink);
    await client.getByTestId('qr-staff').getByRole('button', { name: 'Inny specjalista' }).click();
    await expect(client.getByTestId('qr-staff')).toHaveCount(0);
    await client.getByRole('button', { name: /Strzyżenie męskie/ }).click();
    await expect(client.locator('.progress [aria-current="step"]')).toHaveText('Specjalista');
    await expect(client.getByRole('button', { name: /Kasia/ })).toBeVisible();
  } finally {
    await phone.close();
  }
});
