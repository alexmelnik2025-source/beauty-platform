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
  const email = page.getByLabel('E-mail');
  const password = page.getByLabel('Hasło');
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
