import { expect, test, type Page, type Route } from '@playwright/test';
import { openBusinessMenu, serveApp } from './mobile-app';

const email = 'network@example.com';
const tokens = { accessToken: 'test-access', refreshToken: 'test-refresh' };
const networkError = /Brak połączenia z serwerem/;
const organization = { id: 'org', name: 'Studio', role: 'staff' };
const locations = '/v1/organizations/org/locations';
const salon = {
  id: 'first',
  name: 'Centrum',
  city: 'Warszawa',
  timezone: 'Europe/Warsaw',
  currency: 'PLN',
};
let app: Awaited<ReturnType<typeof serveApp>>;

test.use({ viewport: { width: 320, height: 740 }, locale: 'pl-PL', timezoneId: 'Europe/Warsaw' });
test.beforeAll(async () => {
  app = await serveApp('mobile-business');
});
test.afterAll(() => {
  app.server.close();
});
// Other day-screen requests must stay inside this simulated session too.
test.beforeEach(async ({ page }) => {
  await page.route('**/v1/**', (route) => route.abort());
});

async function restoreSession(page: Page) {
  await page.addInitScript(
    (token) => localStorage.setItem('beauty.business.refreshToken', token),
    tokens.refreshToken,
  );
  await page.route('**/v1/auth/refresh', (route) => route.fulfill({ json: tokens }));
}

// Hold the response until the test has observed the pending state, without relying on a timer.
async function holdFirst(page: Page, path: string, answer: (route: Route) => Promise<void>) {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  await page.route(path, async (route) => {
    calls++;
    if (calls === 1) {
      await pending;
      await answer(route);
    } else {
      await route.fallback();
    }
  });
  return { release, calls: () => calls };
}

test('sign-in keeps the contact and code, and recovers the salon list', async ({ page }) => {
  await page.route('**/v1/auth/code', (r) => r.fulfill({ json: { channel: 'email' } }));
  const sendRequest = await holdFirst(page, '**/v1/auth/code', (r) => r.abort());
  await page.route('**/v1/auth/code/verify', (r) => r.fulfill({ json: tokens }));
  const verifyRequest = await holdFirst(page, '**/v1/auth/code/verify', (r) => r.abort());
  await page.route('**/v1/me', (r) => r.fulfill({ json: { organizations: [organization] } }));
  await page.route('**/v1/auth/refresh', (r) => r.fulfill({ json: tokens }));
  await page.route('**' + locations, (r) =>
    r.fulfill({ json: [salon, { ...salon, id: 'other', name: 'Rynek' }] }),
  );
  const list = await holdFirst(page, '**' + locations, (r) => r.abort());
  await page.goto(app.url);
  const contact = page.getByLabel('E-mail lub telefon');
  const send = page.getByRole('button', { name: 'Wyślij kod' });
  const alert = page.getByRole('alert');
  await contact.fill(email);
  await send.dblclick();
  await expect(send).toBeDisabled();
  await expect(page.getByRole('button', { name: /^Język:/ })).toBeDisabled();
  sendRequest.release();
  await expect(alert).toContainText(networkError);
  await expect(contact).toHaveValue(email);
  expect(sendRequest.calls()).toBe(1);
  await send.click();
  const code = page.getByLabel('Kod', { exact: true });
  const confirm = page.getByRole('button', { name: 'Zaloguj się' });
  await code.fill('012345');
  expect(sendRequest.calls()).toBe(2);
  await confirm.dblclick();
  await expect(confirm).toBeDisabled();
  await expect(send).toBeDisabled();
  verifyRequest.release();
  await expect(alert).toContainText(networkError);
  await expect(code).toHaveValue('012345');
  expect(verifyRequest.calls()).toBe(1);
  await confirm.click();
  await expect(page.getByRole('progressbar')).toBeVisible();
  list.release();
  await expect(alert).toContainText(networkError);
  await expect(page.getByRole('progressbar')).toHaveCount(0);
  await page.getByRole('button', { name: 'Odśwież' }).click();
  const choice = page.getByRole('button', { name: salon.name });
  await expect(choice).toBeEnabled();
  expect(list.calls()).toBe(2);
  expect(verifyRequest.calls()).toBe(2);
  await expect(page.getByRole('button', { name: 'Rynek' })).toBeVisible();
  const logout = await holdFirst(page, '**/v1/auth/logout', (r) => r.fulfill({ status: 204 }));
  const signOut = page.getByRole('button', { name: 'Wyloguj się' });
  await signOut.dblclick();
  await expect(signOut).toBeDisabled();
  await expect(choice).toBeDisabled();
  logout.release();
  await expect(contact).toBeVisible();
  expect(logout.calls()).toBe(1);
});

test('creating a salon retries only the failed step with the same form', async ({ page }) => {
  await restoreSession(page);
  let created = false;
  await page.route('**/v1/me', (r) =>
    r.fulfill({ json: { user: { id: 'user' }, organizations: created ? [organization] : [] } }),
  );
  const company = await holdFirst(page, '**/v1/organizations', (r) =>
    r.fulfill({ status: 201, json: organization }),
  );
  let posts = 0;
  await page.route('**' + locations, async (r) => {
    if (r.request().method() === 'GET') return r.fulfill({ json: [salon] });
    posts++;
    if (posts === 1) return r.abort();
    expect(r.request().postDataJSON()).toMatchObject({
      name: salon.name,
      addressLine: 'Rynek 1',
      city: salon.city,
      postalCode: '00-001',
    });
    created = true;
    await r.fulfill({ status: 201, json: salon });
  });
  await page.goto(app.url);
  const create = page.getByRole('button', { name: 'Załóż salon', exact: true });
  await create.click();
  const fields = {
    'Nazwa firmy': organization.name,
    'Nazwa salonu': salon.name,
    'Ulica i numer': 'Rynek 1',
    Miasto: salon.city,
    'Kod pocztowy': '00-001',
  };
  for (const [label, value] of Object.entries(fields))
    await page.getByLabel(label, { exact: true }).fill(value);
  await create.dblclick();
  await expect(create).toBeDisabled();
  company.release();
  await expect(page.getByRole('alert')).toContainText(networkError);
  for (const [label, value] of Object.entries(fields))
    await expect(page.getByLabel(label, { exact: true })).toHaveValue(value);
  expect(posts).toBe(1);
  await expect(page.getByLabel('Nazwa firmy', { exact: true })).not.toBeEditable();
  await create.click();
  await expect(page.getByRole('button', { name: 'Dziś', exact: true })).toBeVisible();
  expect(company.calls()).toBe(1);
  expect(posts).toBe(2);
});

test('the profile retries a failed load and keeps the selected languages after a failed save', async ({
  page,
}) => {
  await restoreSession(page);
  const staff = { id: 'staff', userId: 'user', displayName: 'Kasia', languages: ['pl'] };
  await page.route('**/v1/me', (r) =>
    r.fulfill({ json: { user: { id: 'user' }, organizations: [organization] } }),
  );
  await page.route('**' + locations, (r) =>
    r.fulfill({ json: [salon, { ...salon, id: 'other', name: 'Rynek' }] }),
  );
  const staffPath = '**' + locations + '/first/staff';
  await page.route(staffPath, (r) => r.fulfill({ json: [staff] }));
  await page.route(staffPath + '/staff/languages', (r) =>
    r.fulfill({ json: { ...staff, languages: r.request().postDataJSON().languages } }),
  );
  const saveRequest = await holdFirst(page, staffPath + '/staff/languages', (r) => r.abort());
  await page.goto(app.url);
  await page.getByRole('button', { name: salon.name }).click();
  await page.getByRole('tab', { name: 'Więcej' }).click();
  await expect(page.getByRole('button', { name: 'Mój profil' })).toBeVisible();
  await page.route(staffPath, (r) => r.abort(), { times: 1 });
  await openBusinessMenu(page, 'Mój profil');
  await expect(page.getByRole('alert')).toContainText(networkError);
  await page.getByRole('button', { name: 'Odśwież' }).click();
  const english = page.getByRole('checkbox', { name: 'English' });
  const save = page.getByRole('button', { name: 'Zapisz języki' });
  await english.click();
  await save.dblclick();
  await expect(save).toBeDisabled();
  await expect(english).toBeDisabled();
  saveRequest.release();
  await expect(page.getByRole('alert')).toContainText(networkError);
  await expect(english).toBeChecked();
  await expect(page.getByRole('checkbox', { name: 'Polski' })).toBeChecked();
  expect(saveRequest.calls()).toBe(1);
  await save.click();
  await expect(page.getByRole('status')).toContainText('Języki zapisane');
  await expect(save).toBeDisabled();
  await expect(page.getByText('Centrum · 🇵🇱 🇬🇧')).toBeVisible();
  expect(saveRequest.calls()).toBe(2);
});
