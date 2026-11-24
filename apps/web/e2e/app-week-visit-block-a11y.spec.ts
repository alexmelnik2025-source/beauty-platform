import { expect, test, type Locator, type Page } from '@playwright/test';
import { addDays, dayTitle } from '../../mobile-business/src/day';
import { DICTIONARIES, fill, LOCALES } from '../../mobile-business/src/i18n';
import { weekStart } from '../../mobile-business/src/week';
import { serveApp } from './mobile-app';

const date = '2026-11-25';
const base = '/v1/organizations/org/locations/salon';
const service = 'Stylizacja';
const staff = { id: 'staff', displayName: 'Aleksandra Wojciechowska-Kowalska', active: true };
const location = {
  id: 'salon',
  name: 'Pracownia fryzjerska na Starym Mieście',
  timezone: 'Europe/Warsaw',
  currency: 'PLN',
};

async function salonCalendar(page: Page) {
  const visit = {
    id: 'pending',
    date,
    time: '12:00',
    start: date + 'T11:00:00Z',
    end: date + 'T11:30:00Z',
    status: 'confirmed',
    awaitingApproval: true,
    version: 1,
    service: { id: 'service', name: service },
    staff,
    customer: null,
    priceGrosze: 8000,
    durationMinutes: 30,
    tipGrosze: 0,
    paidAt: null,
  };
  const completed = {
    ...visit,
    id: 'done',
    time: '09:00',
    start: date + 'T08:00:00Z',
    end: date + 'T08:30:00Z',
    status: 'completed',
    awaitingApproval: false,
    paidAt: visit.start,
    paymentMethod: 'card',
  };
  await page.clock.setFixedTime(new Date(date + 'T09:00:00Z'));
  await page.addInitScript(() => localStorage.setItem('beauty.business.refreshToken', 'test'));
  await page.route('**/v1/**', (route) => {
    const { pathname, searchParams } = new URL(route.request().url());
    const from = searchParams.get('from') ?? date;
    const replies: Record<string, unknown> = {
      '/v1/auth/refresh': { accessToken: 'test' },
      '/v1/me': { user: { id: 'owner' }, organizations: [{ id: 'org', role: 'owner' }] },
      '/v1/organizations/org/permissions': { me: { role: 'owner', permissions: {} } },
      '/v1/organizations/org/locations': [location],
      [base + '/calendar']: { from, location, staff: [], appointments: [visit, completed] },
      [base + '/staff']: [staff],
      [base + '/time-blocks']: [],
      [base + '/appointments/pending']: visit,
      [base + '/appointments/done']: completed,
      [base + '/availability']: {
        durationMinutes: 30,
        slots: ['10:00', '10:30', '11:00', '11:30'].map((time) => ({
          date: from,
          time,
          start: from + 'T' + time + ':00+01:00',
          staffIds: [staff.id],
        })),
      },
    };
    if (pathname.endsWith('/photos')) return route.fulfill({ json: { items: [] } });
    if (pathname.endsWith('/reservations')) return route.fulfill({ json: { reservations: [] } });
    if (pathname.endsWith('/product-sales')) return route.fulfill({ json: { sales: [] } });
    return pathname in replies
      ? route.fulfill({ json: replies[pathname] })
      : route.fulfill({ status: 404 });
  });
}

// Check rendered content inside the scroll view as well as the page width. A scroll
// container can hide clipped text while the document itself still measures 320 px.
async function fits(root: Locator) {
  const issues = await root.evaluate((root) => {
    const issues: string[] = [];
    if (innerWidth !== 320 || document.documentElement.scrollWidth > 320) issues.push('Page width');
    for (const el of [root, ...root.querySelectorAll<HTMLElement>('*')]) {
      const rect = el.getBoundingClientRect();
      if (!rect.width || !rect.height) continue;
      const name = el.getAttribute('aria-label') ?? el.textContent;
      if (rect.left < -1 || rect.right > 321 || el.scrollWidth > el.clientWidth + 1)
        issues.push('Outside available width: ' + name);
      if (el.matches('[role=button], button, input, textarea')) {
        if (!el.getAttribute('aria-label')?.trim()) issues.push('Missing label: ' + name);
        if (rect.width < 44 || rect.height < 44) issues.push('Small target: ' + name);
      }
      for (const node of el.childNodes) {
        if (node.nodeType !== Node.TEXT_NODE || !node.textContent?.trim()) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        if (
          Array.from(range.getClientRects()).some(
            (r) =>
              r.left < rect.left - 1 ||
              r.right > rect.right + 1 ||
              r.top < rect.top - 1 ||
              r.bottom > rect.bottom + 1,
          )
        )
          issues.push('Clipped text: ' + node.textContent);
      }
      const children = Array.from(el.children, (child) => child.getBoundingClientRect());
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
        issues.push('Overlapping items: ' + name);
    }
    return issues;
  });
  expect(issues).toEqual([]);
}

test.use({ viewport: { width: 320, height: 844 }, isMobile: true, timezoneId: location.timezone });

for (const lang of LOCALES) {
  test.describe(lang, () => {
    test.use({ locale: lang });
    test('week, visit and time block at 130% text', async ({ page }) => {
      const t = DICTIONARIES[lang];
      const v = t.visit;
      const b = t.blocks;
      const button = (name: string) => page.getByRole('button', { name, exact: true });
      const field = (name: string) => page.getByRole('textbox', { name, exact: true });
      await salonCalendar(page);
      const app = await serveApp('mobile-business');
      try {
        await page.goto(app.url);
        await button(t.week.open).click();
        const heading = page.getByRole('heading', { name: t.week.title });
        const size = () => heading.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
        const normal = await size();
        await page.addStyleTag({ content: '* { -webkit-text-size-adjust: 130% !important }' });
        expect(await size()).toBeCloseTo(normal * 1.3, 1);
        await expect(page.locator('html')).toHaveAttribute('lang', lang);
        for (let i = 0; i < 7; i++) {
          const day = addDays(weekStart(date), i);
          const row = page.getByRole('button').filter({ hasText: dayTitle(day, lang) });
          await expect(row).toHaveAccessibleName(new RegExp(dayTitle(day, lang)));
          await expect(row).toContainText(day === date ? '09:00–12:30' : t.week.free);
        }
        await expect(button(t.week.previous)).toBeEnabled();
        await expect(button(t.week.next)).toBeEnabled();
        await fits(heading.locator('../..'));
        await page
          .getByRole('button')
          .filter({ hasText: dayTitle(date, lang) })
          .click();

        await page.getByRole('button', { name: /^12:00 / }).click();
        await expect(button(v.approve)).toBeVisible();
        await fits(button(v.approve));
        await fits(page.getByText(v.status.confirmed, { exact: true }).locator('..'));
        await fits(button(v.move).locator('..'));
        await button(v.move).click();
        await button(v.nextDay).click();
        await expect(button(v.previousDay)).toBeEnabled();
        await expect(button('11:30')).toBeVisible();
        await fits(button(v.close).locator('..'));
        await button('11:30').click();
        await expect(
          page.getByText(fill(v.moveAsk, { when: dayTitle(addDays(date, 1), lang) + ' 11:30' })),
        ).toBeVisible();
        await fits(button(v.close).locator('..'));
        await button(v.close).click();
        await button(v.cancel).click();
        await button(v.cancel).click();
        const reason = field(v.reason);
        await expect(reason).toHaveAccessibleDescription('! ' + v.badReason);
        await expect(reason).toHaveAttribute('aria-invalid', 'true');
        await fits(reason.locator('..'));
        await reason.fill('Zmiana planów');
        await expect(reason).toHaveAccessibleDescription('');
        await button(v.back).click();

        await button(`09:00 ${t.day.walkIn} · ${service}`).click();
        await fits(page.getByText(v.status.completed, { exact: true }).locator('..'));
        const tip = field(fill(v.tip, { currency: 'PLN' }));
        await tip.fill('-1');
        await expect(tip).toHaveAccessibleDescription('! ' + v.tipInvalid);
        await expect(tip).toHaveAttribute('aria-invalid', 'true');
        await expect(button(v.tipSave)).toBeDisabled();
        await fits(tip.locator('..'));
        await tip.fill('12,50');
        await expect(tip).toHaveAccessibleDescription(v.tipHint);
        await expect(button(v.tipSave)).toBeEnabled();
        await button(v.back).click();

        await button('+ ' + b.add).click();
        await button(b.wholeSalon).click();
        await button(b.repeat).click();
        await expect(page.getByRole('button', { name: b.wholeSalon, pressed: true })).toBeVisible();
        await expect(page.getByRole('button', { name: b.repeat, pressed: true })).toBeVisible();
        await expect(button(b.moreWeeks)).toBeEnabled();
        await button(b.fewerWeeks).click();
        for (let i = 0; i < 4; i++) await button(b.to + ': ' + b.earlier).click();
        await button(b.save).click();
        const end = page.getByRole('group', { name: b.to, exact: true });
        await expect(end).toHaveAccessibleDescription('! ' + b.badRange);
        await expect(field(b.reason)).toHaveAccessibleDescription('! ' + b.reason);
        await fits(page.getByRole('heading', { name: b.add }).locator('..'));
        await button(b.to + ': ' + b.later).click();
        await field(b.reason).fill('Przerwa');
        await expect(end).toHaveAccessibleDescription('');
        await expect(field(b.reason)).toHaveAccessibleDescription('');
      } finally {
        app.server.close();
      }
    });
  });
}
