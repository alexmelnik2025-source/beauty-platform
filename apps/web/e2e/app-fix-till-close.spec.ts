import { expect, test } from '@playwright/test';
import type { TillClose } from '../../mobile-business/src/api';
import { fill } from '../../mobile-business/src/i18n';
import { pl } from '../../mobile-business/src/locales/pl';
import { serveApp } from './mobile-app';

test.use({ viewport: { width: 320, height: 844 }, isMobile: true, locale: 'pl-PL' });

test('a failed till refresh keeps the reminder and saved count for their day', async ({ page }) => {
  const today = '2026-11-26';
  const yesterday = '2026-11-25';
  const base = '/v1/organizations/org/locations/salon';
  const location = { id: 'salon', name: 'Salon DY', timezone: 'Europe/Warsaw', currency: 'PLN' };
  const app = await serveApp('mobile-business');
  let offline = false;
  let close: TillClose['close'] = null;

  try {
    await page.clock.setFixedTime(new Date(today + 'T12:00:00Z'));
    await page.addInitScript(() => localStorage.setItem('beauty.business.refreshToken', 'test'));
    await page.route('**/v1/**', (route) => {
      const request = route.request();
      const { pathname, searchParams } = new URL(request.url());
      const from = searchParams.get('from');
      if (pathname === base + '/reports/till-close') {
        const date =
          request.method() === 'PUT' ? request.postDataJSON().date : searchParams.get('date');
        if (request.method() === 'PUT') {
          expect(request.postDataJSON()).toMatchObject({
            date: yesterday,
            countedCashGrosze: 2500,
          });
          close = {
            countedCashGrosze: 2500,
            expectedCashGrosze: 2500,
            differenceGrosze: 0,
            note: null,
            closedByName: 'Anna',
            closedAt: yesterday + 'T20:00:00Z',
            nonCashChecked: false,
          };
        } else if (offline) {
          return route.abort('connectionreset');
        }
        const report: TillClose = {
          date: date!,
          currency: 'PLN',
          expectedCashGrosze: 2500,
          visitsCashGrosze: 2500,
          visitsProductsGrosze: 0,
          visitsVoucherGrosze: 0,
          vouchersCashGrosze: 0,
          cashInGrosze: 0,
          cashOutGrosze: 0,
          otherPayments: [],
          movements: [],
          close: date === yesterday ? close : null,
          unclosedDay: date === today && !close ? yesterday : null,
        };
        return route.fulfill({ json: report });
      }
      const replies: Record<string, unknown> = {
        '/v1/auth/refresh': { accessToken: 'test' },
        '/v1/me': {
          user: { id: 'owner' },
          organizations: [{ id: 'org', role: 'owner', name: 'DY' }],
        },
        '/v1/organizations/org/locations': [location],
        '/v1/organizations/org/permissions': { me: { role: 'owner', permissions: {} } },
        [base + '/calendar']: { from, to: from, location, staff: [], appointments: [] },
        [base + '/reports']: {
          from,
          to: from,
          location,
          scope: 'location',
          totals: { completed: 1, paid: 1, revenueGrosze: 2500 },
          payments: [],
          tips: { totalGrosze: 0 },
        },
      };
      return pathname in replies
        ? route.fulfill({ json: replies[pathname] })
        : route.fulfill({ status: 404 });
    });

    await page.goto(app.url);
    await page.addStyleTag({ content: '* { -webkit-text-size-adjust: 130% !important }' });
    const till = page.getByTestId('till');
    const reminder = page.getByTestId('till-reminder');
    const start = till.getByRole('button', { name: pl.day.tillClose, exact: true });
    const refreshDay = page.getByRole('button', { name: pl.day.refresh, exact: true });
    const error = till.getByRole('alert');
    await expect(start).toBeVisible();
    await expect(reminder).toBeVisible();

    offline = true;
    await refreshDay.click();
    await expect(error).toHaveText(pl.error.network);
    await expect(start).toBeEnabled();
    await reminder.getByRole('button', { name: pl.day.tillUnclosedOpen }).click();

    // Yesterday has its own first load. Today's cached count cannot be used to close it.
    await expect(reminder).toHaveCount(0);
    await expect(error).toHaveText(pl.error.network);
    await expect(start).toHaveCount(0);
    offline = false;
    await till.getByRole('button', { name: `${pl.day.refresh}: ${pl.day.tillClose}` }).click();
    await expect(error).toHaveCount(0);
    await start.click();
    await till
      .getByRole('textbox', { name: fill(pl.day.tillCounted, { currency: 'PLN' }) })
      .fill('25');
    await till.getByRole('button', { name: pl.day.tillSave }).click();
    await expect(till.getByTestId('till-diff')).toHaveText(pl.day.tillMatches);

    offline = true;
    await refreshDay.click();
    await expect(error).toHaveText(pl.error.network);
    await expect(till.getByRole('button', { name: pl.day.tillRecount })).toBeEnabled();
    await expect(start).toHaveCount(0);
  } finally {
    app.server.close();
  }
});
