import {
  expect,
  test,
  type APIRequestContext,
  type APIResponse,
  type Page,
} from '@playwright/test';
import { freshAddress } from './addresses';
import { waitForEmail } from './mailpit';

/**
 * Task Q9: "Zasady dla klienta". The salon's protection is off; Ola missed a visit, so the owner
 * sets her own rule in the client card: "Najpierw opłata zaległych". Ola books online: after the
 * code the page tells her she pays the missed visit and this one in the salon, and "Rozumiem —
 * potwierdź wizytę" books the visit (no online payment). Screenshots q9-client-rules-card,
 * q9-pay-notice.
 */

const PASSWORD = 'e2e-password-123';
const run = Date.now().toString(36);
const OWNER = `q9-owner-${run}@example.com`;
const OLA = `q9-ola-${run}@example.com`;
const PHONE = { width: 390, height: 844 };

const shot = (page: Page, name: string) => page.screenshot({ path: `e2e/screenshots/${name}.png` });

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
    await api.post('/v1/auth/verify-email', { data: { token: decodeURIComponent(token!) } }),
  );
  const login = await json<{ accessToken: string }>(
    await api.post('/v1/auth/login', {
      headers: freshAddress(),
      data: { email, password: PASSWORD, clientType: 'mobile' },
    }),
  );
  return { Authorization: `Bearer ${login.accessToken}` };
}

test('Q9: the owner sets a rule for one client, who books after the notice to pay in the salon', async ({
  browser,
  request,
}) => {
  const owner = await verifiedUser(request, OWNER, 'Aleksander Owner');
  const org = await json<{ id: string }>(
    await request.post('/v1/organizations', { headers: owner, data: { name: 'GESTALT' } }),
  );
  const location = await json<{ id: string; slug: string; version: number }>(
    await request.post(`/v1/organizations/${org.id}/locations`, {
      headers: owner,
      data: {
        name: 'Gestalt Zasady',
        addressLine: 'ul. Józefa Bema 91',
        city: 'Warszawa',
        postalCode: '01-233',
      },
    }),
  );
  const base = `/v1/organizations/${org.id}/locations/${location.id}`;
  await json(
    await request.patch(base, {
      headers: owner,
      data: {
        version: location.version,
        onlineBookingEnabled: true,
        bookingTerms: '# Regulamin rezerwacji\n\nRezerwacja jest bezpłatna.',
        privacyPolicy: '# Polityka prywatności\n\nAdministratorem danych jest GESTALT.',
      },
    }),
  );
  const service = await json<{ id: string }>(
    await request.post(`${base}/services`, {
      headers: owner,
      data: { name: 'Strzyżenie męskie', durationMinutes: 45, priceGrosze: 9000 },
    }),
  );
  const staff = await json<{ id: string }>(
    await request.post(`${base}/staff`, {
      headers: owner,
      data: { displayName: 'Kasia', serviceIds: [service.id] },
    }),
  );
  await json(
    await request.put(`${base}/staff/${staff.id}/working-hours`, {
      headers: owner,
      data: {
        days: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
          weekday,
          intervals: [{ start: '00:00', end: '24:00' }],
        })),
      },
    }),
  );

  // Ola did not come yesterday. The salon's protection stays off.
  const yesterday = new Date(Date.now() - 86_400_000);
  yesterday.setUTCMinutes(0, 0, 0);
  const missed = await json<{ id: string; version: number }>(
    await request.post(`${base}/appointments`, {
      headers: owner,
      data: {
        serviceId: service.id,
        staffId: staff.id,
        start: yesterday.toISOString(),
        allowOutsideHours: true,
        alreadyHappened: true,
        customer: { name: 'Ola Nowak', phone: '+48600300400', email: OLA },
      },
    }),
  );
  await json(
    await request.post(`${base}/appointments/${missed.id}/status`, {
      headers: owner,
      data: { version: missed.version, status: 'no_show' },
    }),
  );

  // ── The owner: "Zasady dla klienta" in Ola's card ──────────────────────
  const desk = await browser.newContext({
    locale: 'pl-PL',
    timezoneId: 'Europe/Warsaw',
    extraHTTPHeaders: freshAddress(),
  });
  const cabinet = await desk.newPage();
  await cabinet.goto('/pl/login');
  await cabinet.getByLabel('E-mail').fill(OWNER);
  await cabinet.getByLabel('Hasło').fill(PASSWORD);
  await cabinet.getByRole('button', { name: 'Zaloguj się' }).click();
  await cabinet.waitForURL(/\/pl\/app\/calendar/);
  await cabinet.goto('/pl/app/clients');
  await cabinet.getByRole('button', { name: /Ola Nowak/ }).click();
  const card = cabinet.getByRole('region', { name: 'Ochrona przed odwołaniami' });
  await card.scrollIntoViewIfNeeded();
  const rule = card.getByLabel('Zasady dla klienta');
  await expect(rule).toHaveValue('salon');
  // Task 748 (owner's rule: errors where the action is): a refused rule is said under the list.
  await cabinet.route('**/cancellation-guard/clients/*/rule', (route) =>
    route.fulfill({ status: 429, json: { error: { code: 'RATE_LIMITED', message: 'slow down' } } }),
  );
  await rule.selectOption({ label: 'Najpierw opłata zaległych (w salonie)' });
  await expect(card.locator('.field-error')).toHaveText('Zbyt wiele prób. Odczekaj chwilę.');
  await expect(rule).toHaveAttribute('aria-invalid', 'true');
  await expect(rule).toHaveAccessibleDescription('Zbyt wiele prób. Odczekaj chwilę.');
  await expect(rule).toHaveValue('salon');
  await expect(cabinet.locator('.alert')).toHaveCount(0);
  await shot(cabinet, '748-client-rule-error');
  await cabinet.unrouteAll({ behavior: 'wait' });
  await rule.selectOption({ label: 'Najpierw opłata zaległych (w salonie)' });
  await expect(card.getByText('Zapisano zasady dla klienta.')).toBeVisible();
  await expect(card.locator('.field-error')).toHaveCount(0);
  await expect(card).toContainText('Działają zasady ustawione dla tego klienta.');
  await expect(card).toContainText(/Nieodbyte wizyty: 90,00/);
  await shot(cabinet, 'q9-client-rules-card');
  await desk.close();

  // ── Ola books on her phone ─────────────────────────────────────────────
  const phone = await browser.newContext({
    viewport: PHONE,
    locale: 'pl-PL',
    extraHTTPHeaders: freshAddress(),
  });
  const client = await phone.newPage();
  await client.goto(`/pl/b/${location.slug}`);
  await client.getByRole('button', { name: /Strzyżenie męskie/ }).click();
  await client.getByRole('button', { name: /Kasia/ }).click();
  await expect(client.locator('.times button').first()).toBeVisible();
  await client.locator('.times button').first().click();
  await expect(client.getByText(/Termin czeka na Ciebie/)).toBeVisible();
  await client.getByLabel('Imię i nazwisko').fill('Ola Nowak');
  await client.getByLabel('Telefon').fill('600 300 400');
  await client.getByLabel('E-mail').fill(OLA);
  await client.getByLabel(/Akceptuję regulamin rezerwacji/).check();
  await client.getByRole('button', { name: 'Wyślij kod' }).click();
  const codeMail = await waitForEmail(OLA, /Kod potwierdzenia/);
  await client.getByLabel('Kod z e-maila').fill(/\b(\d{6})\b/.exec(codeMail.text)![1]!);
  await client.getByRole('button', { name: 'Potwierdź wizytę' }).click();

  const notice = client.getByTestId('pay-notice');
  await expect(notice).toContainText('Zapłacisz w salonie za poprzednią i tę wizytę');
  await expect(notice).toContainText(/Nieodbyte wizyty: 90,00/);
  const accept = client.getByRole('button', { name: 'Rozumiem — potwierdź wizytę' });
  await expect(accept).toBeInViewport();
  await shot(client, 'q9-pay-notice');
  await accept.click();
  await expect(client.getByRole('heading', { name: 'Do zobaczenia!' })).toBeVisible();
  await phone.close();
});
