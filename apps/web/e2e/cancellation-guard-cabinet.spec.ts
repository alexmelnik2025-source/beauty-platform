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
 * Task 161c: "Ochrona przed odwołaniami" in the cabinet. Jan missed two visits (entered by the
 * salon via the API); the owner turns the protection on with "2 no-shows → pay first", sees Jan
 * with the cost of the missed visits and lifts the block. Screenshots 161e, 161f.
 */

const PASSWORD = 'e2e-password-123';
const run = Date.now().toString(36);
const OWNER = `guard-cabinet-owner-${run}@example.com`;
const FIVE_MINUTES = 5 * 60_000;

const shot = (page: Page, name: string) =>
  page.screenshot({ path: `e2e/screenshots/${name}.png`, fullPage: true });

async function json<T>(res: APIResponse): Promise<T> {
  expect(res.ok(), `${res.url()} → ${res.status()} ${await res.text()}`).toBeTruthy();
  return (res.status() === 204 ? undefined : await res.json()) as T;
}

async function salonWithMissedVisits(api: APIRequestContext): Promise<void> {
  await json(
    await api.post('/v1/auth/register', {
      headers: freshAddress(),
      data: { email: OWNER, password: PASSWORD, name: 'Aleksander Owner' },
    }),
  );
  const mail = await waitForEmail(OWNER, /Potwierdź adres/);
  const token = /token=([^\s&]+)/.exec(mail.text)?.[1];
  await json(
    await api.post('/v1/auth/verify-email', { data: { token: decodeURIComponent(token!) } }),
  );
  const login = await json<{ accessToken: string }>(
    await api.post('/v1/auth/login', {
      headers: freshAddress(),
      data: { email: OWNER, password: PASSWORD, clientType: 'mobile' },
    }),
  );
  const owner = { Authorization: `Bearer ${login.accessToken}` };
  const org = await json<{ id: string }>(
    await api.post('/v1/organizations', { headers: owner, data: { name: 'Guard Barber' } }),
  );
  const location = await json<{ id: string }>(
    await api.post(`/v1/organizations/${org.id}/locations`, {
      headers: owner,
      data: {
        name: 'Guard Barber',
        addressLine: 'ul. Józefa Bema 91',
        city: 'Warszawa',
        postalCode: '01-233',
      },
    }),
  );
  const base = `/v1/organizations/${org.id}/locations/${location.id}`;
  const service = await json<{ id: string }>(
    await api.post(`${base}/services`, {
      headers: owner,
      data: { name: 'Strzyżenie męskie', durationMinutes: 30, priceGrosze: 9000, bufferMinutes: 0 },
    }),
  );
  const staff = await json<{ id: string }>(
    await api.post(`${base}/staff`, {
      headers: owner,
      data: { displayName: 'Kasia', serviceIds: [service.id] },
    }),
  );
  // Two visits earlier today that Jan did not come to.
  let customerId: string | undefined;
  for (const hoursAgo of [2, 1]) {
    const start = new Date(
      Math.floor((Date.now() - hoursAgo * 3_600_000) / FIVE_MINUTES) * FIVE_MINUTES,
    );
    const visit = await json<{ id: string; version: number; customer: { id: string } }>(
      await api.post(`${base}/appointments`, {
        headers: owner,
        data: {
          serviceId: service.id,
          staffId: staff.id,
          start: start.toISOString(),
          allowOutsideHours: true,
          alreadyHappened: true,
          ...(customerId
            ? { customerId }
            : {
                customer: {
                  name: 'Jan Nowak',
                  phone: '+48600700800',
                  email: `jan-${run}@example.com`,
                },
              }),
        },
      }),
    );
    customerId = visit.customer.id;
    await json(
      await api.post(`${base}/appointments/${visit.id}/status`, {
        headers: owner,
        data: { version: visit.version, status: 'no_show' },
      }),
    );
  }
}

test('the owner turns on cancellation protection and lifts a client’s block', async ({
  browser,
  request,
}) => {
  await salonWithMissedVisits(request);
  // Its own address: the API limits sign-ins per address and the suite signs in many times.
  const desk = await browser.newContext({
    locale: 'pl-PL',
    timezoneId: 'Europe/Warsaw',
    extraHTTPHeaders: freshAddress(),
  });
  const owner = await desk.newPage();
  await owner.goto('/pl/login');
  await owner.getByLabel('E-mail').fill(OWNER);
  await owner.getByLabel('Hasło').fill(PASSWORD);
  await owner.getByRole('button', { name: 'Zaloguj się' }).click();
  await owner.waitForURL(/\/pl\/app\/calendar/);
  await owner.getByRole('link', { name: 'Ochrona przed odwołaniami' }).first().click();
  await expect(owner.getByRole('heading', { name: 'Ochrona przed odwołaniami' })).toBeVisible();
  await expect(owner.getByText('Ochrona jest wyłączona — nikt nie jest oznaczony.')).toBeVisible();

  await owner.getByLabel('Włącz ochronę').check();
  await owner.getByRole('button', { name: 'Zapisz' }).click();
  await expect(owner.getByText('Zaznacz co najmniej jedną zasadę.')).toBeVisible();

  await owner.getByLabel('Nieobecności („Nie przyszedł”)').check();
  await owner.getByLabel('Ile razy').fill('2');
  await owner.getByLabel('Najpierw zapłata za nieodbyte wizyty w salonie').check();
  await owner.getByRole('button', { name: 'Zapisz' }).click();
  await expect(owner.getByText('Zapisano ochronę przed odwołaniami.')).toBeVisible();
  await expect(owner.getByText('Jan Nowak')).toBeVisible();
  await expect(owner.getByText('nieobecności: 2')).toBeVisible();
  await expect(owner.getByText(/Nieodbyte wizyty: 180,00/)).toBeVisible();
  await shot(owner, '161e-owner-cancellation-guard');

  await owner.getByRole('button', { name: 'Zdejmij blokadę: Jan Nowak' }).click();
  const sheet = owner.getByRole('dialog');
  await sheet.getByLabel(/Notatka/).fill('Zapłacił 180 zł');
  await shot(owner, '161f-owner-guard-release');
  await sheet.getByRole('button', { name: 'Tak, zdejmij' }).click();
  await expect(owner.getByText('Zdjęto blokadę.')).toBeVisible();
  await expect(owner.getByText('Nikt nie jest teraz oznaczony.')).toBeVisible();
  await desk.close();
});
