import { expect, test, type APIResponse } from '@playwright/test';
import { freshAddress } from './addresses';
import { waitForEmail } from './mailpit';

/**
 * Task 657: a new owner's "Twój salon" form. An address of only spaces is said at its own field
 * (red frame, "!") before anything is created; a postal code the server does not take is said at
 * its field too, and trying again adds the salon to the company already created — the owner
 * ends up with one company, not two with the same name.
 */

const PASSWORD = 'e2e-password-123';
const OWNER = `onboarding-retry-${Date.now().toString(36)}@example.com`;

test.use({ timezoneId: 'Europe/Istanbul', viewport: { width: 390, height: 844 } });

async function json<T>(res: APIResponse): Promise<T> {
  expect(res.ok(), `${res.url()} → ${res.status()} ${await res.text()}`).toBeTruthy();
  return (res.status() === 204 ? undefined : await res.json()) as T;
}

test('the new-salon form says errors at the field and never creates the company twice', async ({
  page,
  request,
}) => {
  await json(
    await request.post('/v1/auth/register', {
      headers: freshAddress(),
      data: { email: OWNER, password: PASSWORD, name: 'Deniz' },
    }),
  );
  const mail = await waitForEmail(OWNER, /Potwierdź adres/);
  const token = /token=([^\s&]+)/.exec(mail.text)?.[1];
  await json(
    await request.post('/v1/auth/verify-email', { data: { token: decodeURIComponent(token!) } }),
  );

  await page.setExtraHTTPHeaders(freshAddress());
  await page.goto('/pl/login');
  await page.getByLabel('E-mail').fill(OWNER);
  await page.getByLabel('Hasło').fill(PASSWORD);
  await page.getByRole('button', { name: 'Zaloguj się' }).click();
  await page.waitForURL(/\/pl\/app\/onboarding/);

  const address = page.getByLabel('Ulica i numer');
  const postal = page.getByLabel('Kod pocztowy');

  // Task 689: nothing filled in — no browser bubble, each empty field said under it, the cursor
  // on the first ("Nazwa firmy").
  await page.getByRole('button', { name: 'Utwórz salon' }).click();
  await expect(page.locator('#onboarding-orgName-error')).toHaveText('Uzupełnij to pole.');
  await expect(page.getByLabel('Nazwa firmy')).toBeFocused();
  await expect(page.locator('#onboarding-addressLine-error')).toHaveText('Uzupełnij to pole.');
  await expect(page.locator('#onboarding-city-error')).toHaveText('Uzupełnij to pole.');
  await expect(page.locator('#onboarding-postalCode-error')).toHaveText('Uzupełnij to pole.');
  await expect(page.locator('#onboarding-locationName-error')).toHaveCount(0);
  await page.screenshot({ path: 'e2e/screenshots/689-onboarding-empty-fields.png' });
  await page.getByLabel('Nazwa firmy').fill('Berber Moda');
  await address.fill('   ');
  await page.getByLabel('Miasto').fill('İstanbul');
  // Longer than any postal code the server takes (12 characters at most).
  await postal.fill('3471034710347');
  await page.getByRole('button', { name: 'Utwórz salon' }).click();

  // Only spaces: said at the field before anything is sent.
  await expect(page.locator('#onboarding-addressLine-error')).toHaveText('Uzupełnij to pole.');
  await expect(address).toHaveAttribute('aria-invalid', 'true');
  await expect(page.locator('.alert')).toHaveCount(0);
  await page.screenshot({ path: 'e2e/screenshots/657-onboarding-field-error.png' });
  await address.fill('Moda Cd. 1');
  await expect(page.locator('#onboarding-addressLine-error')).toHaveCount(0);

  // The company is created, the salon is not: the postal code is said at its field.
  await page.getByRole('button', { name: 'Utwórz salon' }).click();
  await expect(page.locator('#onboarding-postalCode-error')).toHaveText('Sprawdź kod pocztowy.');
  await expect(postal).toHaveAttribute('aria-invalid', 'true');

  // Task 798 (owner's rule: errors where the action is): a refusal not about a field (too many
  // tries) is said under "Utwórz salon", not at the top of the form.
  await postal.fill('34710');
  const locationsUrl = '**/v1/organizations/*/locations';
  await page.route(locationsUrl, (route) =>
    route.request().method() === 'POST'
      ? route.fulfill({
          status: 429,
          json: { error: { code: 'RATE_LIMITED', message: 'slow down' } },
        })
      : route.fallback(),
  );
  const create = page.getByRole('button', { name: 'Utwórz salon' });
  await create.click();
  await expect(page.locator('#onboarding-submit-error')).toHaveText(
    'Zbyt wiele prób. Odczekaj chwilę.',
  );
  await expect(create).toHaveAccessibleDescription(/Zbyt wiele prób\. Odczekaj chwilę\.$/);
  await expect(create).toBeEnabled();
  await expect(page.locator('.alert')).toHaveCount(0);
  await page.screenshot({ path: 'e2e/screenshots/798-onboarding-submit-error.png' });
  await page.unroute(locationsUrl);

  // Trying again adds the salon to that company.
  await page.getByRole('button', { name: 'Utwórz salon' }).click();
  await page.waitForURL(/\/pl\/app\/calendar/);
  await page.waitForLoadState('networkidle');

  const login = await json<{ accessToken: string }>(
    await request.post('/v1/auth/login', {
      headers: freshAddress(),
      data: { email: OWNER, password: PASSWORD, clientType: 'mobile' },
    }),
  );
  const orgs = await json<{ name: string }[]>(
    await request.get('/v1/organizations', {
      headers: { Authorization: `Bearer ${login.accessToken}` },
    }),
  );
  expect(orgs.map((o) => o.name)).toEqual(['Berber Moda']);
});
