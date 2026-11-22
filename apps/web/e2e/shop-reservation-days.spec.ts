import { expect, test, type APIRequestContext, type APIResponse } from '@playwright/test';
import { freshAddress } from './addresses';
import { waitForEmail } from './mailpit';

/**
 * Task Q3: "Jak długo czekają odłożone produkty" at the bottom of "Mój sklep" — the owner sees
 * 14 days, a wrong number is refused with a plain message, 7 is saved and stays after a reload
 * (and is what the API answers). Screenshot Q3-reservation-days.
 */

const PASSWORD = 'e2e-password-123';
const run = Date.now().toString(36);
const NAME = `Rezerwacje ${run}`;
const OWNER = `shop-days-${run}@example.com`;

async function json<T>(res: APIResponse): Promise<T> {
  expect(res.ok(), `${res.url()} → ${res.status()} ${await res.text()}`).toBeTruthy();
  return (res.status() === 204 ? undefined : await res.json()) as T;
}

async function ownerOf(api: APIRequestContext, email: string, salonName: string) {
  await json(
    await api.post('/v1/auth/register', {
      headers: freshAddress(),
      data: { email, password: PASSWORD, name: 'Właściciel' },
    }),
  );
  const mail = await waitForEmail(email, /Potwierdź adres/);
  const token = /token=([^\s&]+)/.exec(mail.text)?.[1];
  await json(
    await api.post('/v1/auth/verify-email', { data: { token: decodeURIComponent(token!) } }),
  );
  const login = await json<{ accessToken: string }>(
    await api.post('/v1/auth/login', {
      headers: freshAddress(),
      data: { email, password: PASSWORD, clientType: 'mobile' },
    }),
  );
  const auth = { Authorization: `Bearer ${login.accessToken}` };
  const org = await json<{ id: string }>(
    await api.post('/v1/organizations', { headers: auth, data: { name: salonName } }),
  );
  const location = await json<{ id: string; slug: string }>(
    await api.post(`/v1/organizations/${org.id}/locations`, {
      headers: auth,
      data: {
        name: salonName,
        addressLine: 'ul. Józefa Bema 91',
        city: 'Warszawa',
        postalCode: '01-233',
        onlineBookingEnabled: true,
        bookingTerms: '# Regulamin\n\nWizyta jest bezpłatna do odwołania.',
        privacyPolicy: `# Prywatność\n\nAdministratorem danych jest ${salonName}.`,
      },
    }),
  );
  return {
    auth,
    base: `/v1/organizations/${org.id}/locations/${location.id}`,
    slug: location.slug,
  };
}

test('"Mój sklep": how long a product put aside waits after the visit (task Q3)', async ({
  browser,
  request,
}) => {
  const salon = await ownerOf(request, OWNER, NAME);

  const desk = await browser.newContext({ locale: 'pl-PL', extraHTTPHeaders: freshAddress() });
  const page = await desk.newPage();
  await page.goto('/pl/login');
  await page.getByLabel('E-mail').fill(OWNER);
  await page.getByLabel('Hasło').fill(PASSWORD);
  await page.getByRole('button', { name: 'Zaloguj się' }).click();
  await expect(page).toHaveURL(/\/pl\/app/);

  await page.goto('/pl/app/shop');
  const box = page.getByTestId('shop-reservation-days');
  await expect(
    box.getByRole('heading', { name: 'Jak długo czekają odłożone produkty' }),
  ).toBeVisible();
  const field = box.getByLabel('Dni po wizycie (1–90)');
  await expect(field).toHaveValue('14');

  await field.fill('0');
  await box.getByRole('button', { name: 'Zapisz' }).click();
  // Task 683: the wrong number is said under the field (red frame, the cursor there).
  await expect(box.locator('.field-error')).toHaveText('Podaj liczbę dni od 1 do 90.');
  await expect(field).toHaveAttribute('aria-invalid', 'true');
  await expect(field).toBeFocused();
  await page.screenshot({ path: 'e2e/screenshots/683-reservation-days-error.png' });

  await field.fill('7');
  await expect(box.locator('.field-error')).toHaveCount(0);
  await box.getByRole('button', { name: 'Zapisz' }).click();
  await expect(box.getByRole('status')).toHaveText('Zapisano');
  await box.scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'e2e/screenshots/Q3-reservation-days.png', fullPage: true });

  const loc = await json<{ shopReservationDays: number }>(
    await request.get(salon.base, { headers: salon.auth }),
  );
  expect(loc.shopReservationDays).toBe(7);
  await page.reload();
  await expect(
    page.getByTestId('shop-reservation-days').getByLabel('Dni po wizycie (1–90)'),
  ).toHaveValue('7');
  await desk.close();
});
