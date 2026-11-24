import {
  expect,
  test,
  type APIRequestContext,
  type APIResponse,
  type Locator,
} from '@playwright/test';
import { freshAddress } from './addresses';
import { waitForEmail } from './mailpit';
import { openBusinessMenu, serveApp } from './mobile-app';

const PASSWORD = 'e2e-password-123';
const run = Date.now().toString(36);
const OWNER = `af-rights-owner-${run}@example.com`;
const KASIA = `af-rights-kasia-${run}@example.com`;
const PHONE = { width: 320, height: 844 };
const memberName = 'Aleksandra ' + 'Kowalska'.repeat(5);
const categoryName = 'Starszy' + 'Specjalista'.repeat(4);

async function expectWrapped(text: Locator) {
  await expect(text).toBeVisible();
  const lines = await text.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const box = element.getBoundingClientRect();
    return Array.from(
      range.getClientRects(),
      (line) =>
        line.left >= Math.max(0, box.left) - 1 &&
        line.right <= Math.min(window.innerWidth, box.right) + 1 &&
        line.bottom <= box.bottom + 1,
    );
  });
  expect(lines.length).toBeGreaterThan(1);
  expect(lines).not.toContain(false);
}

async function expectTarget(control: Locator) {
  await expect(control).toBeVisible();
  const bounds = await control.boundingBox();
  expect(bounds!.width).toBeGreaterThanOrEqual(44);
  expect(bounds!.height).toBeGreaterThanOrEqual(44);
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(PHONE.width);
}

async function json<T>(res: APIResponse): Promise<T> {
  expect(res.ok(), `${res.url()} → ${res.status()} ${await res.text()}`).toBeTruthy();
  return (res.status() === 204 ? undefined : await res.json()) as T;
}

async function verifiedUser(api: APIRequestContext, email: string, name: string) {
  await json(
    await api.post('/v1/auth/register', {
      headers: freshAddress(),
      data: { email, password: PASSWORD, name },
    }),
  );
  const mail = await waitForEmail(email, /Potwierdź adres/);
  const token = /token=([^\s&]+)/.exec(mail.text)?.[1];
  expect(token, 'verification link').toBeTruthy();
  await json(
    await api.post('/v1/auth/verify-email', {
      headers: freshAddress(),
      data: { token: decodeURIComponent(token!) },
    }),
  );
  const login = await json<{ accessToken: string }>(
    await api.post('/v1/auth/login', {
      headers: freshAddress(),
      data: { email, password: PASSWORD, clientType: 'mobile' },
    }),
  );
  return { Authorization: `Bearer ${login.accessToken}` };
}

test('business app: permissions fit at 320 px with large text', async ({ browser, request }) => {
  const owner = await verifiedUser(request, OWNER, 'Aleksander Owner');
  const org = await json<{ id: string }>(
    await request.post('/v1/organizations', { headers: owner, data: { name: 'GESTALT' } }),
  );
  const location = await json<{ id: string }>(
    await request.post(`/v1/organizations/${org.id}/locations`, {
      headers: owner,
      data: {
        name: 'Gestalt Barbershop',
        addressLine: 'ul. Józefa Bema 91',
        city: 'Warszawa',
        postalCode: '01-233',
      },
    }),
  );
  const base = `/v1/organizations/${org.id}/locations/${location.id}`;
  const profile = await json<{ id: string }>(
    await request.post(`${base}/staff`, { headers: owner, data: { displayName: 'Kasia' } }),
  );
  await json(
    await request.post(`/v1/organizations/${org.id}/invitations`, {
      headers: owner,
      data: { email: KASIA, role: 'staff', locationIds: [location.id], staffMemberId: profile.id },
    }),
  );
  const invitation = await waitForEmail(KASIA, /Zaproszenie/);
  const inviteToken = /\/invite\/(\S+)/.exec(invitation.text)![1]!;
  const kasia = await verifiedUser(request, KASIA, memberName);
  await json(await request.post(`/v1/invitations/${inviteToken}/accept`, { headers: kasia }));

  const businessApp = await serveApp('mobile-business');
  const context = await browser.newContext({
    viewport: PHONE,
    locale: 'pl-PL',
    isMobile: true,
    extraHTTPHeaders: freshAddress(),
  });
  try {
    const page = await context.newPage();
    await page.goto(businessApp.url);
    await page.getByLabel('E-mail lub telefon').fill(OWNER);
    await page.getByRole('button', { name: 'Wyślij kod' }).click();
    const mail = await waitForEmail(OWNER, /Kod logowania do aplikacji salonu/);
    await page.getByLabel('Kod', { exact: true }).fill(/\b(\d{6})\b/.exec(mail.text)![1]!);
    await page.getByRole('button', { name: 'Zaloguj się' }).click();
    await openBusinessMenu(page, 'Zespół');
    await page.getByRole('button', { name: 'Uprawnienia', exact: true }).click();
    await page.addStyleTag({
      content: '[dir="auto"]:not([role="heading"]) { font-size: 21px !important }',
    });
    const name = page.getByText(memberName, { exact: true });
    await expect(name).toHaveCSS('font-size', '21px');
    await expectWrapped(name);
    await page.getByRole('button', { name: '+ Nowa kategoria' }).click();
    await page.getByLabel('Nazwa (np. Starszy barber)').fill(categoryName);
    const contacts = page.getByRole('checkbox', {
      name: 'Widzi telefon i e-mail klienta',
      exact: true,
    });
    await expectTarget(contacts);
    await contacts.click();
    await expect(contacts).toBeChecked();
    await page.getByRole('button', { name: 'Zapisz', exact: true }).click();
    await expect(page.getByText('Kategoria zapisana.')).toBeVisible();

    await page.getByRole('button', { name: `Zmień: ${memberName}`, exact: true }).click();
    const category = page.getByRole('button', { name: categoryName, exact: true });
    await expectWrapped(category.getByText(categoryName));
    await expectTarget(category);
    await category.click();
    await expect(category).toHaveAttribute('aria-pressed', 'true');
    const group = page.getByRole('radiogroup', { name: 'Widzi ceny i swoje wyniki' });
    for (const option of await group.getByRole('radio').all()) await expectTarget(option);
    const allow = group.getByRole('radio', { name: 'Widzi ceny i swoje wyniki: Tak', exact: true });
    await allow.click();
    await expect(allow).toBeChecked();
  } finally {
    await context.close();
    businessApp.server.close();
  }
});
