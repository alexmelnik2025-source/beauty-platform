import { expect, test, type APIResponse } from '@playwright/test';
import { freshAddress } from './addresses';
import { waitForEmail } from './mailpit';

/**
 * Task 661 (owner's rule: errors at the field): the "Dodaj usługę" card in the cabinet. A name
 * of only spaces is said under "Nazwa" and a price above 100 000 under "Cena" before anything is
 * sent — no line on top of the form. Editing a field takes its error away; a good card saves.
 */

const PASSWORD = 'e2e-password-123';
const OWNER = `service-errors-${Date.now().toString(36)}@example.com`;
/** The salon's own address: the API limits sign-ups and sign-ins per address. */
const OWNER_IP = freshAddress();

test.use({ viewport: { width: 390, height: 844 }, locale: 'pl-PL' });

async function json<T>(res: APIResponse): Promise<T> {
  expect(res.ok(), `${res.url()} → ${res.status()} ${await res.text()}`).toBeTruthy();
  return (res.status() === 204 ? undefined : await res.json()) as T;
}

test('the new-service card says a blank name and a too-high price at their fields', async ({
  page,
  request,
}) => {
  await json(
    await request.post('/v1/auth/register', {
      headers: OWNER_IP,
      data: { email: OWNER, password: PASSWORD, name: 'Aleksander Owner' },
    }),
  );
  const mail = await waitForEmail(OWNER, /Potwierdź adres/);
  const token = /token=([^\s&]+)/.exec(mail.text)?.[1];
  expect(token, 'verification link').toBeTruthy();
  await json(
    await request.post('/v1/auth/verify-email', {
      headers: OWNER_IP,
      data: { token: decodeURIComponent(token!) },
    }),
  );
  const login = await json<{ accessToken: string }>(
    await request.post('/v1/auth/login', {
      headers: OWNER_IP,
      data: { email: OWNER, password: PASSWORD, clientType: 'mobile' },
    }),
  );
  const owner = { Authorization: `Bearer ${login.accessToken}` };
  const org = await json<{ id: string }>(
    await request.post('/v1/organizations', { headers: owner, data: { name: 'GESTALT' } }),
  );
  await json(
    await request.post(`/v1/organizations/${org.id}/locations`, {
      headers: owner,
      data: {
        name: 'Bema',
        addressLine: 'ul. Józefa Bema 91',
        city: 'Warszawa',
        postalCode: '01-233',
      },
    }),
  );

  await page.setExtraHTTPHeaders(OWNER_IP);
  await page.goto('/pl/login');
  await page.getByLabel('E-mail').fill(OWNER);
  await page.getByLabel('Hasło').fill(PASSWORD);
  await page.getByRole('button', { name: 'Zaloguj się' }).click();
  await page.waitForURL(/\/pl\/app\//);
  await page.goto('/pl/app/services');

  await page.getByRole('button', { name: '+ Dodaj usługę' }).first().click();
  const card = page.getByRole('dialog');
  // The error under a field is part of its label's text: find the fields by how the label starts.
  const name = card.getByLabel(/^Nazwa(?! kategorii)/);
  const price = card.getByLabel(/^Cena \(zł\)/);
  const save = card.locator('form.form').getByRole('button', { name: 'Zapisz', exact: true });

  // Task 687: an empty name, minutes not on the 5-minute step and a price that is not a number
  // used to get the browser's bubble; now each is said under its field, the cursor on the first.
  const minutes = card.locator('#service-field-durationMinutes');
  await minutes.fill('7');
  await price.fill('abc');
  await save.click();
  await expect(card.locator('#service-name-error')).toHaveText('Uzupełnij to pole.');
  await expect(card.locator('#service-durationMinutes-error')).toHaveText(
    'Od 5 do 480 minut, co 5 minut.',
  );
  await expect(card.locator('#service-priceGrosze-error')).toHaveText(
    'Wpisz cenę od 0 do 100 000, np. 50 lub 49,99.',
  );
  await expect(name).toBeFocused();
  await expect(card.locator('.alert')).toHaveCount(0);
  await page.screenshot({ path: 'e2e/screenshots/687-service-empty-fields.png' });
  await minutes.fill('30');
  await expect(card.locator('#service-durationMinutes-error')).toHaveCount(0);

  // Only spaces and a price above the limit: both said at their fields, nothing sent.
  await name.fill('   ');
  await price.fill('250000');
  await save.click();
  await expect(card.locator('#service-name-error')).toHaveText('Uzupełnij to pole.');
  await expect(card.locator('#service-priceGrosze-error')).toHaveText(
    'Wpisz cenę od 0 do 100 000, np. 50 lub 49,99.',
  );
  await expect(name).toHaveAttribute('aria-invalid', 'true');
  await expect(price).toHaveAttribute('aria-invalid', 'true');
  await expect(card.locator('.alert')).toHaveCount(0);
  await page.screenshot({ path: 'e2e/screenshots/661-service-field-errors.png' });

  // Editing a field takes its own error away; the other stays until it is fixed.
  await name.fill('Strzyżenie męskie');
  await expect(card.locator('#service-name-error')).toHaveCount(0);
  await expect(card.locator('#service-priceGrosze-error')).toBeVisible();
  await price.fill('90');
  await expect(card.locator('#service-priceGrosze-error')).toHaveCount(0);
  await save.click();
  await expect(card).toHaveCount(0);
  await expect(page.getByText('Strzyżenie męskie').first()).toBeVisible();
});
