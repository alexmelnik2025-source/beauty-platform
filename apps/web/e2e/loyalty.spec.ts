import {
  expect,
  test,
  type APIRequestContext,
  type APIResponse,
  type Page,
} from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { freshAddress } from './addresses';
import { listTo, waitForEmail } from './mailpit';
import { serveApp } from './mobile-app';

/**
 * "Program lojalnościowy" in the cabinet (task 10b): the owner sets up a stamp card, adds
 * rewards, points per service, sees the history and cannot switch the type while clients
 * have stamps; then a visit is marked "came" and "paid" (a stamp), and in the client card the
 * owner exchanges stamps for a coupon, cancels it and corrects the balance by hand (10b, part 2).
 * Finally the client opens "Moje bonusy" in "Moje wizyty" (10c): stamps on the card, how many
 * visits are left, the coupon code — and never the salon's notes. The same "Moje bonusy" in the
 * client app for iPhone and Android (11b, part 3; its web preview).
 * Then the owner uses the client's coupon on the next visit (10d): the price goes down.
 * The client then picks the coupon herself in "Moje wizyty" (10d, part 3).
 * The owner sees the client's stamps and tier in the business app's client card (18b).
 * Screenshots go to e2e/screenshots (40–47, 63–63b, 72–72c, 73b, 78, 79, 693).
 */

const PASSWORD = 'e2e-password-123';
const run = Date.now().toString(36);
const OWNER = `loyalty-owner-${run}@example.com`;
const ANNA = `loyalty-anna-${run}@example.com`;
const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1440, height: 900 };

/**
 * Visits can't be booked in the past, and "came" needs a started visit: the test books one for
 * tomorrow and moves it two days back straight in the e2e database.
 */
function moveToThePast(appointmentId: string) {
  const url = (process.env.DATABASE_URL ?? '').replace(/\?.*$/, '');
  execFileSync('psql', [
    url,
    '-v',
    'ON_ERROR_STOP=1',
    '-c',
    `UPDATE appointment SET start_at = start_at - interval '2 days', end_at = end_at - interval '2 days', blocked_until = blocked_until - interval '2 days' WHERE id = '${appointmentId}'`,
  ]);
}

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
  // Task 693: a number out of range, an empty field and a wrong amount — said under each field.
  const stampsField = settings.getByLabel('Pieczątki za wizytę');
  await stampsField.fill('150');
  await settings.getByLabel('Minimalna kwota wizyty (zł)').fill('5,555');
  await settings.getByLabel('Maksymalna zniżka na wizytę (%)').fill('');
  await settings.getByRole('button', { name: 'Zapisz' }).click();
  await expect(settings.getByText('Wpisz liczbę od 0 do 100.')).toBeVisible();
  await expect(settings.getByText('Wpisz kwotę, np. 150 lub 150,50.')).toBeVisible();
  await expect(settings.getByText('Uzupełnij to pole.')).toBeVisible();
  await expect(stampsField).toHaveAttribute('aria-invalid', 'true');
  await expect(stampsField).toBeFocused();
  await expect(settings.getByText('Zapisano')).toHaveCount(0);
  await shot(page, '693-loyalty-settings-errors');
  await stampsField.fill('1');
  await expect(settings.getByText('Wpisz liczbę od 0 do 100.')).toHaveCount(0);
  await settings.getByLabel('Minimalna kwota wizyty (zł)').fill('50');
  await settings.getByLabel('Maksymalna zniżka na wizytę (%)').fill('50');
  // Task 816 (owner's rule: errors where the action is): a refused save that names no field is
  // said under "Zapisz", not at the top of the page; the typed settings stay.
  const programUrl = (url: URL) => url.pathname.endsWith('/loyalty/program');
  await page.route(programUrl, (route) =>
    route.request().method() === 'PUT'
      ? route.fulfill({
          status: 429,
          json: { error: { code: 'RATE_LIMITED', message: 'slow down' } },
        })
      : route.fallback(),
  );
  const saveProgram = settings.getByRole('button', { name: 'Zapisz' });
  await saveProgram.click();
  await expect(settings.locator('#loyalty-save-error')).toHaveText(
    'Zbyt wiele prób. Odczekaj chwilę.',
  );
  await expect(saveProgram).toHaveAccessibleDescription(/Zbyt wiele prób\. Odczekaj chwilę\.$/);
  await expect(stampsField).toHaveValue('1');
  await expect(page.locator('.page > .alert')).toHaveCount(0);
  await saveProgram.scrollIntoViewIfNeeded();
  await shot(page, '816-loyalty-program-save-error');
  await page.unroute(programUrl);
  await saveProgram.click();
  await expect(settings.locator('#loyalty-save-error')).toHaveCount(0);
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
  // Task 668: a name of only spaces is said under "Nazwa nagrody" (red frame, "!").
  const rewardName = sheet.getByLabel('Nazwa nagrody');
  await rewardName.fill('   ');
  await sheet.getByRole('button', { name: 'Zapisz' }).click();
  await expect(sheet.getByText('Uzupełnij to pole.')).toBeVisible();
  await expect(rewardName).toHaveAttribute('aria-invalid', 'true');
  await shot(page, '668-loyalty-reward-name-error');
  await rewardName.fill('−25% na strzyżenie');
  await expect(sheet.getByText('Uzupełnij to pole.')).toHaveCount(0);
  // Task 693: a percent over 100 and an empty price — under their fields, not the browser's bubble.
  await sheet.getByLabel('Zniżka (%)').fill('150');
  await sheet.getByLabel('Cena w pieczątkach').fill('');
  await sheet.getByRole('button', { name: 'Zapisz' }).click();
  await expect(sheet.getByText('Wpisz liczbę od 1 do 100.')).toBeVisible();
  await expect(sheet.getByText('Wpisz liczbę od 1 do 100000.')).toBeVisible();
  await expect(sheet.getByLabel('Zniżka (%)')).toBeFocused();
  await shot(page, '693-loyalty-reward-number-errors');
  await sheet.getByLabel('Zniżka (%)').fill('25');
  await sheet.getByLabel('Cena w pieczątkach').fill('3');
  await sheet.getByLabel('Strzyżenie męskie').check();
  await sheet.getByLabel('Kupon ważny (dni)').fill('30');
  await shot(page, '41-owner-loyalty-reward');
  // Task 810 (owner's rule: errors where the action is): a refused save is said under "Zapisz" at
  // the bottom of the sheet, not above the form; what was typed stays.
  const rewardsUrl = (url: URL) => url.pathname.endsWith('/loyalty/rewards');
  await page.route(rewardsUrl, (route) =>
    route.request().method() === 'POST'
      ? route.fulfill({
          status: 429,
          json: { error: { code: 'RATE_LIMITED', message: 'slow down' } },
        })
      : route.fallback(),
  );
  const saveReward = sheet.getByRole('button', { name: 'Zapisz' });
  await saveReward.click();
  await expect(sheet.locator('#reward-save-error')).toHaveText('Zbyt wiele prób. Odczekaj chwilę.');
  await expect(saveReward).toHaveAccessibleDescription(/Zbyt wiele prób\. Odczekaj chwilę\.$/);
  await expect(sheet.getByLabel('Zniżka (%)')).toHaveValue('25');
  await expect(sheet.locator('.alert')).toHaveCount(0);
  await saveReward.scrollIntoViewIfNeeded();
  await shot(page, '810-loyalty-reward-save-error');
  await page.unroute(rewardsUrl);
  await saveReward.click();
  await expect(sheet).toBeHidden();
  await page.getByRole('button', { name: '+ Dodaj nagrodę' }).click();
  sheet = page.getByRole('dialog');
  await sheet.getByLabel('Nazwa nagrody').fill('Broda gratis');
  await sheet.getByLabel('Rodzaj nagrody').selectOption('free_service');
  await sheet.getByRole('combobox', { name: /^Usługa/ }).selectOption({ label: 'Broda' });
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
  // Task 810: a refused "Usuń z katalogu" is said under that button; the sheet stays open.
  await rewardList.getByRole('button', { name: /Broda gratis/ }).click();
  sheet = page.getByRole('dialog');
  const rewardUrl = (url: URL) => /\/loyalty\/rewards\/[^/]+$/.test(url.pathname);
  await page.route(rewardUrl, (route) =>
    route.request().method() === 'DELETE'
      ? route.fulfill({
          status: 429,
          json: { error: { code: 'RATE_LIMITED', message: 'slow down' } },
        })
      : route.fallback(),
  );
  const archiveReward = sheet.getByRole('button', { name: 'Usuń z katalogu' });
  await archiveReward.click();
  await expect(sheet.locator('#reward-archive-error')).toHaveText(
    'Zbyt wiele prób. Odczekaj chwilę.',
  );
  await expect(archiveReward).toHaveAccessibleDescription(/Zbyt wiele prób\. Odczekaj chwilę\.$/);
  await expect(sheet.locator('#reward-save-error')).toHaveCount(0);
  await archiveReward.scrollIntoViewIfNeeded();
  await shot(page, '810-loyalty-reward-archive-error');
  await page.unroute(rewardUrl);
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();
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
  // Task 693: a fraction of a stamp is said under the service's field.
  await rules.getByLabel('Broda', { exact: true }).fill('2.5');
  await rules.getByRole('button', { name: 'Zapisz zasady usług' }).click();
  await expect(rules.getByText(/Wpisz liczbę od 0 do 100\s000\./)).toBeVisible();
  await expect(rules.getByLabel('Broda', { exact: true })).toHaveAttribute('aria-invalid', 'true');
  await expect(rules.getByText('Zapisano')).toHaveCount(0);
  await rules.getByLabel('Broda', { exact: true }).fill('0');
  await expect(rules.getByText(/Wpisz liczbę od 0 do 100\s000\./)).toHaveCount(0);
  // Task 795 (owner's rule: errors where the action is): a refused save is said under "Zapisz zasady
  // usług" at the bottom of the list, not at the top of the page; the typed points stay.
  const earnRulesUrl = (url: URL) => url.pathname.endsWith('/loyalty/earn-rules');
  await page.route(earnRulesUrl, (route) =>
    route.fulfill({ status: 429, json: { error: { code: 'RATE_LIMITED', message: 'slow down' } } }),
  );
  const saveRules = rules.getByRole('button', { name: 'Zapisz zasady usług' });
  await saveRules.click();
  await expect(rules.locator('#loyalty-rules-error')).toHaveText(
    'Zbyt wiele prób. Odczekaj chwilę.',
  );
  await expect(saveRules).toHaveAccessibleDescription(/Zbyt wiele prób\. Odczekaj chwilę\.$/);
  await expect(rules.getByLabel('Broda', { exact: true })).toHaveValue('0');
  await expect(page.locator('.alert', { hasText: 'Zbyt wiele prób' })).toHaveCount(0);
  await saveRules.scrollIntoViewIfNeeded();
  await shot(page, '795-loyalty-rules-error');
  await page.unroute(earnRulesUrl);
  await saveRules.click();
  await expect(rules.getByText('Zapisano')).toBeVisible();
  await expect(rules.locator('#loyalty-rules-error')).toHaveCount(0);
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
      data: { name: 'Anna Kowalska', phone: '+48600100200', email: ANNA },
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

  // ── A visit: "came" → "paid" earns a stamp (10b, part 2) ──────────────
  const staff = await json<{ id: string }>(
    await request.post(`${base}/staff`, {
      headers: owner,
      data: { displayName: 'Kasia', serviceIds: Object.values(services) },
    }),
  );
  const tomorrow = Math.ceil((Date.now() + 86_400_000) / 300_000) * 300_000;
  const booked = await json<{ id: string }>(
    await request.post(`${base}/appointments`, {
      headers: owner,
      data: {
        serviceId: services['Strzyżenie męskie'],
        staffId: staff.id,
        start: new Date(tomorrow).toISOString(),
        customerId: customer.id,
        allowOutsideHours: true,
      },
    }),
  );
  moveToThePast(booked.id);
  const visit = await json<{ date: string }>(
    await request.get(`${base}/appointments/${booked.id}`, { headers: owner }),
  );
  await page.goto(`/pl/app/calendar?date=${visit.date}`);
  await page.getByRole('button', { name: /Anna Kowalska/ }).click();
  const card = page.getByRole('dialog');
  await card.getByRole('button', { name: 'Przyszedł', exact: true }).click();
  await expect(card.getByText('Za opłaconą wizytę klient dostaje pieczątki')).toBeVisible();
  await card.getByRole('button', { name: 'Opłacono', exact: true }).click();
  await expect(card.getByRole('button', { name: 'Cofnij opłatę (zwrot)' })).toBeVisible();
  await expect(card.getByText('✓ Opłacono')).toBeVisible();
  await shot(page, '44-owner-visit-paid');
  const afterVisit = await json<{ balance: number; lifetimeEarned: number }>(
    await request.get(`${orgBase}/loyalty/accounts/${customer.id}`, { headers: owner }),
  );
  expect([afterVisit.balance, afterVisit.lifetimeEarned]).toEqual([3, 1]);
  await page.keyboard.press('Escape');

  // ── Client tiers (10e): Standard from 0 visits, Silver from 1 with −5% ─
  await page.goto('/pl/app/loyalty');
  const tiersForm = page.locator('form', {
    has: page.getByRole('heading', { name: 'Poziomy klientów' }),
  });
  await expect(tiersForm.getByText('Brak poziomów')).toBeVisible();
  await tiersForm.getByRole('button', { name: '+ Dodaj poziom' }).click();
  await tiersForm.getByLabel('Nazwa poziomu').nth(0).fill('Standard');
  await tiersForm.getByLabel('Od (wizyt)').nth(0).fill('0');
  await tiersForm.getByRole('button', { name: '+ Dodaj poziom' }).click();
  await tiersForm.getByLabel('Nazwa poziomu').nth(1).fill('Silver');
  await tiersForm.getByLabel('Od (wizyt)').nth(1).fill('1');
  // Task 697: a period too short and a discount over 100 — said under the fields, not in the
  // browser's bubble; the cursor goes to the period, the first on screen.
  const period = tiersForm.locator('#tier-period');
  await period.fill('10');
  await tiersForm.getByLabel('Rabat (%)').nth(1).fill('150');
  await tiersForm.getByRole('button', { name: 'Zapisz poziomy' }).click();
  await expect(tiersForm.locator('#tier-period-error')).toHaveText('Wpisz liczbę od 30 do 1095.');
  await expect(tiersForm.locator('#tier-1-discountPercent-error')).toHaveText(
    'Wpisz liczbę od 0 do 100.',
  );
  await expect(period).toBeFocused();
  await tiersForm.scrollIntoViewIfNeeded();
  await shot(page, '697-loyalty-tier-number-errors');
  await period.fill('365');
  await tiersForm.locator('#tier-1-discountPercent').fill('5');
  await expect(tiersForm.locator('.field-error')).toHaveCount(0);
  // Task 664 (errors at the field): the same threshold twice is said under the second one;
  // nothing is saved until it is changed.
  const silverFrom = tiersForm.getByLabel(/^Od \(wizyt\)/).nth(1);
  await silverFrom.fill('0');
  await tiersForm.getByRole('button', { name: 'Zapisz poziomy' }).click();
  await expect(tiersForm.locator('#tier-1-threshold-error')).toHaveText(
    'Inny poziom ma już ten próg.',
  );
  await expect(silverFrom).toBeFocused();
  await expect(silverFrom).toHaveAttribute('aria-invalid', 'true');
  await tiersForm.scrollIntoViewIfNeeded();
  await shot(page, '664-loyalty-tier-threshold-error');
  await silverFrom.fill('1');
  await expect(tiersForm.locator('#tier-1-threshold-error')).toHaveCount(0);
  // Task 810: a refused save is said under "Zapisz poziomy", not at the top of the form.
  const tiersUrl = (url: URL) => url.pathname.endsWith('/loyalty/tiers');
  await page.route(tiersUrl, (route) =>
    route.request().method() === 'PUT'
      ? route.fulfill({
          status: 429,
          json: { error: { code: 'RATE_LIMITED', message: 'slow down' } },
        })
      : route.fallback(),
  );
  const saveTiers = tiersForm.getByRole('button', { name: 'Zapisz poziomy' });
  await saveTiers.click();
  await expect(tiersForm.locator('#tier-save-error')).toHaveText(
    'Zbyt wiele prób. Odczekaj chwilę.',
  );
  await expect(saveTiers).toHaveAccessibleDescription(/Zbyt wiele prób\. Odczekaj chwilę\.$/);
  await expect(tiersForm.locator('.alert')).toHaveCount(0);
  await saveTiers.scrollIntoViewIfNeeded();
  await shot(page, '810-loyalty-tiers-save-error');
  await page.unroute(tiersUrl);
  await saveTiers.click();
  await expect(tiersForm.getByText('Zapisano')).toBeVisible();
  await expect(tiersForm.locator('#tier-save-error')).toHaveCount(0);
  await tiersForm.scrollIntoViewIfNeeded();
  await shot(page, '73-owner-loyalty-tiers');
  const tiers = await json<{ tiers: { name: string; threshold: number }[] }>(
    await request.get(`${orgBase}/loyalty/tiers`, { headers: owner }),
  );
  expect(tiers.tiers.map((t) => [t.name, t.threshold])).toEqual([
    ['Standard', 0],
    ['Silver', 1],
  ]);

  // ── Bonus rules (19): ×2 on Monday–Wednesday, the best rule per visit ──
  const bonusForm = page.locator('form', {
    has: page.getByRole('heading', { name: 'Dodatkowe pieczątki i punkty' }),
  });
  await expect(bonusForm.getByText('Brak zasad')).toBeVisible();
  await bonusForm.getByRole('button', { name: '+ Dodaj zasadę' }).click();
  // Task 671: a blank name and a rule that gives nothing extra are said under their fields.
  await bonusForm.getByLabel('Mnożnik (×)').fill('1');
  await bonusForm.getByRole('button', { name: 'Zapisz zasady' }).click();
  await expect(bonusForm.getByLabel('Nazwa zasady')).toBeFocused();
  await expect(bonusForm.getByLabel('Nazwa zasady')).toHaveAccessibleDescription(
    /Uzupełnij to pole\.$/,
  );
  await expect(bonusForm.getByLabel('Mnożnik (×)')).toHaveAccessibleDescription(
    /Ustaw mnożnik powyżej 1 lub dodatkowe punkty\.$/,
  );
  await bonusForm.scrollIntoViewIfNeeded();
  await shot(page, '671-loyalty-bonus-field-errors');
  await bonusForm.getByLabel('Nazwa zasady').fill('Spokojne dni ×2');
  await bonusForm.getByLabel('Mnożnik (×)').fill('2');
  await expect(bonusForm.locator('.field-error')).toHaveCount(0);
  await bonusForm.getByLabel('Gdy wraca w ciągu (dni)').fill('21');
  for (const day of ['Poniedziałek', 'Wtorek', 'Środa']) {
    await bonusForm.getByLabel(day, { exact: true }).check();
  }
  // Task 813 (owner's rule: errors where the action is): a refused save is said under
  // "Zapisz zasady", not at the top of the form; the typed rule stays.
  const bonusUrl = (url: URL) => url.pathname.endsWith('/loyalty/bonus-rules');
  await page.route(bonusUrl, (route) =>
    route.request().method() === 'PUT'
      ? route.fulfill({
          status: 429,
          json: { error: { code: 'RATE_LIMITED', message: 'slow down' } },
        })
      : route.fallback(),
  );
  const saveBonus = bonusForm.getByRole('button', { name: 'Zapisz zasady' });
  await saveBonus.click();
  await expect(bonusForm.locator('#bonus-save-error')).toHaveText(
    'Zbyt wiele prób. Odczekaj chwilę.',
  );
  await expect(saveBonus).toHaveAccessibleDescription(/Zbyt wiele prób\. Odczekaj chwilę\.$/);
  await expect(bonusForm.getByLabel('Nazwa zasady')).toHaveValue('Spokojne dni ×2');
  await expect(bonusForm.locator('.alert')).toHaveCount(0);
  await saveBonus.scrollIntoViewIfNeeded();
  await shot(page, '813-loyalty-bonus-save-error');
  await page.unroute(bonusUrl);
  await saveBonus.click();
  await expect(bonusForm.locator('#bonus-save-error')).toHaveCount(0);
  await expect(bonusForm.getByText('Zapisano')).toBeVisible();
  await bonusForm.scrollIntoViewIfNeeded();
  await shot(page, '79-owner-loyalty-bonus-rules');
  const bonusSaved = await json<{
    rules: { name: string; weekdays: number[]; multiplier: number; withinDays: number | null }[];
  }>(await request.get(`${orgBase}/loyalty/bonus-rules`, { headers: owner }));
  expect(bonusSaved.rules.map((r) => [r.name, r.weekdays, r.multiplier, r.withinDays])).toEqual([
    ['Spokojne dni ×2', [1, 2, 3], 2, 21],
  ]);
  // The rule stays: the client sees it in “Moje bonusy” (no visit is paid after this).

  // ── Client card: exchange for a coupon, cancel it, correct by hand ────
  await page.goto('/pl/app/clients');
  await page.getByRole('button', { name: /Anna Kowalska/ }).click();
  const client = page.getByRole('dialog');
  await expect(client.getByText('Pieczątki na karcie: 3')).toBeVisible();
  await expect(client.getByText('Łącznie zebrane: 1')).toBeVisible();
  // One paid visit: already Silver (10e).
  await expect(client.getByText('Poziom: Silver · −5%')).toBeVisible();
  await client.getByRole('button', { name: 'Wymień: −25% na strzyżenie' }).click();
  await expect(client.getByText(/Kupon [A-Z0-9]{4}-[A-Z0-9]{4} jest gotowy\./)).toBeVisible();
  await expect(client.getByText('Pieczątki na karcie: 0')).toBeVisible();
  const coupons = client.getByRole('list', { name: 'Kupony' });
  await expect(coupons).toContainText('−25% na strzyżenie');
  await expect(coupons).toContainText('aktywny');
  await expect(coupons).toContainText('ważny do');
  await expect(client.getByRole('button', { name: 'Wymień: −25% na strzyżenie' })).toBeDisabled();
  await client.getByRole('heading', { name: 'Bonusy' }).scrollIntoViewIfNeeded();
  await shot(page, '45-owner-client-bonus');
  // Task 763 (owner's rule: errors where the action is): a refused "Anuluj kupon" is said under
  // that coupon, not at the top of "Bonusy".
  await page.route('**/loyalty/coupons/*/cancel', (route) =>
    route.fulfill({ status: 429, json: { error: { code: 'RATE_LIMITED', message: 'slow down' } } }),
  );
  const cancelCoupon = coupons.getByRole('button', { name: /Anuluj kupon/ });
  await cancelCoupon.click();
  await expect(
    coupons
      .getByRole('listitem')
      .filter({ has: page.getByRole('button', { name: /Anuluj kupon/ }) })
      .locator('.field-error'),
  ).toHaveText('Zbyt wiele prób. Odczekaj chwilę.');
  await expect(cancelCoupon).toHaveAccessibleDescription(/Zbyt wiele prób\. Odczekaj chwilę\.$/);
  await expect(client.locator('.alert')).toHaveCount(0);
  await coupons.scrollIntoViewIfNeeded();
  await shot(page, '763-client-coupon-cancel-error');
  await page.unrouteAll({ behavior: 'wait' });
  await cancelCoupon.click();
  await expect(coupons).toContainText('anulowany');
  await expect(client.locator('.field-error')).toHaveCount(0);
  await expect(client.getByText('Pieczątki na karcie: 3')).toBeVisible();
  // Task 692: nothing typed, then zero and a too short reason — said under each field.
  const adjustPoints = client.locator('input[name="points"]');
  const adjustReason = client.locator('input[name="reason"]');
  await client.getByRole('button', { name: 'Zapisz zmianę' }).click();
  await expect(adjustPoints).toHaveAttribute('aria-invalid', 'true');
  await expect(adjustPoints).toBeFocused();
  await expect(adjustReason).toHaveAttribute('aria-invalid', 'true');
  await adjustPoints.fill('0');
  await adjustReason.fill('ok');
  await client.getByRole('button', { name: 'Zapisz zmianę' }).click();
  await expect(client.getByText('Wpisz liczbę od −100 000 do 100 000, inną niż 0.')).toBeVisible();
  await expect(client.getByText('Napisz powód — co najmniej 3 znaki.')).toBeVisible();
  await adjustPoints.scrollIntoViewIfNeeded();
  await shot(page, '692-loyalty-adjust-errors');
  await adjustPoints.fill('-1');
  await adjustReason.fill('Pomyłka przy karcie');
  await client.getByRole('button', { name: 'Zapisz zmianę' }).click();
  await expect(client.getByText('Pieczątki na karcie: 2')).toBeVisible();
  await expect(client).toContainText('Pomyłka przy karcie');
  const finalAccount = await json<{ balance: number; coupons: { status: string }[] }>(
    await request.get(`${orgBase}/loyalty/accounts/${customer.id}`, { headers: owner }),
  );
  expect(finalAccount.balance).toBe(2);
  expect(finalAccount.coupons.map((c) => c.status)).toEqual(['cancelled']);
  await page.keyboard.press('Escape');

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

  // ── The client: "Moje bonusy" in "Moje wizyty" (10c) ──────────────────
  const annaPhone = await browser.newContext({ viewport: PHONE, locale: 'pl-PL', isMobile: true });
  const anna = await annaPhone.newPage();
  await anna.goto('/pl/c');
  await anna.getByLabel('E-mail').fill(ANNA);
  await anna.getByRole('button', { name: 'Wyślij kod' }).click();
  const loginMail = await waitForEmail(ANNA, /Kod logowania/);
  await anna.getByLabel('Kod z e-maila').fill(/\b(\d{6})\b/.exec(loginMail.text)![1]!);
  await anna.getByRole('button', { name: 'Zaloguj się' }).click();
  await anna.getByRole('button', { name: 'Moje bonusy' }).click();
  const bonus = anna.locator('section.bonus-card');
  await expect(bonus.getByRole('heading', { level: 2 })).toBeVisible();
  await expect(bonus.getByText('Pieczątki na karcie: 2')).toBeVisible();
  // The tier the salon set (10e).
  await expect(bonus.getByText('Twój poziom: Silver')).toBeVisible();
  await expect(bonus).toContainText('To najwyższy poziom w tym salonie');
  await expect(bonus.getByText('Do „−25% na strzyżenie” zostało wizyt: 1')).toBeVisible();
  await expect(bonus.getByRole('list', { name: 'Zebrane: 2 z 3' })).toBeVisible();
  // The removed reward is not offered; the salon's reasons are never shown to the client.
  await expect(bonus).not.toContainText('Broda gratis');
  // The salon's bonus rule (19): Monday–Wednesday ×2 when back within 21 days.
  const extras = bonus.getByRole('list', { name: /^Więcej za wizytę/ });
  await expect(extras).toContainText('Spokojne dni ×2');
  await expect(extras).toContainText('gdy wracasz w ciągu 21 dni');
  await expect(extras).toContainText('×2');
  await bonus.getByText('Historia').click();
  await expect(bonus).toContainText('Ręczna zmiana');
  await expect(bonus).not.toContainText('Pomyłka przy karcie');
  await expect(bonus).not.toContainText('Papierowa karta');
  await shot(anna, '46-client-bonuses');

  // A stamp more by the salon and an exchange: the client sees the coupon code to show.
  await json(
    await request.post(`${orgBase}/loyalty/accounts/${customer.id}/adjustments`, {
      headers: owner,
      data: { points: 1, reason: 'Wizyta przed programem' },
    }),
  );
  const coupon = await json<{ id: string; code: string }>(
    await request.post(`${orgBase}/loyalty/accounts/${customer.id}/redemptions`, {
      headers: owner,
      data: { rewardId: rewards[0]!.id },
    }),
  );
  await anna.reload();
  await anna.getByRole('button', { name: 'Moje bonusy' }).click();
  const myCoupons = anna.getByRole('list', { name: 'Moje kupony' });
  await expect(myCoupons).toContainText(coupon.code);
  await expect(myCoupons).toContainText('aktywny');
  await expect(myCoupons).toContainText('tylko: Strzyżenie męskie');
  await expect(anna.getByText('Pieczątki na karcie: 0')).toBeVisible();
  await myCoupons.scrollIntoViewIfNeeded();
  await shot(anna, '47-client-bonus-coupon');
  await annaPhone.close();

  // ── The client app (11b, part 3): the same card, coupon and history ───
  await json(
    await request.post(`${orgBase}/loyalty/accounts/${customer.id}/adjustments`, {
      headers: owner,
      data: { points: 2, reason: 'Karta z Booksy' },
    }),
  );
  const clientApp = await serveApp('mobile-client');
  const appContext = await browser.newContext({ viewport: PHONE, locale: 'pl-PL', isMobile: true });
  try {
    const app = await appContext.newPage();
    await app.goto(clientApp.url);
    await app.getByLabel('E-mail', { exact: true }).fill(ANNA);
    const loginCode = /Kod logowania/;
    const codesBefore = (await listTo(ANNA)).filter((m) => loginCode.test(m.Subject)).length;
    await app.getByRole('button', { name: 'Wyślij kod' }).click();
    // Wait for the new code, not the one the web sign-in above used.
    await expect
      .poll(async () => (await listTo(ANNA)).filter((m) => loginCode.test(m.Subject)).length)
      .toBeGreaterThan(codesBefore);
    const appMail = await waitForEmail(ANNA, loginCode);
    await app.getByLabel('Kod z e-maila').fill(/\b(\d{6})\b/.exec(appMail.text)![1]!);
    await app.getByRole('button', { name: 'Zaloguj się' }).click();
    await expect(app.getByText(`Zalogowano jako ${ANNA}`)).toBeVisible();
    await app.getByRole('tab', { name: 'Moje bonusy' }).click();
    await expect(app.getByRole('tab', { name: 'Moje bonusy', selected: true })).toBeVisible();
    const appCard = app.getByRole('region').first();
    await expect(appCard.getByRole('heading', { level: 2 })).toBeVisible();
    await expect(appCard.getByText('Pieczątki na karcie: 2')).toBeVisible();
    await expect(appCard.getByText('Twój poziom: Silver')).toBeVisible();
    await expect(appCard.getByText('Do „−25% na strzyżenie” zostało wizyt: 1')).toBeVisible();
    await expect(appCard.getByRole('list', { name: 'Zebrane: 2 z 3' })).toBeVisible();
    await expect(appCard.getByRole('list', { name: 'Moje kupony' })).toContainText(coupon.code);
    await expect(appCard).not.toContainText('Broda gratis');
    await expect(appCard.getByRole('list', { name: /^Więcej za wizytę/ })).toContainText(
      'Spokojne dni ×2',
    );
    await shot(app, '63-client-app-bonuses');
    // History on request; the salon's reasons are never shown to the client.
    await appCard.getByRole('button', { name: 'Pokaż historię' }).click();
    const appHistory = appCard.getByRole('list', { name: 'Historia' });
    await expect(appHistory).toContainText('Ręczna zmiana');
    await expect(appHistory).toContainText('Wymiana na nagrodę');
    await expect(appCard).not.toContainText('Karta z Booksy');
    await expect(appCard).not.toContainText('Pomyłka przy karcie');
    await appCard.getByRole('list', { name: 'Moje kupony' }).scrollIntoViewIfNeeded();
    await shot(app, '63a-client-app-bonus-history');
    // In Ukrainian too.
    await app.getByRole('button', { name: 'Język', exact: true }).click();
    await app.getByRole('button', { name: 'UA · Українська' }).click();
    await expect(app.getByRole('tab', { name: 'Мої бонуси', selected: true })).toBeVisible();
    await expect(appCard.getByText('Штампів на картці: 2')).toBeVisible();
    await app.getByRole('tab', { name: 'Мої бонуси' }).scrollIntoViewIfNeeded();
    await shot(app, '63b-client-app-bonuses-uk');
  } finally {
    await appContext.close();
    clientApp.server.close();
  }

  // ── The coupon on the next visit (10d): the price goes down ───────────
  const next = await json<{ id: string; date: string }>(
    await request.post(`${base}/appointments`, {
      headers: owner,
      data: {
        serviceId: services['Strzyżenie męskie'],
        staffId: staff.id,
        start: new Date(tomorrow + 2 * 3_600_000).toISOString(),
        customerId: customer.id,
        allowOutsideHours: true,
      },
    }),
  );
  await page.goto(`/pl/app/calendar?date=${next.date}`);
  await page.getByRole('button', { name: /Anna Kowalska/ }).click();
  const nextCard = page.getByRole('dialog');
  const offered = nextCard.getByRole('list', { name: 'Kupony klienta' });
  await expect(offered).toContainText(coupon.code);
  await offered.getByRole('button', { name: /Użyj −22,50/ }).click();
  await expect(offered.getByRole('button', { name: 'Zdejmij' })).toBeVisible();
  await expect(nextCard.getByText('Do zapłaty')).toBeVisible();
  await expect(nextCard).toContainText('67,50');
  await expect(nextCard).toContainText('Użyto kuponu');
  await shot(page, '72-owner-visit-coupon');
  const used = await json<{ discountGrosze: number; coupons: { code: string }[] }>(
    await request.get(`${base}/appointments/${next.id}`, { headers: owner }),
  );
  expect(used.discountGrosze).toBe(2250);
  expect(used.coupons.map((c) => c.code)).toEqual([coupon.code]);

  // ── The client picks the coupon herself in "Moje wizyty" (10d, part 3) ─
  const usedVisit = await json<{ version: number }>(
    await request.get(`${base}/appointments/${next.id}`, { headers: owner }),
  );
  await json(
    await request.post(`${base}/appointments/${next.id}/coupons/${coupon.id}/remove`, {
      headers: owner,
      data: { version: usedVisit.version },
    }),
  );
  const annaWeb = await browser.newContext({ viewport: PHONE, locale: 'pl-PL', isMobile: true });
  const annaPage = await annaWeb.newPage();
  await annaPage.goto('/pl/c');
  await annaPage.getByLabel('E-mail').fill(ANNA);
  const loginSubject = /Kod logowania/;
  const sentBefore = (await listTo(ANNA)).filter((m) => loginSubject.test(m.Subject)).length;
  await annaPage.getByRole('button', { name: 'Wyślij kod' }).click();
  await expect
    .poll(async () => (await listTo(ANNA)).filter((m) => loginSubject.test(m.Subject)).length)
    .toBeGreaterThan(sentBefore);
  const webCode = await waitForEmail(ANNA, loginSubject);
  await annaPage.getByLabel('Kod z e-maila').fill(/\b(\d{6})\b/.exec(webCode.text)![1]!);
  await annaPage.getByRole('button', { name: 'Zaloguj się' }).click();
  await expect(annaPage.getByRole('button', { name: 'Moje bonusy' })).toBeVisible();
  await annaPage.goto(`/pl/c/${next.id}`);
  const myVisitCoupons = annaPage.getByRole('region', { name: 'Moje kupony' });
  // Task 758 (owner's rule: errors where the action is): a refused "Użyj" is said under that
  // coupon, not above the coupons.
  await annaPage.route(`**/v1/client/appointments/${next.id}/coupons`, (route) =>
    route.request().method() === 'POST'
      ? route.fulfill({
          status: 429,
          json: { error: { code: 'RATE_LIMITED', message: 'slow down' } },
        })
      : route.fallback(),
  );
  const useCoupon = myVisitCoupons.getByRole('button', { name: /Użyj −22,50/ });
  await useCoupon.click();
  const couponRow = myVisitCoupons
    .getByRole('listitem')
    .filter({ has: annaPage.getByRole('button', { name: /Użyj −22,50/ }) });
  await expect(couponRow.locator('.field-error')).toHaveText('Zbyt wiele prób. Odczekaj chwilę.');
  await expect(useCoupon).toHaveAccessibleDescription(/Zbyt wiele prób\. Odczekaj chwilę\.$/);
  await expect(myVisitCoupons.locator('.alert')).toHaveCount(0);
  await couponRow.scrollIntoViewIfNeeded();
  await shot(annaPage, '758-client-coupon-error');
  await annaPage.unrouteAll({ behavior: 'wait' });
  await useCoupon.click();
  await expect(myVisitCoupons.locator('.field-error')).toHaveCount(0);
  await expect(myVisitCoupons).toContainText('Do zapłaty: 67,50');
  await expect(myVisitCoupons.getByRole('button', { name: 'Nie używaj' })).toBeVisible();
  await myVisitCoupons.scrollIntoViewIfNeeded();
  await shot(annaPage, '72b-client-visit-coupon');
  await annaWeb.close();
  const byClient = await json<{
    discountGrosze: number;
    history: { type: string; actor: string }[];
  }>(await request.get(`${base}/appointments/${next.id}`, { headers: owner }));
  expect(byClient.discountGrosze).toBe(2250);
  expect(byClient.history.at(-1)).toMatchObject({ type: 'coupon_applied', actor: 'customer' });

  // ── The same in the client app's visit card (10d, part 3c) ────────────
  const couponApp = await serveApp('mobile-client');
  const couponContext = await browser.newContext({
    viewport: PHONE,
    locale: 'pl-PL',
    isMobile: true,
  });
  try {
    const app = await couponContext.newPage();
    await app.goto(couponApp.url);
    await app.getByLabel('E-mail', { exact: true }).fill(ANNA);
    const codesSent = (await listTo(ANNA)).filter((m) => loginSubject.test(m.Subject)).length;
    await app.getByRole('button', { name: 'Wyślij kod' }).click();
    await expect
      .poll(async () => (await listTo(ANNA)).filter((m) => loginSubject.test(m.Subject)).length)
      .toBeGreaterThan(codesSent);
    const appCode = await waitForEmail(ANNA, loginSubject);
    await app.getByLabel('Kod z e-maila').fill(/\b(\d{6})\b/.exec(appCode.text)![1]!);
    await app.getByRole('button', { name: 'Zaloguj się' }).click();
    await app
      .getByRole('button', { name: /Strzyżenie męskie, Gestalt Barbershop/ })
      .first()
      .click();
    const appCoupons = app.getByRole('region', { name: 'Moje kupony' });
    await expect(appCoupons).toContainText('−25% na strzyżenie');
    await expect(app.getByText('Do zapłaty')).toBeVisible();
    await appCoupons.getByRole('button', { name: 'Nie używaj' }).click();
    await expect(app.getByText('Do zapłaty')).toHaveCount(0);
    await appCoupons.getByRole('button', { name: /Użyj −22,50/ }).click();
    await expect(app.getByText('Do zapłaty')).toBeVisible();
    await expect(app.getByText(/67,50/)).toBeVisible();
    await shot(app, '72c-client-app-visit-coupon');
  } finally {
    await couponContext.close();
    couponApp.server.close();
  }

  // ── The client's tier discount on a visit (10e, part 3): Silver −5% ───
  const tierVisit = await json<{ id: string; date: string }>(
    await request.post(`${base}/appointments`, {
      headers: owner,
      data: {
        serviceId: services['Strzyżenie męskie'],
        staffId: staff.id,
        start: new Date(tomorrow + 4 * 3_600_000).toISOString(),
        customerId: customer.id,
        allowOutsideHours: true,
      },
    }),
  );
  await page.goto(`/pl/app/calendar?date=${tierVisit.date}`);
  await page
    .getByRole('button', { name: /Anna Kowalska/ })
    .last()
    .click();
  const tierCard = page.getByRole('dialog');
  const tierOffer = tierCard.getByRole('list', { name: 'Kupony klienta' });
  await expect(tierOffer).toContainText('Poziom klienta: Silver · −5%');
  await tierOffer.getByRole('button', { name: /Użyj −4,50/ }).click();
  await expect(tierCard.getByText('Rabat poziomu')).toBeVisible();
  await expect(tierCard).toContainText('Silver · −5%');
  await expect(tierCard.getByText('Do zapłaty')).toBeVisible();
  await expect(tierCard).toContainText('85,50');
  await expect(tierCard).toContainText('Użyto rabatu poziomu');
  await expect(tierOffer.getByRole('button', { name: 'Zdejmij' }).first()).toBeVisible();
  await tierCard.getByText('Rabat poziomu').scrollIntoViewIfNeeded();
  await shot(page, '73b-owner-visit-tier-discount');
  const tiered = await json<{ discountGrosze: number; tierDiscount: { name: string } | null }>(
    await request.get(`${base}/appointments/${tierVisit.id}`, { headers: owner }),
  );
  expect(tiered.discountGrosze).toBe(450);
  expect(tiered.tierDiscount?.name).toBe('Silver');
  await page.keyboard.press('Escape');

  // ── The owner's business app: the client card shows stamps and the tier (18b) ──
  const businessApp = await serveApp('mobile-business');
  const businessContext = await browser.newContext({
    viewport: PHONE,
    locale: 'pl-PL',
    isMobile: true,
  });
  try {
    const app = await businessContext.newPage();
    await app.goto(businessApp.url);
    await app.getByLabel('E-mail lub telefon').fill(OWNER);
    await app.getByRole('button', { name: 'Wyślij kod' }).click();
    await expect(app.getByText(`Wysłaliśmy 6-cyfrowy kod na ${OWNER}.`)).toBeVisible();
    const ownerCode = await waitForEmail(OWNER, /Kod logowania do aplikacji salonu/);
    await app.getByLabel('Kod', { exact: true }).fill(/\b(\d{6})\b/.exec(ownerCode.text)![1]!);
    await app.getByRole('button', { name: 'Zaloguj się' }).click();
    await app.getByRole('tab', { name: 'Klienci', exact: true }).click();
    await app.getByLabel('Szukaj: imię, telefon, e-mail lub tag').fill('Anna');
    await app.getByRole('button', { name: 'Szukaj', exact: true }).click();
    await app.getByRole('button', { name: 'Karta klienta: Anna Kowalska', exact: true }).click();
    await expect(app.getByRole('heading', { name: 'Anna Kowalska' })).toBeVisible();
    await expect(app.getByText('Program lojalnościowy')).toBeVisible();
    await expect(app.getByText(/^Pieczątki: \d+$/)).toBeVisible();
    await expect(app.getByText('Poziom: Silver · −5%')).toBeVisible();
    await shot(app, '78-business-app-client-bonuses');
  } finally {
    await businessContext.close();
    businessApp.server.close();
  }
  await context.close();
});
