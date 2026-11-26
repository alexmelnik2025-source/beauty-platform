import { expect, test, type Locator, type Page, type Route } from '@playwright/test';
import { DICTIONARIES, LOCALES, type Dictionary } from '../../mobile-business/src/i18n';
import {
  auditBase,
  expectAuditTextFits,
  installAuditSession,
  scaleAuditText,
} from './audit-business';
import { serveApp } from './mobile-app';

const org = '/v1/organizations/org';
const customer = { id: 'customer', name: 'Anna Kowalska', phone: null, email: null };
const notice = {
  id: 'notice',
  organizationId: 'org',
  appointmentId: 'visit',
  type: 'appointment.booked',
  read: false,
  data: {
    locationId: 'loc',
    date: '2026-11-26',
    time: '11:00',
    by: 'client',
    customerName: customer.name,
    serviceName: 'Broda',
    staffName: 'Jan',
  },
};
const visit = {
  id: 'visit',
  date: notice.data.date,
  time: notice.data.time,
  version: 1,
  start: '2026-11-26T10:00:00Z',
  end: '2026-11-26T10:30:00Z',
  status: 'confirmed',
  service: { id: 'service', name: 'Broda' },
  staff: { id: 'staff', displayName: 'Jan' },
  customer,
  durationMinutes: 30,
  priceGrosze: 5000,
  paidAt: null,
  tipGrosze: 0,
};
const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });

async function tapTwice(control: Locator) {
  await control.evaluate((el: HTMLElement) => {
    el.click();
    el.click();
  });
}

async function failFirst(page: Page, path: string) {
  await page.route(path, (route) => route.abort('internetdisconnected'), { times: 1 });
}

async function expectReadError(page: Page, t: Dictionary) {
  const error = page.getByRole('alert').filter({ hasText: t.error.network });
  await expect(error).toBeVisible();
  await expectAuditTextFits(error);
}

// Keep the first write outstanding until both taps arrive. Disconnect, then retry from the screen.
async function retryWrite(
  page: Page,
  t: Dictionary,
  control: Locator,
  path: string,
  body: object,
  response: object,
) {
  const writes: unknown[] = [];
  let pending: Route | undefined;
  await page.route(path, (route) => {
    writes.push(route.request().postDataJSON());
    if (writes.length === 1) {
      pending = route;
      return;
    }
    return route.fulfill({ json: response });
  });
  await tapTwice(control);
  await expect(control).toBeDisabled();
  await expect.poll(() => writes).toEqual([body]);
  await pending!.abort('internetdisconnected');
  await expectReadError(page, t);
  await expect(control).toBeEnabled();
  await control.click();
  await expect.poll(() => writes).toEqual([body, body]);
}

let app: Awaited<ReturnType<typeof serveApp>>;
test.beforeAll(async () => {
  app = await serveApp('mobile-business');
});
test.afterAll(() => {
  app.server.close();
});

for (const locale of LOCALES) {
  test.describe(locale, () => {
    test.use({ viewport: { width: 320, height: 740 }, isMobile: true, locale });
    for (const role of ['owner', 'manager', 'staff'] as const) {
      test(`${role} reads clients, notifications, reviews and salon activity at 130%`, async ({
        page,
      }) => {
        const t = DICTIONARIES[locale];
        const more = page.getByRole('tab', { name: t.navigation.more, exact: true });
        const clients = page.getByRole('tab', { name: t.clients.open, exact: true });
        const refresh = button(page, t.day.refresh);
        await installAuditSession(page, role);
        await page.goto(app.url);
        await more.click();
        await scaleAuditText(
          page,
          page.getByRole('heading', { name: t.navigation.more, exact: true }),
        );

        await test.step('empty reviews after a disconnected read', async () => {
          const path = '**' + auditBase + '/reviews';
          await page.route('**' + auditBase + '/review-settings', (route) =>
            route.fulfill({ json: { enabled: true, requestHours: 3, version: 1 } }),
          );
          await page.route(path, (route) =>
            route.fulfill({
              json: {
                enabled: true,
                count: 0,
                average: null,
                stars: [0, 0, 0, 0, 0],
                unanswered: 0,
                staff: [],
                services: [],
                items: [],
                nextBefore: null,
              },
            }),
          );
          await failFirst(page, path);
          await button(page, t.reviews.open).click();
          await expectReadError(page, t);
          await refresh.click();
          const empty = page.getByRole('status').filter({ hasText: t.reviews.none });
          await expectAuditTextFits(empty);
          await expect(
            page.getByRole('heading', { name: t.reviews.settings, exact: true }),
          ).toHaveCount(role === 'staff' ? 0 : 1);
          await expect(button(page, t.reviews.reply)).toHaveCount(0);
          await button(page, t.reviews.back).click();
        });

        await test.step('messages and history respect the selected role', async () => {
          if (role !== 'staff') {
            const path = '**' + auditBase;
            const location = {
              reminderHoursBefore: 24,
              waitlistHoldMinutes: 10,
              rebookReminderDays: 0,
              rebookReminderText: null,
              version: 1,
            };
            await page.route(path, (route) => route.fulfill({ json: location }));
            await failFirst(page, path);
            await button(page, t.messages.open).click();
            await expectReadError(page, t);
            await tapTwice(refresh);
            const save = button(page, t.messages.save);
            await expectAuditTextFits(save);
            await tapTwice(save);
            await expect(page.getByRole('status')).toHaveText(t.messages.nothing);
            await button(page, t.messages.reminderNone).click();
            await retryWrite(
              page,
              t,
              save,
              path,
              { version: 1, reminderHoursBefore: 0 },
              { ...location, version: 2, reminderHoursBefore: 0 },
            );
            await expect(page.getByRole('status')).toHaveText(t.messages.saved);

            await button(page, t.messages.back).click();
          } else {
            await expect(button(page, t.messages.open)).toHaveCount(0);
          }
          if (role === 'owner') {
            const path = '**' + org + '/audit-log?*';
            let reads = 0;
            await page.route(path, (route) => {
              reads++;
              return route.fulfill({ json: { items: [], next: null } });
            });
            await failFirst(page, path);
            await button(page, t.history.open).click();
            await expectReadError(page, t);
            await tapTwice(refresh);
            await expectAuditTextFits(page.getByText(t.history.empty, { exact: true }));
            expect(reads).toBe(1);
            await button(page, t.history.back).click();
          } else {
            await expect(button(page, t.history.open)).toHaveCount(0);
          }
        });

        await test.step('clients, empty search and required contact fields', async () => {
          if (role === 'staff') {
            await expect(clients).toHaveCount(0);
            return;
          }
          const path = '**' + org + '/customers?*';
          await page.route('**' + org + '/customers/tags', (route) =>
            route.fulfill({ json: { tags: [] } }),
          );
          await page.route(path, (route) => route.fulfill({ json: [] }));
          await failFirst(page, path);
          await clients.click();
          await expectReadError(page, t);
          await button(page, t.clients.find).click();
          await expectAuditTextFits(page.getByText(t.clients.none, { exact: true }));
          await button(page, t.clientCard.add).click();
          await tapTwice(button(page, t.clientCard.create));
          await expect(
            page.getByRole('textbox', { name: t.clientCard.name, exact: true }),
          ).toHaveAttribute('aria-invalid', 'true');
          await expect(page.getByRole('alert')).toContainText(t.clientCard.badName);
          await more.click();
        });

        await test.step('empty inbox, one pending mark-all and an explicit retry', async () => {
          const path = '**/v1/me/notifications?*';
          let arrived = false;
          await page.route(path, (route) => route.fulfill({ json: arrived ? [notice] : [] }));
          await failFirst(page, path);
          await button(page, t.notifications.open).click();
          await expectReadError(page, t);
          await tapTwice(refresh);
          await expectAuditTextFits(page.getByText(t.notifications.empty, { exact: true }));
          await button(page, t.notifications.back).click();
          arrived = true;
          await button(page, t.notifications.open).click();
          const read = button(page, t.notifications.readAll);
          await expectAuditTextFits(read);
          await retryWrite(
            page,
            t,
            read,
            '**/v1/me/notifications/read',
            { all: true },
            { updated: 1 },
          );
          await expect(read).toHaveCount(0);
        });

        await test.step('open the client card from the visit, including for a specialist', async () => {
          const path = '**' + org + '/customers/customer';
          const detail = {
            ...customer,
            phone: role === 'staff' ? null : '+48600100200',
            locale,
            visits: [],
            products: { purchases: [], totals: [] },
            summary: {},
            tags: role === 'staff' ? null : [],
            note: null,
            marketingConsent: null,
          };
          await page.route('**' + auditBase + '/appointments/visit', (route) =>
            route.fulfill({ json: visit }),
          );
          await page.route(path, (route) => route.fulfill({ json: detail }));
          await failFirst(page, path);
          await page.getByRole('button', { name: /Anna Kowalska · Broda · Jan/ }).click();
          const card = button(page, t.clients.card);
          await card.click();
          await expectReadError(page, t);
          await button(page, t.clients.back).click();
          await tapTwice(card);
          await expectAuditTextFits(page.getByRole('heading', { name: customer.name }));
          await expectAuditTextFits(page.getByText(t.clients.noVisits, { exact: true }));
          if (role === 'staff') {
            await expectAuditTextFits(page.getByText(t.clients.contactsHidden, { exact: true }));
            await expectAuditTextFits(page.getByText(t.clients.ownOnly, { exact: true }));
            await expect(button(page, t.clientCard.edit)).toHaveCount(0);
          } else {
            await button(page, t.clientCard.edit).click();
            await expect(
              page.getByRole('textbox', { name: t.clientCard.phone, exact: true }),
            ).toHaveValue(detail.phone!);
            await button(page, t.clientCard.saveEdit).click();
            await expect(page.getByText(t.clientCard.nothing, { exact: true })).toBeVisible();
          }
        });
      });
    }
  });
}
