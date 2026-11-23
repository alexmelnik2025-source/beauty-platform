import { expect, test } from '@playwright/test';
import { freshAddress } from './addresses';
import { waitForEmail } from './mailpit';

/**
 * Task 690 (owner's rule: errors at the field): "Moje wizyty" sign-in. An empty or wrong e-mail is
 * said under "E-mail" (no browser bubble), the cursor stays there; a wrong code is said under the
 * code field, not in a line on top. Typing again takes the error away, the right code signs in.
 */

const CLIENT = `visits-errors-${Date.now().toString(36)}@example.com`;

test.use({ viewport: { width: 390, height: 844 }, locale: 'pl-PL' });

test('the visits sign-in says a wrong e-mail and a wrong code under their fields', async ({
  page,
}) => {
  await page.setExtraHTTPHeaders(freshAddress());
  await page.goto('/pl/c');
  const email = page.locator('input[type="email"]');
  const send = page.getByRole('button', { name: 'Wyślij kod' });

  // Empty: said under the field, nothing sent.
  await send.click();
  await expect(page.locator('#visits-email-error')).toHaveText('Uzupełnij to pole.');
  await expect(email).toHaveAttribute('aria-invalid', 'true');
  await expect(email).toBeFocused();
  await expect(page.locator('.alert')).toHaveCount(0);

  // Not an address: said under the field.
  await email.fill('anna@');
  await expect(page.locator('#visits-email-error')).toHaveCount(0);
  await send.click();
  await expect(page.locator('#visits-email-error')).toHaveText('Sprawdź adres e-mail.');
  await page.screenshot({ path: 'e2e/screenshots/690-visits-email-error.png' });

  // A real address: the code is sent.
  await email.fill(CLIENT);
  await send.click();
  const mail = await waitForEmail(CLIENT, /Kod logowania do Twoich wizyt/);
  const right = /\b(\d{6})\b/.exec(mail.text)![1]!;
  const wrong = right === '000000' ? '111111' : '000000';

  // A wrong code: said under the code field.
  const code = page.getByLabel('Kod z e-maila');
  await code.fill(wrong);
  await page.getByRole('button', { name: 'Zaloguj się' }).click();
  await expect(page.locator('#visits-code-error')).toHaveText('Nieprawidłowy kod.');
  await expect(code).toHaveAttribute('aria-invalid', 'true');
  await expect(page.locator('.alert')).toHaveCount(0);
  await page.screenshot({ path: 'e2e/screenshots/690-visits-code-error.png' });

  // Typing again takes it away; the right code signs in.
  await code.fill(right);
  await expect(page.locator('#visits-code-error')).toHaveCount(0);
  await page.getByRole('button', { name: 'Zaloguj się' }).click();
  await expect(page.getByRole('button', { name: 'Nadchodzące' })).toBeVisible();
});
