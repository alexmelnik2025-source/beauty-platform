import { expect, test, type APIRequestContext, type Locator } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { DICTIONARIES, fill } from '../../mobile-business/src/i18n';
import { freshAddress } from './addresses';
import { waitForEmail } from './mailpit';
import { openBusinessMenu, serveApp } from './mobile-app';

const t = DICTIONARIES.pl;
const product = 'Odżywka regenerująca do włosów wysokoporowatych';
const specialist = 'Aleksandra Wojciechowska-Kowalska';

async function prepareSalon(request: APIRequestContext) {
  const account = { email: `bn-${randomUUID()}@example.com`, password: randomUUID() };
  const address = freshAddress();
  await expect(
    await request.post('/v1/auth/register', {
      headers: address,
      data: { ...account, name: specialist },
    }),
  ).toBeOK();
  const mail = await waitForEmail(account.email, /Potwierdź adres/);
  const token = /token=([^\s&]+)/.exec(mail.text)![1]!;
  await expect(
    await request.post('/v1/auth/verify-email', {
      headers: address,
      data: { token: decodeURIComponent(token) },
    }),
  ).toBeOK();
  const login = await request.post('/v1/auth/login', {
    headers: address,
    data: { ...account, clientType: 'mobile' },
  });
  await expect(login).toBeOK();
  const session: { accessToken: string; refreshToken: string } = await login.json();
  const headers = { ...address, Authorization: `Bearer ${session.accessToken}` };
  async function create(path: string, data: object): Promise<string> {
    const response = await request.post(path, { headers, data });
    await expect(response).toBeOK();
    return (await response.json()).id;
  }
  const org = await create('/v1/organizations', { name: 'Studio BN' });
  const locations = `/v1/organizations/${org}/locations`;
  const salon = await create(locations, {
    name: 'Studio BN',
    addressLine: 'Bema 91',
    city: 'Warszawa',
    postalCode: '01-233',
  });
  const base = `${locations}/${salon}`;
  await create(`${base}/products`, { name: product, priceGrosze: 2500, stockQuantity: 99999 });
  const serviceId = await create(`${base}/services`, {
    name: 'Stylizacja',
    durationMinutes: 30,
    priceGrosze: 2_000_000,
  });
  const staffId = await create(`${base}/staff`, {
    displayName: specialist,
    serviceIds: [serviceId],
  });
  await create(`${base}/appointments`, {
    serviceId,
    staffId,
    paid: true,
    alreadyHappened: true,
    allowOutsideHours: true,
    start: new Date(Math.floor((Date.now() - 3_600_000) / 300_000) * 300_000).toISOString(),
    customer: { name: 'Jan Nowak', phone: '+48600123456' },
  });
  await expect(
    await request.put(`${base}/reports/commissions/${staffId}`, {
      headers,
      data: { commissionPercent: 62.5 },
    }),
  ).toBeOK();
  return session.refreshToken;
}

async function checkLayout(card: Locator) {
  const issues = await card.evaluate((root) => {
    const issues: string[] = [];
    if (document.documentElement.scrollWidth > 320) issues.push('Horizontal page scroll');
    const bounds = root.getBoundingClientRect();
    for (const el of root.querySelectorAll<HTMLElement>('*')) {
      const box = el.getBoundingClientRect();
      if (box.left < Math.max(0, bounds.left) - 1 || box.right > Math.min(320, bounds.right) + 1)
        issues.push(`Outside card: ${el.textContent}`);
      if (el.matches('input, button, [role=button]') && (box.width < 44 || box.height < 44))
        issues.push(`Small control: ${el.getAttribute('aria-label')}`);
      if (el instanceof HTMLInputElement && el.scrollWidth > el.clientWidth + 1)
        issues.push(`Clipped input: ${el.value}`);
      for (const node of el.childNodes) {
        if (node.nodeType !== Node.TEXT_NODE) continue;
        const range = document.createRange();
        for (const word of (node.textContent ?? '').matchAll(/\S+/gu)) {
          range.setStart(node, word.index);
          range.setEnd(node, word.index + word[0].length);
          if (
            Array.from(range.getClientRects()).some(
              (r) =>
                r.left < box.left - 1 ||
                r.right > box.right + 1 ||
                r.top < box.top - 1 ||
                r.bottom > box.bottom + 1,
            )
          )
            issues.push(`Clipped text: ${word[0]}`);
        }
      }
      const children = Array.from(el.children, (c) => c.getBoundingClientRect());
      if (
        children.some((a, i) =>
          children
            .slice(i + 1)
            .some(
              (b) =>
                Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 &&
                Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1,
            ),
        )
      )
        issues.push(`Overlapping content: ${el.textContent}`);
    }
    return issues;
  });
  expect(issues).toEqual([]);
}

test.use({ viewport: { width: 320, height: 844 }, isMobile: true, locale: 'pl-PL' });

test('day card summaries, setup steps, shelf counts and staff commissions at 130% text', async ({
  page,
  request,
}) => {
  const token = await prepareSalon(request);
  const app = await serveApp('mobile-business');
  const group = (name: string) => page.getByRole('group', { name, exact: true });
  const button = (name: string) => page.getByRole('button', { name, exact: true });
  const tab = (name: string) => page.getByRole('tab', { name, exact: true });
  try {
    await page.addInitScript(
      (token) => localStorage.setItem('beauty.business.refreshToken', token),
      token,
    );
    await page.goto(app.url);
    const setup = group(t.setup.title);
    const heading = setup.getByRole('heading', { name: t.setup.title, exact: true });
    await expect(heading).toHaveAccessibleDescription(fill(t.setup.lead, { n: '3' }));
    const size = () => heading.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    const normal = await size();
    await page.addStyleTag({ content: '* { -webkit-text-size-adjust: 130% !important }' });
    expect(await size()).toBeCloseTo(normal * 1.3, 1);

    const more = setup.getByRole('button', {
      name: `${t.navigation.more}: ${t.setup.title}`,
      expanded: false,
    });
    await more.click();
    await expect(
      setup.getByRole('checkbox', {
        name: `1. ${t.setup.steps.services} — ${t.setup.doneLabel}`,
        checked: true,
      }),
    ).toBeDisabled();
    await expect(
      setup.getByRole('button', {
        name: `${t.setup.go}: ${t.setup.steps.hours} — ${t.setup.todoLabel}`,
        exact: true,
      }),
    ).toBeEnabled();
    await checkLayout(setup);
    const now = group(t.clientsNow.label);
    await expect(now.getByRole('heading')).toHaveAccessibleDescription(t.salon.onlineOff);
    await checkLayout(now);

    await tab(t.shop.open).click();
    await tab(t.navigation.integrations).click();
    const base = group(t.shop.base.title);
    await expect(base.getByRole('heading')).toHaveAccessibleDescription(t.shop.base.off);
    await checkLayout(base);

    await tab(t.navigation.products).click();
    await button(`${t.navigation.inventory} ▸`).click();
    await button(t.products.stocktake).click();
    const stock = group(t.products.stocktakeTitle);
    const count = stock.getByRole('textbox', {
      name: fill(t.products.stocktakeCount, { name: product }),
      exact: true,
    });
    const save = stock.getByRole('button', { name: t.products.stocktakeSave });
    await expect(count).toHaveValue('99999');
    await count.fill('100001');
    const error = '! ' + fill(t.products.orderPieces, { n: '0–100 000' });
    await expect(count).toHaveAttribute('aria-invalid', 'true');
    await expect(count).toHaveAccessibleDescription(error);
    const message = stock.getByRole('alert');
    await expect(message).toHaveText(error);
    const fieldBox = (await count.boundingBox())!;
    const errorBox = (await message.boundingBox())!;
    expect(errorBox.y).toBeGreaterThanOrEqual(fieldBox.y + fieldBox.height);
    expect(errorBox.x).toBeCloseTo(fieldBox.x);
    await expect(save).toBeDisabled();
    await checkLayout(stock);
    await count.fill('100000');
    await expect(count).toHaveAccessibleDescription('');
    await expect(stock.getByRole('alert')).toHaveCount(0);
    await expect(save).toBeEnabled();
    await checkLayout(stock);

    await button(t.shop.back).click();
    await openBusinessMenu(page, t.reports.open);
    await button(t.reports.last30).click();
    const section = page.getByTestId('report-commissions');
    const amount = new Intl.NumberFormat('pl-PL', { style: 'currency', currency: 'PLN' }).format(
      12500,
    );
    const detail = fill(t.reports.commissionRow, { percent: '62,5%', amount });
    const row = section.getByRole('group', { name: `${specialist}, ${detail}`, exact: true });
    await expect(row.getByText(detail, { exact: true })).toBeVisible();
    await expect(section.getByTestId('report-payout')).toHaveText(
      fill(t.reports.payoutTotal, { amount }),
    );
    await section.getByRole('button', { name: t.reports.commissionsSet, expanded: false }).click();
    await expect(
      section.getByRole('textbox', { name: fill(t.reports.commissionLabel, { name: specialist }) }),
    ).toHaveValue('62,5');
    await checkLayout(section);
  } finally {
    app.server.close();
  }
});
