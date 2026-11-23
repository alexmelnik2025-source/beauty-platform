import { expect, test, type APIResponse } from '@playwright/test';
import { freshAddress } from './addresses';
import { waitForEmail } from './mailpit';

/**
 * Task 659 (owner's rule: errors at the field): the "Dodaj klienta" card in the cabinet. A name
 * of only spaces is said under "Imię i nazwisko" before anything is sent; a phone another client
 * already has is said under "Telefon", with "Dodaj mimo to" right below the fields — no line on
 * top of the form. Changing the number takes the error and the offer away.
 * Task 689: an empty name or phone and a wrong e-mail never get the browser's bubble either.
 */

const PASSWORD = 'e2e-password-123';
const OWNER = `client-errors-${Date.now().toString(36)}@example.com`;
/** The salon's own address: the API limits sign-ups and sign-ins per address. */
const OWNER_IP = freshAddress();

test.use({ viewport: { width: 390, height: 844 }, locale: 'pl-PL' });

async function json<T>(res: APIResponse): Promise<T> {
  expect(res.ok(), `${res.url()} → ${res.status()} ${await res.text()}`).toBeTruthy();
  return (res.status() === 204 ? undefined : await res.json()) as T;
}

test('the new-client card says a blank name and a taken phone at their fields', async ({
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
  await json(
    await request.post(`/v1/organizations/${org.id}/customers`, {
      headers: owner,
      data: { name: 'Jan Kowalski', phone: '+48600000659' },
    }),
  );

  await page.setExtraHTTPHeaders(OWNER_IP);
  await page.goto('/pl/login');
  await page.getByLabel('E-mail').fill(OWNER);
  await page.getByLabel('Hasło').fill(PASSWORD);
  await page.getByRole('button', { name: 'Zaloguj się' }).click();
  await page.waitForURL(/\/pl\/app\//);
  await page.goto('/pl/app/clients');
  await expect(page.locator('.list .list-row')).toHaveCount(1);

  await page.getByRole('button', { name: '+ Dodaj klienta' }).click();
  const card = page.getByRole('dialog');
  const name = card.getByLabel('Imię i nazwisko');
  const phone = card.getByRole('textbox', { name: 'Telefon' });
  const save = card.locator('form.form').getByRole('button', { name: 'Zapisz', exact: true });

  // Task 689: an empty name, a phone with only the country code and a wrong e-mail — no browser
  // bubble, each said under its own field, the cursor on the first.
  const email = card.getByLabel('E-mail');
  await phone.fill('+48 ');
  await email.fill('jan@');
  await save.click();
  await expect(card.locator('#client-name-error')).toHaveText('Podaj imię.');
  await expect(name).toBeFocused();
  await expect(phone).toHaveAttribute('aria-invalid', 'true');
  await expect(card.getByText('Uzupełnij to pole.')).toBeVisible();
  await expect(card.locator('#client-email-error')).toHaveText('Sprawdź adres e-mail.');
  await expect(card.locator('.alert')).toHaveCount(0);
  await page.screenshot({ path: 'e2e/screenshots/689-client-empty-fields.png' });
  await email.fill('');
  await expect(card.locator('#client-email-error')).toHaveCount(0);

  // Only spaces: said at the field before anything is sent.
  await name.fill('   ');
  await phone.fill('+48 600 000 659');
  await save.click();
  await expect(card.locator('#client-name-error')).toHaveText('Podaj imię.');
  await expect(name).toHaveAttribute('aria-invalid', 'true');
  await expect(card.locator('.alert')).toHaveCount(0);
  await name.fill('Jan Drugi');
  await expect(card.locator('#client-name-error')).toHaveCount(0);

  // A phone another client has: said under "Telefon", "Dodaj mimo to" below the fields.
  await save.click();
  await expect(card.getByText('Klient z tym numerem już istnieje.')).toBeVisible();
  await expect(phone).toHaveAttribute('aria-invalid', 'true');
  await expect(card.locator('.alert')).toHaveCount(0);
  const anyway = card.getByRole('button', { name: 'Dodaj mimo to' });
  await expect(anyway).toBeVisible();
  await page.screenshot({ path: 'e2e/screenshots/659-client-phone-exists.png' });

  // Changing the number takes the error and the offer away; putting it back and adding anyway works.
  await phone.fill('+48 600 000 658');
  await expect(card.getByText('Klient z tym numerem już istnieje.')).toHaveCount(0);
  await expect(anyway).toHaveCount(0);
  await phone.fill('+48 600 000 659');
  await save.click();
  await card.getByRole('button', { name: 'Dodaj mimo to' }).click();
  await expect(card).toHaveCount(0);
  await expect(page.locator('.list .list-row')).toHaveCount(2);
});
