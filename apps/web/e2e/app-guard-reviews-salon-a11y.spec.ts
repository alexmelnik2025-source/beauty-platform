import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { fill } from '../../mobile-business/src/i18n';
import { pl } from '../../mobile-business/src/locales/pl';
import { freshAddress } from './addresses';
import { waitForEmail } from './mailpit';
import { openBusinessMenu, serveApp } from './mobile-app';

const customer = 'Aleksandra ' + 'Konstantynopolitańczykówna'.repeat(3);
const reviewText = 'Znakomita'.repeat(30);
test.use({ viewport: { width: 320, height: 844 }, locale: 'pl-PL', isMobile: true });

async function createSalon(request: APIRequestContext) {
  const email = `bk-${Date.now().toString(36)}@example.com`;
  const credentials = { email, password: 'e2e-password-123' };
  const address = freshAddress();
  await expect(
    await request.post('/v1/auth/register', {
      headers: address,
      data: { ...credentials, name: 'Anna' },
    }),
  ).toBeOK();
  const mail = await waitForEmail(email, /Potwierdź adres/);
  const token = decodeURIComponent(/token=([^\s&]+)/.exec(mail.text)![1]!);
  await expect(await request.post('/v1/auth/verify-email', { data: { token } })).toBeOK();
  const login = await request.post('/v1/auth/login', {
    headers: address,
    data: { ...credentials, clientType: 'mobile' },
  });
  await expect(login).toBeOK();
  const session = await login.json();
  const headers = { Authorization: `Bearer ${session.accessToken}` };
  const org = await request.post('/v1/organizations', { headers, data: { name: 'Salon BK' } });
  await expect(org).toBeOK();
  const location = await request.post(`/v1/organizations/${(await org.json()).id}/locations`, {
    headers,
    data: { name: 'Salon BK', addressLine: 'Bema 91', city: 'Warszawa', postalCode: '01-233' },
  });
  await expect(location).toBeOK();
  const salon = await location.json();
  const base = new URL(location.url()).pathname + '/' + salon.id;
  // Keep the test salon out of the shared booking catalogue.
  await expect(
    await request.patch(base, {
      headers,
      data: { version: salon.version, onlineBookingEnabled: false },
    }),
  ).toBeOK();
  await expect(
    await request.put(base + '/cancellation-guard', {
      headers,
      data: {
        version: 0,
        enabled: true,
        maxChanges: null,
        windowHours: 720,
        lateCancelMinutes: null,
        maxNoShows: 2,
        action: 'approval',
      },
    }),
  ).toBeOK();
  return session.refreshToken as string;
}

async function expectLayout(page: Page) {
  const issues = await page.evaluate(() => {
    const issues: string[] = [];
    if (innerWidth !== 320 || document.documentElement.scrollWidth !== 320)
      issues.push('Page width');
    const surface = document.querySelector('[role=dialog][aria-modal=true]') ?? document.body;
    for (const el of surface.querySelectorAll<HTMLElement>('div')) {
      if (
        ['scroll', 'auto'].includes(getComputedStyle(el).overflowX) &&
        el.scrollWidth > el.clientWidth + 1
      )
        issues.push(`Horizontal scrolling: ${el.scrollWidth} > ${el.clientWidth}`);
    }
    const controls = surface.querySelectorAll<HTMLElement>(
      'button, input, textarea, [role=button], [role=checkbox], [role=radio], [role=switch]',
    );
    const boxes = [];
    for (const el of controls) {
      if (!el.getClientRects().length || el.closest('[aria-hidden=true]')) continue;
      const rect = el.getBoundingClientRect();
      const name = el.getAttribute('aria-label') || el.textContent?.trim();
      if (!name || rect.width < 44 || rect.height < 44 || rect.left < -1 || rect.right > 321)
        issues.push(`Invalid target: ${name} (${rect.width} × ${rect.height})`);
      boxes.push({ rect, name });
    }
    for (const [i, a] of boxes.entries()) {
      for (const b of boxes.slice(i + 1)) {
        if (
          Math.min(a.rect.right, b.rect.right) - Math.max(a.rect.left, b.rect.left) > 1 &&
          Math.min(a.rect.bottom, b.rect.bottom) - Math.max(a.rect.top, b.rect.top) > 1
        )
          issues.push(`Overlapping controls: ${a.name}, ${b.name}`);
      }
    }
    return issues;
  });
  expect(issues).toEqual([]);
}

async function expectWrappedText(text: Locator) {
  await text.scrollIntoViewIfNeeded();
  const fits = await text.evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    const lines = Array.from(range.getClientRects());
    const box = el.getBoundingClientRect();
    return (
      lines.length > 1 &&
      lines.every(
        (line) =>
          line.left >= Math.max(0, box.left) - 1 &&
          line.right <= Math.min(innerWidth, box.right) + 1 &&
          line.top >= box.top - 1 &&
          line.bottom <= box.bottom + 1,
      )
    );
  });
  expect(fits).toBe(true);
}

test('guard, reviews and salon controls stay accessible at 320 px and 130% text', async ({
  page,
  request,
}) => {
  const session = await createSalon(request);
  const app = await serveApp('mobile-business');
  const button = (name: string) => page.getByRole('button', { name, exact: true });
  const { guard: g, reviews: r, salon: s } = pl;
  try {
    await page.addInitScript(
      (token) => localStorage.setItem('beauty.business.refreshToken', token),
      session,
    );
    await page.route('**/cancellation-guard/clients', (route) =>
      route.fulfill({
        json: {
          currency: 'PLN',
          items: [
            {
              customerId: 'bk-client',
              name: customer,
              rule: 'salon',
              reasons: ['no_shows'],
              noShows: 2,
              noShowAmountGrosze: 0,
            },
          ],
        },
      }),
    );
    await page.route('**/locations/*/reviews', (route) =>
      route.fulfill({
        json: {
          enabled: true,
          count: 1,
          average: 4,
          stars: [0, 0, 0, 1, 0],
          unanswered: 1,
          staff: [],
          services: [],
          nextBefore: null,
          items: [
            {
              id: 'bk-review',
              rating: 4,
              text: reviewText,
              customerName: customer,
              serviceName: 'Broda',
              staffName: 'Anna',
              visitStartAt: '2026-11-20T10:00:00Z',
              reply: null,
            },
          ],
        },
      }),
    );
    await page.goto(app.url);
    await openBusinessMenu(page, g.open);
    const title = page.getByRole('heading', { name: g.title, exact: true });
    const fontSize = () => title.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    const original = await fontSize();
    await page.addStyleTag({ content: '* { -webkit-text-size-adjust: 130% !important }' });
    expect(await fontSize()).toBeCloseTo(original * 1.3, 1);

    await expectWrappedText(page.getByText(customer, { exact: true }));
    const release = fill(g.releaseOne, { name: customer });
    await button(release).click();
    const confirm = page.getByRole('group', { name: release, exact: true });
    await expect(confirm.getByRole('textbox', { name: g.note })).toBeVisible();
    await expect(confirm.getByRole('button', { name: g.releaseYes })).toBeEnabled();
    await expectLayout(page);
    await confirm.getByRole('button', { name: g.no, exact: true }).click();
    await button(g.rulesChange).click();
    const late = page.getByRole('checkbox', { name: g.lateOn });
    await expect(late).not.toBeChecked();
    await late.click();
    await expect(late).toBeChecked();
    const actions = page.getByRole('radiogroup', { name: g.actionLabel });
    const phoneOnly = actions.getByRole('radio', { name: g.actions.phone_only });
    await phoneOnly.click();
    await expect(phoneOnly).toBeChecked();
    await expect(actions.getByRole('radio', { name: g.actions.approval })).not.toBeChecked();
    await expect(button(g.rulesSave)).toBeEnabled();
    await expectLayout(page);
    await button(g.back).click();

    await button(r.open).click();
    await button(r.collect).click();
    await expect(button(r.collect)).toHaveAttribute('aria-pressed', 'true');
    const hours = page.getByRole('group', { name: r.askAfter }).getByRole('button', {
      name: fill(r.hoursLabel, { n: '6' }),
      exact: true,
    });
    await hours.click();
    await expect(hours).toHaveAttribute('aria-pressed', 'true');
    const row = page.getByRole('group', { name: new RegExp(customer) });
    await expect(
      row.getByRole('img', { name: fill(pl.reports.ratings, { stars: '4/5' }) }),
    ).toBeVisible();
    await expectWrappedText(row.getByText(reviewText, { exact: true }));
    await row.getByRole('button', { name: r.reply, exact: true }).click();
    await expect(row.getByRole('textbox', { name: r.replyLabel })).toBeVisible();
    await expect(row.getByRole('button', { name: r.replySave })).toBeEnabled();
    await expectLayout(page);
    await button(r.back).click();

    await button(pl.navigation.settings).click();
    await button(s.online).click();
    const online = page.getByRole('switch', { name: s.online, exact: true });
    const wasOnline = await online.isChecked();
    await online.click();
    await expect(online).toBeChecked({ checked: !wasOnline });
    await expect(button(s.save)).toBeEnabled();
    await expectLayout(page);
    await button(pl.navigation.discard).click();
    await expect(online).toBeChecked({ checked: wasOnline });
    await button(`‹ ${pl.navigation.settings}`).click();
    await button(s.questions).click();
    await expect(page.getByLabel(s.askMood, { exact: true })).toHaveCount(1);
    await expect(page.getByRole('switch', { name: s.askMood })).toBeEnabled();
    await expectLayout(page);
    await button(`‹ ${pl.navigation.settings}`).click();
    await button(s.country).click();
    const change = button(`${s.choiceChange}: ${s.currency}`);
    await expect(change).toHaveAttribute('aria-expanded', 'false');
    await change.click();
    const dialog = page.getByRole('dialog', { name: s.currency });
    const currencies = dialog.getByRole('radiogroup', { name: s.currency });
    await expect(currencies.getByRole('radio', { checked: true })).toHaveCount(1);
    await expectLayout(page);
    await dialog.getByRole('button', { name: `${s.choiceClose}: ${s.currency}` }).click();
    await expect(dialog).toHaveCount(0);
    await expect(change).toBeVisible();
  } finally {
    app.server.close();
  }
});
