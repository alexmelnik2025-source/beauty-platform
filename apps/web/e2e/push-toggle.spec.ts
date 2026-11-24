import { expect, test, type APIResponse, type Page } from '@playwright/test';
import { freshAddress } from './addresses';
import { waitForEmail } from './mailpit';

/**
 * Task 840 (owner's rule: errors where the action is): "Powiadomienia na tym urządzeniu" in the
 * cabinet. A refused "Włącz powiadomienia" or "Wyłącz na tym urządzeniu" is said right under the
 * pressed button with the "!" mark (screenshots 840-push-on-error, 840-push-off-error).
 *
 * The e2e server has no push keys, so the browser's push service and the key are stand-ins here
 * (nothing leaves the test): the key answer is mocked and the browser's subscription is a fake.
 */

const PASSWORD = 'e2e-password-123';
const run = Date.now().toString(36);
const OWNER = `push-toggle-${run}@example.com`;
const PHONE = { width: 390, height: 844 };
const TOO_MANY = 'Zbyt wiele prób. Odczekaj chwilę.';

const shot = (page: Page, name: string) => page.screenshot({ path: `e2e/screenshots/${name}.png` });

async function json<T>(res: APIResponse): Promise<T> {
  expect(res.ok(), `${res.url()} → ${res.status()} ${await res.text()}`).toBeTruthy();
  return (res.status() === 204 ? undefined : await res.json()) as T;
}

const rateLimited = {
  status: 429,
  json: { error: { code: 'RATE_LIMITED', message: 'slow down' } },
};

test.use({ viewport: PHONE });

test('a refused push switch is said under the pressed button (task 840)', async ({
  page,
  request,
}) => {
  await json(
    await request.post('/v1/auth/register', {
      headers: freshAddress(),
      data: { email: OWNER, password: PASSWORD, name: 'Aleksander Owner' },
    }),
  );
  const mail = await waitForEmail(OWNER, /Potwierdź adres/);
  const token = /token=([^\s&]+)/.exec(mail.text)?.[1];
  await json(
    await request.post('/v1/auth/verify-email', { data: { token: decodeURIComponent(token!) } }),
  );
  const login = await json<{ accessToken: string }>(
    await request.post('/v1/auth/login', {
      headers: freshAddress(),
      data: { email: OWNER, password: PASSWORD, clientType: 'mobile' },
    }),
  );
  const owner = { Authorization: `Bearer ${login.accessToken}` };
  const org = await json<{ id: string }>(
    await request.post('/v1/organizations', {
      headers: owner,
      data: { name: `Powiadomienia ${run}` },
    }),
  );
  await json(
    await request.post(`/v1/organizations/${org.id}/locations`, {
      headers: owner,
      data: {
        name: `Powiadomienia ${run}`,
        addressLine: 'ul. Józefa Bema 91',
        city: 'Warszawa',
        postalCode: '01-233',
      },
    }),
  );

  // The browser's push service, as a stand-in: no subscription until "Włącz" asks for one.
  await page.addInitScript(() => {
    let subscription: object | null = null;
    const fake = {
      endpoint: 'https://push.example.invalid/e2e',
      toJSON: () => ({
        endpoint: 'https://push.example.invalid/e2e',
        keys: { p256dh: 'e2e-p256dh', auth: 'e2e-auth' },
      }),
      unsubscribe: async () => {
        subscription = null;
        return true;
      },
    };
    const pushManager = {
      getSubscription: async () => subscription,
      subscribe: async () => {
        subscription = fake;
        return fake;
      },
    };
    const registration = { pushManager };
    Object.defineProperty(Navigator.prototype, 'serviceWorker', {
      configurable: true,
      get: () => ({
        ready: Promise.resolve(registration),
        register: async () => registration,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }),
    });
    Object.defineProperty(Notification, 'permission', { configurable: true, get: () => 'default' });
    Notification.requestPermission = async () => 'granted';
  });
  await page.route('**/v1/me/push-subscriptions/public-key', (route) =>
    route.fulfill({
      json: {
        publicKey:
          'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U',
      },
    }),
  );

  await page.setExtraHTTPHeaders(freshAddress());
  await page.goto('/pl/login');
  await page.getByLabel('E-mail').fill(OWNER);
  await page.getByLabel('Hasło').fill(PASSWORD);
  await page.getByRole('button', { name: 'Zaloguj się' }).click();
  await page.waitForURL(/\/pl\/app(?!\/onboarding)/);
  await page.goto('/pl/app/notifications');

  // "Włącz powiadomienia" refused by the server: said under that button, nothing at the top.
  const saveUrl = '**/v1/me/push-subscriptions';
  await page.route(saveUrl, (route) =>
    route.request().method() === 'POST' ? route.fulfill(rateLimited) : route.fallback(),
  );
  const turnOn = page.getByRole('button', { name: 'Włącz powiadomienia' });
  await turnOn.click();
  await expect(page.locator('#push-toggle-error')).toHaveText(TOO_MANY);
  await expect(turnOn).toHaveAccessibleDescription(TOO_MANY);
  await expect(turnOn).toBeEnabled();
  await expect(page.locator('.alert')).toHaveCount(0);
  await shot(page, '840-push-on-error');

  // Trying again once the server takes it: the error goes, the switch is on.
  await page.unroute(saveUrl);
  await page.route(saveUrl, (route) =>
    route.request().method() === 'POST' ? route.fulfill({ status: 204 }) : route.fallback(),
  );
  await turnOn.click();
  const turnOff = page.getByRole('button', { name: 'Wyłącz na tym urządzeniu' });
  await expect(turnOff).toBeVisible();
  await expect(page.locator('#push-toggle-error')).toHaveCount(0);

  // "Wyłącz na tym urządzeniu" refused: said under that button, the switch stays on.
  const removeUrl = '**/v1/me/push-subscriptions/remove';
  await page.route(removeUrl, (route) => route.fulfill(rateLimited));
  await turnOff.click();
  await expect(page.locator('#push-toggle-error')).toHaveText(TOO_MANY);
  await expect(turnOff).toHaveAccessibleDescription(TOO_MANY);
  await expect(turnOff).toBeEnabled();
  await expect(page.locator('.alert')).toHaveCount(0);
  await shot(page, '840-push-off-error');
});
