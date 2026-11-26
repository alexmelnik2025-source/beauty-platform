import { expect, test, type Locator, type Page, type Route } from '@playwright/test';
import { dayTitle } from '../../mobile-business/src/day';
import { DICTIONARIES, LOCALES } from '../../mobile-business/src/i18n';
import {
  auditBase,
  expectAuditTextFits,
  installAuditSession,
  scaleAuditText,
} from './audit-business';
import { serveApp } from './mobile-app';

const date = '2026-11-26';
const tomorrow = '2026-11-27';
const roles = ['owner', 'manager', 'staff'] as const;
type Role = (typeof roles)[number];

async function doubleTap(control: Locator) {
  await control.evaluate((el: HTMLElement) => {
    el.click();
    el.click();
  });
}

// Keep the mutation unresolved until the UI disables the control. Count the second
// tap even if it arrives before the first response and React has not yet rendered.
async function interruptDoubleTap(page: Page, url: string, control: Locator) {
  let count = 0;
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const handler = async (route: Route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    count++;
    await pending;
    await route.abort('internetdisconnected');
  };
  await page.route(url, handler);
  try {
    await doubleTap(control);
    await expect.poll(() => count).toBe(1);
    await expect(control).toBeDisabled();
  } finally {
    release();
  }
  await expect(control).toBeEnabled();
  expect(count).toBe(1);
  await page.unroute(url, handler);
}

async function calendar(page: Page, role: Role) {
  await installAuditSession(page, role, { blockOwnTime: true });
  await page.clock.setFixedTime(new Date(date + 'T09:00:00Z'));
  const staff = {
    id: 'staff',
    userId: 'user',
    displayName: 'Anna',
    active: true,
    serviceIds: ['cut'],
  };
  const visit = {
    id: 'v1',
    date: tomorrow,
    time: '12:00',
    start: tomorrow + 'T11:00:00Z',
    end: tomorrow + 'T11:30:00Z',
    status: 'confirmed',
    awaitingApproval: true,
    version: 1,
    service: { id: 'cut', name: 'Cut' },
    staff,
    customer: null,
    priceGrosze: 2000,
    durationMinutes: 30,
    tipGrosze: 0,
    paidAt: null,
  };
  const location = {
    id: 'loc',
    name: 'Studio DR',
    currency: 'PLN',
    timezone: 'Europe/Warsaw',
    onlineBookingEnabled: false,
  };
  await page.route('**' + auditBase + '/calendar?*', (r) => {
    const params = new URL(r.request().url()).searchParams;
    const from = params.get('from')!;
    const to = params.get('to')!;
    return r.fulfill({
      json: {
        from,
        to,
        location,
        staff: [],
        blocks: [],
        timeOff: [],
        appointments: from <= tomorrow && tomorrow <= to ? [visit] : [],
      },
    });
  });
  await page.route('**' + auditBase + '/appointments/v1', (r) => r.fulfill({ json: visit }));
  await page.route('**' + auditBase + '/appointments/v1/photos', (r) =>
    r.fulfill({ json: { items: [] } }),
  );
  await page.route('**' + auditBase + '/appointments/v1/reservations', (r) =>
    r.abort('internetdisconnected'),
  );
  await page.route('**' + auditBase + '/waitlist?*', (r) => r.abort('internetdisconnected'));
}

test.use({ viewport: { width: 320, height: 740 }, isMobile: true, timezoneId: 'Europe/Warsaw' });
for (const lang of LOCALES) {
  test.describe(lang, () => {
    test.use({ locale: lang });
    for (const role of roles) {
      test(`${role}: empty day, week, new visit, block and visit recovery`, async ({ page }) => {
        const t = DICTIONARIES[lang];
        const button = (name: string) => page.getByRole('button', { name, exact: true });
        const text = (name: string) => page.getByText(name, { exact: true });
        await calendar(page, role);
        const app = await serveApp('mobile-business');
        try {
          await page.goto(app.url);
          const empty = text(t.day.empty);
          await scaleAuditText(page, empty);
          await expectAuditTextFits(empty);
          await expectAuditTextFits(text(t.day.nobodyWorks));
          const todayHeading = page.getByRole('heading', {
            name: dayTitle(date, lang),
            exact: true,
          });
          await expect(todayHeading).toBeVisible();
          if (role !== 'staff') {
            const waiting = page.getByLabel(t.waitlist.title, { exact: true });
            await expect(waiting.getByRole('status')).toHaveText(t.error.network);
            await expectAuditTextFits(waiting.getByRole('heading'));
            await page.route('**' + auditBase + '/waitlist?*', (r) =>
              r.fulfill({ json: { from: date, items: [] } }),
            );
            await doubleTap(button(t.day.refresh + ': ' + t.waitlist.title));
            await expect(waiting.getByRole('heading')).toHaveText(t.waitlist.title + ' (0)');
            await expect(waiting.getByRole('status')).toHaveCount(0);
            await expectAuditTextFits(page.getByRole('heading', { name: t.clientsNow.label }));
            await expect(text(t.salon.onlineOff)).toBeVisible();
            await button(t.navigation.more + ': ' + t.setup.title).click();
            await expectAuditTextFits(text(t.setup.steps.hours));
          } else {
            await expect(text(t.waitlist.title + ' (0)')).toHaveCount(0);
            await expect(page.getByTestId('clients-now')).toHaveCount(0);
          }

          await page.route(
            '**' + auditBase + '/calendar?from=' + date + '&to=' + date,
            (route) => route.abort('internetdisconnected'),
            { times: 1 },
          );
          await button(t.day.refresh).click();
          await expect(page.getByRole('alert').filter({ hasText: t.error.network })).toBeVisible();
          await expect(empty).toBeVisible();
          await button(t.day.refresh).click();
          await expect(page.getByRole('alert').filter({ hasText: t.error.network })).toHaveCount(0);
          await button(t.newVisit.open).click();
          await expectAuditTextFits(text(t.newVisit.noServices));
          await expect(button(t.newVisit.save)).toHaveCount(0);
          await button(t.newVisit.back).click();
          await page.route('**' + auditBase + '/services', (r) => r.abort('internetdisconnected'), {
            times: 1,
          });
          await button(t.newVisit.open).click();
          await expect(page.getByRole('alert')).toHaveText(t.error.network);
          await button(t.newVisit.back).click();

          await page.route(
            '**' + auditBase + '/calendar?from=2026-11-23&to=2026-11-29',
            (r) => r.abort('internetdisconnected'),
            { times: 1 },
          );
          await doubleTap(button(t.week.open));
          await expect(page.getByRole('alert')).toHaveText(t.error.network);
          await doubleTap(button(t.day.refresh));
          const days = page.getByRole('button').filter({ hasText: t.week.free });
          await expect(days).toHaveCount(6);
          await expectAuditTextFits(page.getByRole('heading', { name: t.week.title }));
          await page
            .getByRole('button')
            .filter({ hasText: dayTitle(tomorrow, lang) })
            .click();
          const card = page.getByRole('button', { name: /12:00 .*Cut/ });
          await expect(card).toBeVisible();
          await button('+ ' + t.blocks.add).click();
          await expectAuditTextFits(page.getByRole('heading', { name: t.blocks.add }));
          await expect(button(t.blocks.wholeSalon)).toHaveCount(role === 'staff' ? 0 : 1);
          const save = button(t.blocks.save);
          await doubleTap(save);
          const reason = page.getByRole('textbox', { name: t.blocks.reason });
          await expect(reason).toHaveAccessibleDescription('! ' + t.blocks.reason);
          await reason.fill('DR');
          await interruptDoubleTap(page, '**' + auditBase + '/time-blocks', save);
          await expect(page.getByRole('alert')).toHaveText(t.error.network);
          await expect(reason).toHaveValue('DR');
          await button(t.blocks.cancel).click();

          await doubleTap(card);
          const hand = page.getByTestId('visit-to-hand');
          await expect(hand.getByRole('status')).toHaveText(t.error.network);
          await expectAuditTextFits(hand.getByRole('heading'));
          await page.route('**' + auditBase + '/appointments/v1/reservations', (r) =>
            r.fulfill({ json: { reservations: [], toHandGrosze: 0 } }),
          );
          await doubleTap(button(t.day.refresh + ': ' + t.products.toHandTitle));
          await expect(hand).toHaveCount(0);
          const approve = button(t.visit.approve);
          await expectAuditTextFits(approve.getByText(t.visit.approve, { exact: true }));
          await interruptDoubleTap(page, '**' + auditBase + '/appointments/v1/approve', approve);
          await expect(page.getByRole('alert').filter({ hasText: t.error.network })).toBeVisible();
          await expect(approve).toBeEnabled();
        } finally {
          app.server.close();
        }
      });
    }
  });
}

for (const lang of LOCALES) {
  test.describe(lang, () => {
    test.use({ locale: lang });
    for (const role of roles) {
      test(`${role}: booking form keeps a filled appointment after a disconnected save`, async ({
        page,
      }) => {
        await installAuditSession(page, role);
        await page.clock.setFixedTime(new Date(date + 'T09:00:00Z'));
        const t = DICTIONARIES[lang];
        const n = t.newVisit;
        const button = (name: string) => page.getByRole('button', { name, exact: true });
        const field = (name: string) => page.getByRole('textbox', { name, exact: true });
        const person = {
          id: 'staff',
          userId: 'user',
          active: true,
          serviceIds: ['cut'],
          displayName: 'Anna',
          sortOrder: 0,
        };
        await page.route('**' + auditBase + '/staff', (r) => r.fulfill({ json: [person] }));
        await page.route('**' + auditBase + '/services', (r) =>
          r.fulfill({
            json: [
              {
                id: 'cut',
                active: true,
                name: 'Cut',
                durationMinutes: 30,
                staffIds: ['staff'],
                sortOrder: 0,
                priceGrosze: 2000,
              },
            ],
          }),
        );
        const slot = {
          date: tomorrow,
          time: '12:00',
          start: tomorrow + 'T11:00:00Z',
          staffIds: ['staff'],
        };
        await page.route('**' + auditBase + '/availability?*', (r) => {
          const from = new URL(r.request().url()).searchParams.get('from');
          return r.fulfill({
            json: { slots: from === tomorrow ? [slot] : [], durationMinutes: 30 },
          });
        });
        const app = await serveApp('mobile-business');
        try {
          await page.goto(app.url);
          await button(n.open).click();
          const title = page.getByRole('heading', { name: n.title });
          await scaleAuditText(page, title);
          await page.getByRole('button', { name: /^Cut ·/ }).click();
          await expectAuditTextFits(page.getByText(n.noTimes, { exact: true }));
          await button(n.nextDay).click();
          await button(slot.time).click();
          await expect(field(n.search)).toHaveCount(role === 'staff' ? 0 : 1);
          await field(n.name).fill('Anna DR');
          await field(n.phone).fill('+48600100200');
          await field(n.note).fill('DR');
          await page.route('**' + auditBase + '/appointments', (route) =>
            route.abort('internetdisconnected'),
          );
          await button(n.save).click();
          await expect(page.getByRole('alert')).toHaveText(t.error.network);
          await expect(field(n.name)).toHaveValue('Anna DR');
          await expect(field(n.phone)).toHaveValue('+48600100200');
          await expect(field(n.note)).toHaveValue('DR');
          const retry = page.waitForRequest(
            (request) =>
              request.method() === 'POST' &&
              new URL(request.url()).pathname === auditBase + '/appointments',
          );
          await button(n.save).click();
          expect((await retry).postDataJSON()).toMatchObject({
            serviceId: 'cut',
            staffId: 'staff',
            start: slot.start,
            note: 'DR',
            customer: { name: 'Anna DR', phone: '+48600100200', locale: lang },
          });
        } finally {
          app.server.close();
        }
      });
    }
  });
}
