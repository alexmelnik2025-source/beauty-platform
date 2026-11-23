import { expect, test } from '@playwright/test';
import { freshAddress } from './addresses';

/**
 * Task 656 (owner's rule: errors at the field, not a line on top): signing in with a wrong
 * password shows the error under "Hasło" (red frame, "!"), and it goes away once the password is
 * typed again; an address that is not confirmed yet is said under "E-mail".
 */

const PASSWORD = 'e2e-password-123';
const EMAIL = `auth-errors-${Date.now().toString(36)}@example.com`;

test('sign-in errors are shown at their own field', async ({ page, request }) => {
  const registered = await request.post('/v1/auth/register', {
    headers: freshAddress(),
    data: { email: EMAIL, password: PASSWORD, name: 'Ewa' },
  });
  expect(registered.ok()).toBeTruthy();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.setExtraHTTPHeaders(freshAddress());
  await page.goto('/pl/login');
  // By type: the error under a field becomes part of its name ("Hasło ! Nieprawidłowy e-mail…").
  const email = page.locator('input[type="email"]');
  const password = page.locator('input[type="password"]');
  await email.fill(EMAIL);
  await password.fill('not-the-password');
  await page.getByRole('button', { name: 'Zaloguj się' }).click();

  const passwordError = page.locator('#login-password-error');
  await expect(passwordError).toHaveText('Nieprawidłowy e-mail lub hasło.');
  await expect(password).toHaveAttribute('aria-invalid', 'true');
  await expect(password).toHaveAttribute('aria-describedby', 'login-password-error');
  await expect(email).not.toHaveAttribute('aria-invalid', 'true');
  await expect(page.locator('.alert')).toHaveCount(0);
  await page.screenshot({ path: 'e2e/screenshots/656-login-password-error.png' });

  // Typing the password again takes the error away.
  await password.fill(PASSWORD);
  await expect(passwordError).toHaveCount(0);
  await expect(password).not.toHaveAttribute('aria-invalid', 'true');

  // The right password, but the address is not confirmed yet: said under the e-mail.
  await page.getByRole('button', { name: 'Zaloguj się' }).click();
  await expect(page.locator('#login-email-error')).toContainText('Najpierw potwierdź adres e-mail');
  await expect(email).toHaveAttribute('aria-invalid', 'true');
  await expect(page.locator('.alert')).toHaveCount(0);
  await page.screenshot({ path: 'e2e/screenshots/656-login-email-error.png' });
});

/**
 * Task 686 (owner's rule: errors at the field): an empty or wrong field is said under the field
 * itself, not in the browser's bubble, and nothing is sent to the server.
 */
test('empty or wrong sign-in and sign-up fields are said under them', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.setExtraHTTPHeaders(freshAddress());
  await page.goto('/pl/login');
  const email = page.locator('input[type="email"]');
  const password = page.locator('input[type="password"]');

  await page.getByRole('button', { name: 'Zaloguj się' }).click();
  await expect(page.locator('#login-email-error')).toHaveText('Uzupełnij to pole.');
  await expect(email).toHaveAttribute('aria-invalid', 'true');
  await expect(email).toBeFocused();

  await email.fill('ewa.example.com');
  await expect(page.locator('#login-email-error')).toHaveCount(0);
  await page.getByRole('button', { name: 'Zaloguj się' }).click();
  await expect(page.locator('#login-email-error')).toHaveText('Sprawdź adres e-mail.');
  await page.screenshot({ path: 'e2e/screenshots/686-login-email-invalid.png' });

  await email.fill('ewa@example.com');
  await page.getByRole('button', { name: 'Zaloguj się' }).click();
  await expect(page.locator('#login-password-error')).toHaveText('Uzupełnij to pole.');
  await expect(password).toBeFocused();
  await expect(page.locator('.alert')).toHaveCount(0);

  await page.goto('/pl/register');
  const create = page.getByRole('button', { name: 'Załóż konto' });
  await page.locator('input[name="email"]').fill('ewa@example');
  await page.locator('input[name="password"]').fill('short');
  await create.click();
  await expect(page.locator('#register-name-error')).toHaveText('Uzupełnij to pole.');
  await expect(page.locator('#register-email-error')).toHaveText('Sprawdź adres e-mail.');
  await expect(page.locator('#register-password-error')).toHaveText('Co najmniej 10 znaków');
  await expect(page.locator('input[name="name"]')).toBeFocused();
  await expect(page.locator('.alert')).toHaveCount(0);
  await page.screenshot({ path: 'e2e/screenshots/686-register-field-errors.png' });

  // Typing in a field takes only its own error away.
  await page.locator('input[name="name"]').fill('Ewa');
  await expect(page.locator('#register-name-error')).toHaveCount(0);
  await expect(page.locator('#register-email-error')).toHaveCount(1);
});
