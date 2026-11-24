import { expect, test, type APIResponse, type Locator, type Page } from '@playwright/test';
import { DICTIONARIES, fill } from '../../mobile-business/src/i18n';
import { freshAddress } from './addresses';
import { waitForEmail } from './mailpit';
import { serveApp } from './mobile-app';

const product = 'Professional conditioner — IntensywnaRegeneracjaWłosówWysokoporowatych';
const specialist = 'Олександра Константинопольська-Войцеховська';
const account = {
  email: `az-${Date.now().toString(36)}@example.com`,
  password: 'e2e-password-123',
};
const address = freshAddress();
let locationUrl: string;
let owner: { Authorization: string };
let onlineVersion: number | undefined;

async function json<T>(response: APIResponse): Promise<T> {
  await expect(response).toBeOK();
  return response.json();
}

test.beforeAll(async ({ request }) => {
  await expect(
    await request.post('/v1/auth/register', {
      headers: address,
      data: { ...account, name: 'Alex' },
    }),
  ).toBeOK();
  const mail = await waitForEmail(account.email, /Potwierdź adres/);
  const token = /token=([^\s&]+)/.exec(mail.text)![1]!;
  await expect(
    await request.post('/v1/auth/verify-email', {
      data: { token: decodeURIComponent(token) },
    }),
  ).toBeOK();
  const session = await json<{ accessToken: string }>(
    await request.post('/v1/auth/login', {
      headers: address,
      data: { ...account, clientType: 'mobile' },
    }),
  );
  owner = { Authorization: `Bearer ${session.accessToken}` };
  const org = await json<{ id: string }>(
    await request.post('/v1/organizations', {
      headers: owner,
      data: { name: 'Salon AZ' },
    }),
  );
  const locations = `/v1/organizations/${org.id}/locations`;
  const salon = await json<{ id: string; version: number }>(
    await request.post(locations, {
      headers: owner,
      data: { name: 'Salon AZ', addressLine: 'Bema 91', city: 'Warszawa', postalCode: '01-233' },
    }),
  );
  locationUrl = `${locations}/${salon.id}`;
  const post = (path: string, data: object) =>
    request.post(locationUrl + path, { headers: owner, data });
  await expect(
    await post('/products', { name: product, priceGrosze: 3900, stockQuantity: 99999 }),
  ).toBeOK();
  const service = await json<{ id: string }>(
    await post('/services', {
      name: 'Cut',
      durationMinutes: 30,
      priceGrosze: 2_000_000,
    }),
  );
  const staff = await json<{ id: string }>(
    await post('/staff', {
      displayName: specialist,
      serviceIds: [service.id],
    }),
  );
  const visit = await json<{ id: string; version: number }>(
    await post('/appointments', {
      serviceId: service.id,
      staffId: staff.id,
      alreadyHappened: true,
      paid: true,
      start: new Date(Math.floor((Date.now() - 3_600_000) / 300_000) * 300_000).toISOString(),
      customer: { name: 'Anna Nowak', phone: '+48600123456' },
    }),
  );
  await expect(
    await request.put(`${locationUrl}/appointments/${visit.id}/tip`, {
      headers: owner,
      data: { version: visit.version, tipGrosze: 12345 },
    }),
  ).toBeOK();
  await expect(
    await request.put(`${locationUrl}/reports/commissions/${staff.id}`, {
      headers: owner,
      data: { commissionPercent: 62.5 },
    }),
  ).toBeOK();
  const online = await json<{ version: number }>(
    await request.patch(locationUrl, {
      headers: owner,
      data: {
        version: salon.version,
        onlineBookingEnabled: true,
        bookingTerms: 'Online booking terms for Salon AZ.',
        privacyPolicy: 'Privacy policy for Salon AZ.',
      },
    }),
  );
  onlineVersion = online.version;
});

test.afterAll(async ({ request }) => {
  if (onlineVersion !== undefined) {
    await expect(
      await request.patch(locationUrl, {
        headers: owner,
        data: { version: onlineVersion, onlineBookingEnabled: false },
      }),
    ).toBeOK();
  }
});

// Measure printed words (including wrapped fragments), input values and touch targets inside this card.
async function expectLayout(card: Locator) {
  const issues = await card.evaluate((root) => {
    const issues: string[] = [];
    if (window.innerWidth !== 320) issues.push(`Viewport width: ${window.innerWidth}`);
    const bounds = root.getBoundingClientRect();
    for (const el of root.querySelectorAll<HTMLElement>('[dir=auto], [role=button], input')) {
      const box = el.getBoundingClientRect();
      const label = el.getAttribute('aria-label') ?? el.textContent ?? '';
      if (box.left < Math.max(0, bounds.left) - 1 || box.right > Math.min(320, bounds.right) + 1)
        issues.push(`Outside card: ${label}`);
      if (el.matches('[role=button], input') && (box.width < 44 || box.height < 44))
        issues.push(`Small control: ${label}`);
      if (el instanceof HTMLInputElement && el.scrollWidth > el.clientWidth + 1)
        issues.push(`Clipped value: ${el.value}`);
      const range = document.createRange();
      for (const node of el.childNodes) {
        if (node.nodeType !== Node.TEXT_NODE) continue;
        for (const word of (node.textContent ?? '').matchAll(/\S+/gu)) {
          range.setStart(node, word.index);
          range.setEnd(node, word.index + word[0].length);
          if (
            Array.from(range.getClientRects()).some(
              (line) =>
                line.left < box.left - 1 ||
                line.right > box.right + 1 ||
                line.top < box.top - 1 ||
                line.bottom > box.bottom + 1,
            )
          )
            issues.push(`Clipped word: ${word[0]}`);
        }
      }
    }
    // Text and its neighbouring field or amount can fit the card individually and still overlap.
    for (const parent of root.querySelectorAll('*')) {
      const children = Array.from(parent.children, (child) => child.getBoundingClientRect());
      for (const [index, a] of children.entries()) {
        if (
          children
            .slice(index + 1)
            .some(
              (b) =>
                Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 &&
                Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1,
            )
        )
          issues.push(`Overlapping items: ${parent.textContent}`);
      }
    }
    return issues;
  });
  expect(issues).toEqual([]);
}

async function checkDisclosure(
  page: Page,
  title: string,
  more: string,
  summary: string,
  detail: string,
) {
  const card = page.getByRole('heading', { name: title, exact: true }).locator('..');
  const toggle = card.getByRole('button', { name: `${more}: ${title}`, exact: true });
  const details = card.getByText(detail, { exact: true });
  await expect(card.getByText(summary, { exact: true })).toBeVisible();
  await expect(toggle).toHaveText(`${more} ▸`);
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(details).toBeHidden();
  await expectLayout(card);
  await toggle.click();
  await expect(toggle).toHaveText(`${more} ▴`);
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(details).toBeVisible();
  await expectLayout(card);
  await toggle.click();
  await expect(details).toBeHidden();
}

for (const [locale, tag] of [
  ['en', 'en-GB'],
  ['uk', 'uk-UA'],
  ['ru', 'ru-RU'],
] as const) {
  test.describe(tag, () => {
    test.use({ locale: tag, viewport: { width: 320, height: 844 }, isMobile: true });
    test('day cards, inventory and commissions at 130% text', async ({ page, request }) => {
      const t = DICTIONARIES[locale];
      const button = (name: string) => page.getByRole('button', { name, exact: true });
      const tab = (name: string) => page.getByRole('tab', { name, exact: true });
      const session = await json<{ refreshToken: string }>(
        await request.post('/v1/auth/login', {
          headers: address,
          data: { ...account, clientType: 'mobile' },
        }),
      );
      const app = await serveApp('mobile-business');
      try {
        await page.addInitScript(
          (token) => localStorage.setItem('beauty.business.refreshToken', token),
          session.refreshToken,
        );
        // The salon has no external Base account. Exercise its connected UI with a fixed status.
        await page.route(`**${locationUrl}/shop/integrations/base`, (route) =>
          route.fulfill({
            json: {
              connected: true,
              tokenReadable: true,
              inventoryId: '1',
              tokenHint: '1234',
              importedProducts: 2468,
              syncEveryMinutes: 60,
              lastSyncAt: null,
              lastImportAt: null,
              lastErrorCode: null,
            },
          }),
        );
        await page.goto(app.url);
        await expect(page.locator('html')).toHaveAttribute('lang', locale);
        const title = page.getByRole('heading', { name: t.setup.title, exact: true });
        await expect(title).toBeVisible();
        const fontSize = () => title.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
        const normal = await fontSize();
        await page.addStyleTag({ content: '* { -webkit-text-size-adjust: 130% !important }' });
        expect(await fontSize()).toBeCloseTo(normal * 1.3, 1);
        await checkDisclosure(
          page,
          t.setup.title,
          t.navigation.more,
          fill(t.setup.lead, { n: '1' }),
          t.setup.steps.hours,
        );
        await checkDisclosure(
          page,
          t.clientsNow.label,
          t.navigation.more,
          t.clientsNow.closedNow,
          t.clientsNow.closedToday,
        );

        await tab(t.shop.open).click();
        await tab(t.navigation.integrations).click();
        await checkDisclosure(
          page,
          t.shop.base.title,
          t.navigation.more,
          fill(t.shop.base.connected, { hint: '1234', n: '2468' }),
          fill(t.shop.base.every, { n: '60' }),
        );
        await tab(t.navigation.products).click();
        await button(`${t.navigation.inventory} ▸`).click();
        await button(t.products.stocktake).click();
        const stock = page.getByTestId('stocktake');
        const count = stock.getByRole('textbox', {
          name: fill(t.products.stocktakeCount, { name: product }),
        });
        await expect(stock.getByText(product, { exact: true })).toBeVisible();
        await expect(count).toHaveValue('99999');
        await count.fill('100001');
        await expect(count).toHaveAccessibleDescription(
          '! ' + fill(t.products.orderPieces, { n: '0–100 000' }),
        );
        await expectLayout(stock);
        await count.fill('100000');
        await expect(stock).toContainText(fill(t.products.stocktakeExtra, { n: '1' }));
        await expect(stock.getByRole('button', { name: t.products.stocktakeSave })).toBeEnabled();
        await expectLayout(stock);

        await button(t.shop.back).click();
        await tab(t.navigation.more).click();
        await button(t.reports.open).click();
        await button(t.reports.last30).click();
        const section = page.getByTestId('report-commissions');
        const money = (amount: number) =>
          new Intl.NumberFormat(tag, { style: 'currency', currency: 'PLN' }).format(amount);
        const percent = new Intl.NumberFormat(tag).format(62.5);
        await expect(section.getByRole('heading')).toHaveText(
          fill(t.reports.commissionsTotal, { amount: money(12500) }),
        );
        const row = section.getByRole('group', { name: new RegExp(specialist) });
        await expect(row.getByText(specialist, { exact: true })).toBeVisible();
        await expect(row).toContainText(
          fill(t.reports.commissionRow, { percent: percent + '%', amount: money(12500) }),
        );
        await expect(row).toContainText(
          fill(t.reports.payoutRow, { tips: money(123.45), total: money(12623.45) }),
        );
        await expect(section.getByTestId('report-payout')).toHaveText(
          fill(t.reports.payoutTotal, { amount: money(12623.45) }),
        );
        await expectLayout(section);
        await section
          .getByRole('button', { name: t.reports.commissionsSet, expanded: false })
          .click();
        await expect(
          section.getByRole('textbox', {
            name: fill(t.reports.commissionLabel, { name: specialist }),
          }),
        ).toHaveValue(percent);
        await expectLayout(section);
        await section
          .getByRole('button', { name: t.reports.commissionsHide, expanded: true })
          .click();
        await expect(section.getByTestId('commission-list')).toBeHidden();
      } finally {
        app.server.close();
      }
    });
  });
}
