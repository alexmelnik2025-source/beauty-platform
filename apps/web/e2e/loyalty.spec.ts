import {
  expect,
  test,
  type APIRequestContext,
  type APIResponse,
  type Page,
} from '@playwright/test';
import { waitForEmail } from './mailpit';

/**
 * "Program lojalnościowy" in the cabinet (task 10b): the owner sets up a stamp card, adds
 * rewards, points per service, sees the history and cannot switch the type while clients
 * have stamps. Screenshots go to e2e/screenshots (40–43).
 */

const PASSWORD = 'e2e-password-123';
const run = Date.now().toString(36);
const OWNER = `loyalty-owner-${run}@example.com`;
const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1440, height: 900 };

const shot = (page: Page, name: string) => page.screenshot({ path: `e2e/screenshots/${name}.png` });

async function json<T>(res: APIResponse): Promise<T> {
  expect(res.ok(), `${res.url()} → ${res.status()} ${await res.text()}`).toBeTruthy();
  return (res.status() === 204 ? undefined : await res.json()) as T;
}

async function verifiedUser(api: APIRequestContext, email: string, name: string) {
  await json(await api.post('/v1/auth/register', { data: { email, password: PASSWORD, name } }));
  const mail = await waitForEmail(email, /Potwierdź adres/);
  const token = /token=([^\s&]+)/.exec(mail.text)?.[1];
  expect(token, 'verification link').toBeTruthy();
  await json(
    await api.post('/v1/auth/verify-email', { data: { token: decodeURIComponent(token!) } }),
  );
  const login = await json<{ accessToken: string }>(
    await api.post('/v1/auth/login', { data: { email, password: PASSWORD, clientType: 'mobile' } }),
  );
  return { Authorization: `Bearer ${login.accessToken}` };
}

async function signIn(page: Page, email: string) {
  await page.goto('/pl/login');
  await page.getByLabel('E-mail').fill(email);
  await page.getByLabel('Hasło').fill(PASSWORD);
  await page.getByRole('button', { name: 'Zaloguj się' }).click();
  await page.waitForURL(/\/pl\/app\/calendar/);
}

interface Program {
  enabled: boolean;
  mode: string;
  stampsPerVisit: number;
  maxDiscountPercent: number;
  earnRules: { serviceId: string; points: number }[];
  version: number;
}
interface Reward {
  id: string;
  name: string;
  kind: string;
  discountPercent: number | null;
  freeServiceId: string | null;
  cost: number;
  serviceIds: string[];
  couponValidityDays: number | null;
  archivedAt: string | null;
}

test('the owner sets up the loyalty program: stamp card, rewards, service rules, history', async ({
  browser,
  request,
}) => {
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
  const orgBase = `/v1/organizations/${org.id}`;
  const base = `${orgBase}/locations/${location.id}`;
  const services: Record<string, string> = {};
  for (const [name, priceGrosze] of [
    ['Strzyżenie męskie', 9000],
    ['Broda', 6000],
  ] as const) {
    const s = await json<{ id: string }>(
      await request.post(`${base}/services`, {
        headers: owner,
        data: { name, durationMinutes: 45, priceGrosze, bufferMinutes: 0 },
      }),
    );
    services[name] = s.id;
  }

  const context = await browser.newContext({ viewport: DESKTOP, locale: 'pl-PL' });
  const page = await context.newPage();
  await signIn(page, OWNER);
  await page.getByRole('link', { name: 'Program lojalnościowy' }).click();
  await page.waitForURL(/\/pl\/app\/loyalty$/);
  await expect(page.getByRole('heading', { name: 'Program lojalnościowy' })).toBeVisible();
  await expect(page.getByText('Nie ma jeszcze nagród')).toBeVisible();
  await expect(page.getByText('Jeszcze nie ma operacji.')).toBeVisible();

  // ── Settings: a stamp card, 1 stamp per paid visit, at most 50% off ────
  const settings = page.locator('form', {
    has: page.getByRole('heading', { name: 'Ustawienia programu' }),
  });
  await settings.getByLabel('Program włączony').check();
  await settings.getByRole('button', { name: 'Karta pieczątek' }).click();
  await expect(settings.getByRole('button', { name: 'Karta pieczątek' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(settings.getByText('Po odebraniu nagrody karta zaczyna się od nowa')).toBeVisible();
  await settings.getByLabel('Pieczątki za wizytę').fill('1');
  await settings.getByLabel('Minimalna kwota wizyty (zł)').fill('50');
  await settings.getByLabel('Maksymalna zniżka na wizytę (%)').fill('50');
  await settings.getByRole('button', { name: 'Zapisz' }).click();
  await expect(settings.getByText('Zapisano')).toBeVisible();
  const saved = await json<Program & { minSpendGrosze: number }>(
    await request.get(`${orgBase}/loyalty/program`, { headers: owner }),
  );
  expect(saved).toMatchObject({
    enabled: true,
    mode: 'stamps',
    stampsPerVisit: 1,
    minSpendGrosze: 5000,
    maxDiscountPercent: 50,
    version: 1,
  });

  // ── Rewards: −25% on a haircut for 3 stamps, a free beard for 6 ───────
  await page.getByRole('button', { name: '+ Dodaj nagrodę' }).click();
  let sheet = page.getByRole('dialog');
  await sheet.getByLabel('Nazwa nagrody').fill('−25% na strzyżenie');
  await sheet.getByLabel('Zniżka (%)').fill('25');
  await sheet.getByLabel('Cena w pieczątkach').fill('3');
  await sheet.getByLabel('Strzyżenie męskie').check();
  await sheet.getByLabel('Kupon ważny (dni)').fill('30');
  await shot(page, '41-owner-loyalty-reward');
  await sheet.getByRole('button', { name: 'Zapisz' }).click();
  await expect(sheet).toBeHidden();
  await page.getByRole('button', { name: '+ Dodaj nagrodę' }).click();
  sheet = page.getByRole('dialog');
  await sheet.getByLabel('Nazwa nagrody').fill('Broda gratis');
  await sheet.getByLabel('Rodzaj nagrody').selectOption('free_service');
  await sheet.getByLabel('Usługa', { exact: true }).selectOption({ label: 'Broda' });
  await sheet.getByLabel('Cena w pieczątkach').fill('6');
  await sheet.getByRole('button', { name: 'Zapisz' }).click();
  await expect(sheet).toBeHidden();
  const rewardList = page.getByRole('list', { name: 'Nagrody' });
  await expect(rewardList.getByRole('button', { name: /−25% na strzyżenie/ })).toContainText(
    'pieczątki: 3',
  );
  await expect(rewardList.getByRole('button', { name: /Broda gratis/ })).toContainText(
    'Gratis: Broda',
  );
  const rewards = await json<Reward[]>(
    await request.get(`${orgBase}/loyalty/rewards`, { headers: owner }),
  );
  expect(rewards.map((r) => [r.name, r.kind, r.cost])).toEqual([
    ['−25% na strzyżenie', 'discount_percent', 3],
    ['Broda gratis', 'free_service', 6],
  ]);
  expect(rewards[0]).toMatchObject({
    discountPercent: 25,
    serviceIds: [services['Strzyżenie męskie']],
    couponValidityDays: 30,
  });
  expect(rewards[1]!.freeServiceId).toBe(services['Broda']);

  // ── Per service: a beard alone earns no stamp ─────────────────────────
  const rules = page.locator('form', {
    has: page.getByRole('heading', { name: 'Pieczątki i punkty za usługi' }),
  });
  await expect(rules.getByLabel('Broda', { exact: true })).toHaveAttribute('placeholder', '1');
  await rules.getByLabel('Broda', { exact: true }).fill('0');
  await rules.getByRole('button', { name: 'Zapisz zasady usług' }).click();
  await expect(rules.getByText('Zapisano')).toBeVisible();
  const withRules = await json<Program>(
    await request.get(`${orgBase}/loyalty/program`, { headers: owner }),
  );
  expect(withRules.earnRules.map((r) => [r.serviceId, r.points])).toEqual([[services['Broda'], 0]]);
  await page.getByRole('heading', { name: 'Ustawienia programu' }).scrollIntoViewIfNeeded();
  await shot(page, '40-owner-loyalty');

  // ── History: a client brought a paper card with 2 stamps ──────────────
  const customer = await json<{ id: string }>(
    await request.post(`${orgBase}/customers`, {
      headers: owner,
      data: { name: 'Anna Kowalska', phone: '+48600100200' },
    }),
  );
  await json(
    await request.post(`${orgBase}/loyalty/accounts/${customer.id}/adjustments`, {
      headers: owner,
      data: { points: 2, reason: 'Papierowa karta' },
    }),
  );
  await page.reload();
  const history = page.locator('section', {
    has: page.getByRole('heading', { name: 'Historia operacji' }),
  });
  await expect(history.getByText('Anna Kowalska')).toBeVisible();
  await expect(history).toContainText('Ręczna zmiana');
  await expect(history).toContainText('Papierowa karta');
  await expect(history).toContainText('+2');
  await expect(history).toContainText('saldo: 2');
  await history.scrollIntoViewIfNeeded();
  await shot(page, '42-owner-loyalty-history');

  // ── The type can't change while a client has stamps ───────────────────
  await settings.getByRole('button', { name: 'Punkty' }).click();
  await expect(settings.getByLabel('za każde (zł)')).toBeVisible();
  await settings.getByRole('button', { name: 'Zapisz' }).click();
  await expect(page.locator('.alert')).toContainText('Rodzaju programu nie można zmienić');
  expect(
    (await json<Program>(await request.get(`${orgBase}/loyalty/program`, { headers: owner }))).mode,
  ).toBe('stamps');
  await page.reload();

  // ── Removing a reward: gone from the catalogue, still in "removed" ────
  await page
    .getByRole('list', { name: 'Nagrody' })
    .getByRole('button', { name: /Broda gratis/ })
    .click();
  await page.getByRole('dialog').getByRole('button', { name: 'Usuń z katalogu' }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(
    page.getByRole('list', { name: 'Nagrody' }).getByRole('button', { name: /Broda gratis/ }),
  ).toHaveCount(0);
  await page.getByLabel('Pokaż usunięte').check();
  await expect(
    page.getByRole('list', { name: 'Nagrody' }).getByRole('button', { name: /Broda gratis/ }),
  ).toContainText('usunięta');

  // ── The same page on a phone, reached from "More" ─────────────────────
  const phone = await browser.newContext({ viewport: PHONE, locale: 'pl-PL', isMobile: true });
  const mobile = await phone.newPage();
  await signIn(mobile, OWNER);
  await mobile.goto('/pl/app/more');
  await mobile.getByRole('main').getByRole('link', { name: 'Program lojalnościowy' }).click();
  await expect(mobile.getByRole('button', { name: 'Karta pieczątek' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await shot(mobile, '43-owner-loyalty-phone');
  await phone.close();
  await context.close();
});
