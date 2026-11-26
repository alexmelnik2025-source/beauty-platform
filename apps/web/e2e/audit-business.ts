import { expect, type Locator, type Page } from '@playwright/test';
import type { Location, PermissionCatalog, StaffList } from '../../mobile-business/src/api';

const organization = '/v1/organizations/org';
export const auditBase = `${organization}/locations/loc`;
const createdAt = '2026-11-01T08:00:00Z';
const salon: Location = {
  id: 'loc',
  organizationId: 'org',
  name: 'Studio DR',
  slug: 'studio-dr',
  timezone: 'Europe/Warsaw',
  currency: 'PLN',
  addressLine: 'Rynek 1',
  city: 'Warszawa',
  postalCode: '00-001',
  latitude: null,
  longitude: null,
  phone: null,
  email: null,
  defaultLocale: 'pl',
  slotStepMinutes: 15,
  minLeadMinutes: 60,
  bookingHorizonDays: 60,
  clientCancelDeadlineMinutes: 120,
  reminderHoursBefore: 24,
  waitlistHoldMinutes: 0,
  rebookReminderDays: 0,
  rebookReminderText: null,
  onlineBookingEnabled: false,
  shopFulfillment: ['pickup_at_salon'],
  shopReservationDays: 7,
  askMood: false,
  askDrink: false,
  drinks: [],
  askNote: false,
  languages: ['pl'],
  description: null,
  bookingTerms: null,
  privacyPolicy: null,
  version: 1,
  createdAt,
  updatedAt: createdAt,
};

const defaults: PermissionCatalog['me']['permissions'] = {
  createOwnAppointments: true,
  changeOwnAppointments: true,
  bookOutsideHours: false,
  blockOwnTime: false,
  viewClientContacts: false,
  viewClientHistory: false,
  viewClientNotes: false,
  editClientNotes: false,
  viewAllAppointments: false,
  manageAllAppointments: false,
  viewOwnEarnings: false,
};

/** A signed-in salon with no bookings. Install scenario-specific routes afterwards to override reads or hold writes. */
export async function installAuditSession(
  page: Page,
  role: PermissionCatalog['me']['role'],
  overrides: Partial<PermissionCatalog['me']['permissions']> = {},
) {
  const tokens = { accessToken: 'audit-access', refreshToken: 'audit-refresh' };
  await page.addInitScript(
    (token) => localStorage.setItem('beauty.business.refreshToken', token),
    tokens.refreshToken,
  );
  const staff: StaffList = [
    {
      id: 'staff',
      locationId: 'loc',
      userId: role === 'staff' ? 'user' : null,
      displayName: 'Anna',
      active: true,
      languages: ['pl'],
      specialties: [],
      customSpecialty: null,
      serviceIds: [],
      bio: null,
      sortOrder: 0,
      version: 1,
      photoUrl: null,
      createdAt,
      updatedAt: createdAt,
    },
  ];
  const catalog = Object.entries(defaults).map(([key, value]) => ({ key, default: value }));
  const permissions = {
    ...Object.fromEntries(catalog.map((item) => [item.key, role !== 'staff' || item.default])),
    ...overrides,
  };
  const reads: Record<string, unknown> = {
    '/v1/me': {
      user: {
        id: 'user',
        name: 'Anna',
        email: 'audit@example.com',
        locale: 'pl',
        emailVerified: true,
      },
      organizations: [{ id: 'org', name: 'Studio DR', role }],
      isPlatformAdmin: false,
    },
    '/v1/me/notifications/unread-count': { unread: 0 },
    [`${organization}/permissions`]: { permissions: catalog, me: { role, permissions } },
    [`${organization}/locations`]: [salon],
    [auditBase]: salon,
    [`${auditBase}/staff`]: staff,
    [`${auditBase}/services`]: [],
    [`${auditBase}/time-blocks`]: [],
  };
  await page.route('**/v1/**', async (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() === 'POST' && url.pathname === '/v1/auth/refresh') {
      await route.fulfill({ json: tokens });
      return;
    }
    if (route.request().method() === 'GET') {
      if (url.pathname in reads) {
        await route.fulfill({ json: reads[url.pathname] });
        return;
      }
      if (url.pathname === `${auditBase}/calendar`) {
        await route.fulfill({
          json: {
            from: url.searchParams.get('from'),
            to: url.searchParams.get('to'),
            location: salon,
            staff: [],
            timeOff: [],
            appointments: [],
            blocks: [],
          },
        });
        return;
      }
    }
    await route.fulfill({
      status: 501,
      json: { message: `No audit fixture for ${route.request().method()} ${url.pathname}` },
    });
  });
}

/** Chromium mobile text scaling applies to newly mounted Expo screens as well as the current screen. */
export async function scaleAuditText(page: Page, sample: Locator) {
  await expect(sample).toBeVisible();
  const fontSize = () =>
    sample.evaluate((element) => parseFloat(getComputedStyle(element).fontSize));
  const before = await fontSize();
  await page.addStyleTag({ content: '* { -webkit-text-size-adjust: 130% !important }' });
  expect(await fontSize()).toBeCloseTo(before * 1.3, 1);
  expect(await page.evaluate(() => innerWidth)).toBe(320);
}

/** Check actual line boxes of rendered words, including text wrapped inside a control. */
export async function expectAuditTextFits(label: Locator) {
  await expect(label).toBeVisible();
  const clipped = await label.evaluate((element) => {
    const words: string[] = [];
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const box = node.parentElement!.getBoundingClientRect();
      for (const match of (node.textContent ?? '').matchAll(/\S+/gu)) {
        range.setStart(node, match.index);
        range.setEnd(node, match.index + match[0].length);
        if (
          [...range.getClientRects()].some(
            (line) =>
              line.left < Math.max(0, box.left) - 1 ||
              line.right > Math.min(innerWidth, box.right) + 1 ||
              line.top < box.top - 1 ||
              line.bottom > box.bottom + 1,
          )
        )
          words.push(match[0]);
      }
    }
    return words;
  });
  expect(clipped, label.toString()).toEqual([]);
}
