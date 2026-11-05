import {
  expect,
  test,
  type APIRequestContext,
  type APIResponse,
  type Page,
} from '@playwright/test';
import { freshAddress } from './addresses';
import { waitForEmail } from './mailpit';
import { serveApp } from './mobile-app';

/**
 * Tasks 163 and 180c: the salon's page opens without signing in, and the specialists' languages
 * are shown wherever a client chooses a specialist - the price list, the specialist step and
 * the client app; "Mówi po" leaves only those who speak the language. Screenshots 163–163c.
 */

const PASSWORD = 'e2e-password-123';
const run = Date.now().toString(36);
const PHONE = { width: 390, height: 844 };
const SALON = `Języki Barber ${run}`;

const shot = (page: Page, name: string) => page.screenshot({ path: `e2e/screenshots/${name}.png` });

async function json<T>(res: APIResponse): Promise<T> {
  expect(res.ok(), `${res.url()} → ${res.status()} ${await res.text()}`).toBeTruthy();
  return (res.status() === 204 ? undefined : await res.json()) as T;
}

/** An owner with a salon of three specialists: Taras (UA, PL), Oksana (UA), Piotr (PL). */
async function salonWithTeam(api: APIRequestContext): Promise<string> {
  const email = `languages-${run}@example.com`;
  await json(
    await api.post('/v1/auth/register', {
      headers: freshAddress(),
      data: { email, password: PASSWORD, name: 'Aleksander Owner' },
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
  const headers = { Authorization: `Bearer ${login.accessToken}` };
  const org = await json<{ id: string }>(
    await api.post('/v1/organizations', { headers, data: { name: SALON } }),
  );
  const location = await json<{ id: string; slug: string }>(
    await api.post(`/v1/organizations/${org.id}/locations`, {
      headers,
      data: {
        name: SALON,
        addressLine: 'ul. Językowa 3',
        city: 'Toruń',
        postalCode: '87-100',
        onlineBookingEnabled: true,
        bookingTerms: '# Regulamin\n\nWizyta jest bezpłatna do odwołania.',
        privacyPolicy: `# Prywatność\n\nAdministratorem danych jest ${SALON}.`,
      },
    }),
  );
  const base = `/v1/organizations/${org.id}/locations/${location.id}`;
  const service = await json<{ id: string }>(
    await api.post(`${base}/services`, {
      headers,
      data: { name: 'Strzyżenie', durationMinutes: 30, priceGrosze: 6000 },
    }),
  );
  for (const [name, languages] of [
    ['Taras', ['uk', 'pl']],
    ['Oksana', ['uk']],
    ['Piotr', ['pl']],
  ] as const) {
    await json(
      await api.post(`${base}/staff`, {
        headers,
        data: { displayName: name, languages, serviceIds: [service.id] },
      }),
    );
  }
  return location.slug;
}

test('the salon page needs no sign-in and shows the specialists’ languages everywhere', async ({
  browser,
  request,
}) => {
  const slug = await salonWithTeam(request);

  // ── The site, without an account ──
  const context = await browser.newContext({
    viewport: PHONE,
    isMobile: true,
    locale: 'pl-PL',
    extraHTTPHeaders: freshAddress(),
  });
  try {
    const page = await context.newPage();
    await page.goto(`/pl/b/${slug}`);
    await expect(page.getByRole('heading', { name: SALON })).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/pl/b/${slug}$`));
    // The price list: "Mówi po: ukraiński" - the line names Taras and Oksana with their languages.
    await page.getByRole('button', { name: 'Mówi po: ukraiński' }).click();
    const rows = page.locator('.price-rows li');
    await expect(rows.first()).toContainText('Taras');
    await expect(rows.first()).toContainText('Oksana');
    await expect(page.locator('.price-rows')).not.toContainText('Piotr');
    await expect(
      rows.first().locator('.pr-name', { hasText: 'Oksana' }).getByRole('note'),
    ).toHaveAttribute('aria-label', /ukraiński/);
    await shot(page, '163-price-list-speaks');
    await page.getByRole('button', { name: 'Wszyscy', exact: true }).click();

    // The specialist step: each specialist with the languages they speak.
    await page
      .getByRole('button', { name: /Strzyżenie/ })
      .first()
      .click();
    const staffButton = (name: string) =>
      page.getByRole('button', { name: new RegExp(`^${name}`) });
    await expect(staffButton('Taras').getByRole('note')).toHaveAttribute(
      'aria-label',
      /polski, ukraiński|ukraiński, polski/,
    );
    await expect(staffButton('Oksana').getByRole('note')).toHaveAttribute(
      'aria-label',
      /ukraiński/,
    );
    await expect(staffButton('Piotr').getByRole('note')).toHaveAttribute('aria-label', /polski/);
    await page
      .getByRole('group', { name: 'Mówi po' })
      .getByRole('button', { name: 'Mówi po: ukraiński' })
      .click();
    await expect(staffButton('Piotr')).toHaveCount(0);
    await expect(staffButton('Taras')).toBeVisible();
    await expect(staffButton('Oksana')).toBeVisible();
    await shot(page, '163a-staff-step-speaks');
  } finally {
    await context.close();
  }

  // ── The client app, without an account ──
  const clientApp = await serveApp('mobile-client');
  const phone = await browser.newContext({
    viewport: PHONE,
    isMobile: true,
    locale: 'pl-PL',
    timezoneId: 'Europe/Warsaw',
    extraHTTPHeaders: freshAddress(),
  });
  try {
    const app = await phone.newPage();
    await app.goto(clientApp.url);
    await app.getByRole('button', { name: 'Znajdź salon' }).click();
    await app.getByLabel('Szukaj: nazwa, miasto, ulica').fill(SALON);
    await app
      .getByRole('article', { name: SALON })
      .getByRole('button', { name: 'Zobacz salon' })
      .click();
    await expect(app.getByRole('heading', { name: SALON })).toBeVisible();
    // The team with the languages each one speaks.
    await expect(
      app
        .getByText('Mówimy po: ukraiński, polski')
        .or(app.getByText('Mówimy po: polski, ukraiński')),
    ).toBeVisible();
    await expect(app.getByText('Mówimy po: ukraiński', { exact: true })).toBeVisible();
    await shot(app, '163b-client-app-team-languages');
    await app.getByRole('button', { name: 'Umów wizytę' }).click();
    await app.getByRole('button', { name: /^Strzyżenie,/ }).click();
    await expect(app.getByRole('heading', { name: 'Wybierz specjalistę' })).toBeVisible();
    await expect(app.getByRole('button', { name: /^Piotr/ })).toContainText('Mówi po: polski');
    await app.getByRole('button', { name: 'ukraiński', exact: true }).click();
    await expect(app.getByRole('button', { name: /^Piotr/ })).toHaveCount(0);
    await expect(app.getByRole('button', { name: /^Oksana/ })).toContainText('Mówi po: ukraiński');
    await shot(app, '163c-client-app-staff-speaks');
  } finally {
    await phone.close();
    clientApp.server.close();
  }
});
