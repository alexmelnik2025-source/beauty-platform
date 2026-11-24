import { expect, it, vi } from 'vitest';
import { BusinessApi } from '../src/api';
import { checkRequests } from './support/apiRequests';

const orgId = 'org/1';
const salonId = 'salon 2';
const org = '/v1/organizations/org%2F1';
const salon = `${org}/locations/salon%202`;
const date = '2026-11-24';

const staffId = 'staff/3';
const serviceId = 'service#4';
const staff = `${salon}/staff/staff%2F3`;
const service = `${salon}/services/service%234`;
const loyalty = `${org}/loyalty`;
const guard = `${salon}/cancellation-guard`;
const clientGuard = `${guard}/clients/client%2F5`;
const picture = new Blob(['image bytes'], { type: 'image/png' });
const intervals = [{ start: '09:00', end: '17:30' }];
const days = [{ weekday: 2, intervals }];
const invitation = {
  email: 'user@example.com',
  role: 'staff' as const,
  locationIds: [salonId],
  locale: 'pl' as const,
  staffMemberId: staffId,
};
const policy = { viewClientContacts: false, viewClientHistory: true };
const newService = {
  name: 'Cut',
  description: null,
  durationMinutes: 35,
  bufferMinutes: 5,
  priceGrosze: 5500,
  active: true,
  categoryId: null,
  color: null,
  wishPhotos: false,
  staffIds: [staffId],
};
const tiers = {
  basis: 'visits' as const,
  periodDays: 90,
  tiers: [{ name: 'Gold', threshold: 5, discountPercent: 10 }],
};
const program = {
  mode: 'points' as const,
  enabled: true,
  stampsPerVisit: 1,
  pointsPerUnit: 2,
  spendUnitGrosze: 500,
  minSpendGrosze: 0,
  pointsValidityDays: null,
  maxDiscountPercent: 30,
  allowStacking: false,
  marketplaceEnabled: false,
  version: 7,
};
const bonus = {
  rules: [
    {
      name: 'Tuesday',
      staffIds: [staffId],
      weekdays: [2],
      multiplier: 2,
      extraPoints: 0,
      withinDays: null,
    },
  ],
};
const earn = { rules: [{ serviceId, points: 3 }] };
const reward = {
  name: 'Discount',
  kind: 'discount_percent' as const,
  discountPercent: 15,
  freeServiceId: null,
  cost: 30,
  couponValidityDays: null,
  serviceIds: [serviceId],
};
const promotion = {
  weekdays: [2],
  start: '09:00',
  end: '12:00',
  discountPercent: 10,
  staffIds: [staffId],
  serviceIds: [serviceId],
};
const protection = {
  enabled: true,
  maxChanges: null,
  windowHours: 24,
  lateCancelMinutes: 15,
  maxNoShows: 2,
  action: 'approval' as const,
  version: 3,
};
const reviewSettings = { enabled: false, version: 6, requestHours: 48 };

checkRequests('business settings', 'ru', [
  {
    name: 'locations',
    method: 'GET',
    path: `${org}/locations`,
    call: (api) => api.locations(orgId),
  },
  {
    name: 'location',
    method: 'GET',
    path: salon,
    call: (api) => api.location(orgId, salonId),
  },
  {
    name: 'publicHours',
    method: 'GET',
    path: '/v1/public/locations/salon%2Fcentrum',
    call: (api) => api.publicHours('salon/centrum'),
    publicHours: true,
  },
  {
    name: 'legalTemplates',
    method: 'GET',
    path: `${salon}/legal-templates`,
    call: (api) => api.legalTemplates(orgId, salonId),
  },
  {
    name: 'updateLocation',
    method: 'PATCH',
    path: salon,
    call: (api) =>
      api.updateLocation(orgId, salonId, 4, { onlineBookingEnabled: false, phone: null }),
    body: { version: 4, onlineBookingEnabled: false, phone: null },
  },
  {
    name: 'addSalonPhoto',
    method: 'POST',
    path: `${salon}/photos`,
    call: (api) => api.addSalonPhoto(orgId, salonId, picture, 'image/png'),
    body: picture,
  },
  {
    name: 'setStaffPhoto',
    method: 'PUT',
    path: `${staff}/photo`,
    call: (api) => api.setStaffPhoto(orgId, salonId, staffId, picture, 'image/png'),
    body: picture,
  },
  {
    name: 'removeStaffPhoto',
    method: 'DELETE',
    path: `${staff}/photo`,
    call: (api) => api.removeStaffPhoto(orgId, salonId, staffId),
    noContent: true,
  },
  {
    name: 'updateStaff',
    method: 'PATCH',
    path: staff,
    call: (api) => api.updateStaff(orgId, salonId, staffId, 2, { bio: null, active: false }),
    body: { version: 2, bio: null, active: false },
  },
  {
    name: 'setStaffServices',
    method: 'PUT',
    path: `${staff}/services`,
    call: (api) => api.setStaffServices(orgId, salonId, staffId, [serviceId]),
    body: { serviceIds: [serviceId] },
  },
  {
    name: 'createStaff',
    method: 'POST',
    path: `${salon}/staff`,
    call: (api) =>
      api.createStaff(orgId, salonId, {
        displayName: 'Ola',
        sortOrder: 4,
        serviceIds: [serviceId],
      }),
    body: { displayName: 'Ola', sortOrder: 4, serviceIds: [serviceId] },
  },
  {
    name: 'reorderStaff',
    method: 'PUT',
    path: `${salon}/staff/order`,
    call: (api) => api.reorderStaff(orgId, salonId, [staffId, 'another']),
    body: { staffIds: [staffId, 'another'] },
  },
  {
    name: 'setStaffLanguages',
    method: 'PUT',
    path: `${staff}/languages`,
    call: (api) => api.setStaffLanguages(orgId, salonId, staffId, ['uk', 'pl']),
    body: { languages: ['uk', 'pl'] },
  },
  {
    name: 'setWorkingHours',
    method: 'PUT',
    path: `${staff}/working-hours`,
    call: (api) => api.setWorkingHours(orgId, salonId, staffId, days),
    body: { days },
  },
  {
    name: 'setSpecialDay',
    method: 'PUT',
    path: `${staff}/working-hours/overrides/2026-11-24`,
    call: (api) => api.setSpecialDay(orgId, salonId, staffId, date, intervals),
    body: { intervals },
  },
  {
    name: 'removeSpecialDay',
    method: 'DELETE',
    path: `${staff}/working-hours/overrides/2026-11-24`,
    call: (api) => api.removeSpecialDay(orgId, salonId, staffId, date),
    noContent: true,
  },
  { name: 'members', method: 'GET', path: `${org}/members`, call: (api) => api.members(orgId) },
  {
    name: 'invitations',
    method: 'GET',
    path: `${org}/invitations`,
    call: (api) => api.invitations(orgId),
  },
  {
    name: 'invite',
    method: 'POST',
    path: `${org}/invitations`,
    call: (api) => api.invite(orgId, invitation),
    body: invitation,
  },
  {
    name: 'cancelInvitation',
    method: 'DELETE',
    path: `${org}/invitations/invite%2F1`,
    call: (api) => api.cancelInvitation(orgId, 'invite/1'),
    noContent: true,
  },
  {
    name: 'staffCategories',
    method: 'GET',
    path: `${org}/staff-categories`,
    call: (api) => api.staffCategories(orgId),
  },
  {
    name: 'createStaffCategory',
    method: 'POST',
    path: `${org}/staff-categories`,
    call: (api) => api.createStaffCategory(orgId, { name: 'Junior', permissions: policy }),
    body: { name: 'Junior', permissions: policy },
  },
  {
    name: 'updateStaffCategory',
    method: 'PATCH',
    path: `${org}/staff-categories/role%2F1`,
    call: (api) => api.updateStaffCategory(orgId, 'role/1', 4, { permissions: policy }),
    body: { permissions: policy, version: 4 },
  },
  {
    name: 'deleteStaffCategory',
    method: 'DELETE',
    path: `${org}/staff-categories/role%2F1`,
    call: (api) => api.deleteStaffCategory(orgId, 'role/1'),
    noContent: true,
  },
  {
    name: 'setMemberPermissions',
    method: 'PUT',
    path: `${org}/members/member%2F8/permissions`,
    call: (api) =>
      api.setMemberPermissions(orgId, 'member/8', {
        version: 7,
        staffCategoryId: null,
        overrides: policy,
      }),
    body: { version: 7, staffCategoryId: null, overrides: policy },
  },
  {
    name: 'removeMember',
    method: 'DELETE',
    path: `${org}/members/member%2F8`,
    call: (api) => api.removeMember(orgId, 'member/8'),
    noContent: true,
  },
  {
    name: 'happyHours',
    method: 'GET',
    path: `${salon}/happy-hours`,
    call: (api) => api.happyHours(orgId, salonId),
  },
  {
    name: 'saveHappyHours',
    method: 'PUT',
    path: `${salon}/happy-hours`,
    call: (api) => api.saveHappyHours(orgId, salonId, [promotion]),
    body: { rules: [promotion] },
  },
  {
    name: 'serviceCategories',
    method: 'GET',
    path: `${salon}/service-categories`,
    call: (api) => api.serviceCategories(orgId, salonId),
  },
  {
    name: 'createServiceCategory',
    method: 'POST',
    path: `${salon}/service-categories`,
    call: (api) => api.createServiceCategory(orgId, salonId, 'Hair'),
    body: { name: 'Hair' },
  },
  {
    name: 'renameServiceCategory',
    method: 'PATCH',
    path: `${salon}/service-categories/cat%2F1`,
    call: (api) => api.renameServiceCategory(orgId, salonId, 'cat/1', 'Cuts', 4),
    body: { name: 'Cuts', version: 4 },
  },
  {
    name: 'deleteServiceCategory',
    method: 'DELETE',
    path: `${salon}/service-categories/cat%2F1`,
    call: (api) => api.deleteServiceCategory(orgId, salonId, 'cat/1'),
    noContent: true,
  },
  {
    name: 'reorderServiceCategories',
    method: 'PUT',
    path: `${salon}/service-categories/order`,
    call: (api) => api.reorderServiceCategories(orgId, salonId, ['cat2', 'cat1']),
    body: { categoryIds: ['cat2', 'cat1'] },
  },
  {
    name: 'createService',
    method: 'POST',
    path: `${salon}/services`,
    call: (api) => api.createService(orgId, salonId, newService),
    body: newService,
  },
  {
    name: 'updateService',
    method: 'PATCH',
    path: service,
    call: (api) =>
      api.updateService(orgId, salonId, serviceId, { version: 2, categoryId: null, active: false }),
    body: { version: 2, categoryId: null, active: false },
  },
  {
    name: 'deleteService',
    method: 'DELETE',
    path: service,
    call: (api) => api.deleteService(orgId, salonId, serviceId),
    noContent: true,
  },
  {
    name: 'setServiceStaff',
    method: 'PUT',
    path: `${service}/staff`,
    call: (api) => api.setServiceStaff(orgId, salonId, serviceId, [staffId]),
    body: { staffIds: [staffId] },
  },
  {
    name: 'staffPrices',
    method: 'GET',
    path: `${salon}/staff-prices`,
    call: (api) => api.staffPrices(orgId, salonId),
  },
  {
    name: 'saveStaffPrices',
    method: 'PUT',
    path: `${service}/staff-prices`,
    call: (api) => api.saveStaffPrices(orgId, salonId, serviceId, [{ staffId, priceGrosze: 6000 }]),
    body: { prices: [{ staffId, priceGrosze: 6000 }] },
  },
  {
    name: 'saveStaffDurations',
    method: 'PUT',
    path: `${service}/staff-durations`,
    call: (api) =>
      api.saveStaffDurations(orgId, salonId, serviceId, [{ staffId, durationMinutes: 35 }]),
    body: { durations: [{ staffId, durationMinutes: 35 }] },
  },
  {
    name: 'reorderServices',
    method: 'PUT',
    path: `${salon}/services/order`,
    call: (api) => api.reorderServices(orgId, salonId, [serviceId, 'other']),
    body: { serviceIds: [serviceId, 'other'] },
  },
  {
    name: 'loyaltyProgram',
    method: 'GET',
    path: `${loyalty}/program`,
    call: (api) => api.loyaltyProgram(orgId),
  },
  {
    name: 'saveLoyaltyProgram',
    method: 'PUT',
    path: `${loyalty}/program`,
    call: (api) => api.saveLoyaltyProgram(orgId, program),
    body: program,
  },
  {
    name: 'loyaltyTiers',
    method: 'GET',
    path: `${loyalty}/tiers`,
    call: (api) => api.loyaltyTiers(orgId),
  },
  {
    name: 'saveLoyaltyTiers',
    method: 'PUT',
    path: `${loyalty}/tiers`,
    call: (api) => api.saveLoyaltyTiers(orgId, tiers),
    body: tiers,
  },
  {
    name: 'loyaltyBonusRules',
    method: 'GET',
    path: `${loyalty}/bonus-rules`,
    call: (api) => api.loyaltyBonusRules(orgId),
  },
  {
    name: 'saveLoyaltyBonusRules',
    method: 'PUT',
    path: `${loyalty}/bonus-rules`,
    call: (api) => api.saveLoyaltyBonusRules(orgId, bonus),
    body: bonus,
  },
  {
    name: 'saveLoyaltyEarnRules',
    method: 'PUT',
    path: `${salon}/loyalty/earn-rules`,
    call: (api) => api.saveLoyaltyEarnRules(orgId, salonId, earn),
    body: earn,
  },
  {
    name: 'loyaltyRewards',
    method: 'GET',
    path: `${loyalty}/rewards`,
    call: (api) => api.loyaltyRewards(orgId),
  },
  {
    name: 'addLoyaltyReward',
    method: 'POST',
    path: `${loyalty}/rewards`,
    call: (api) => api.addLoyaltyReward(orgId, reward),
    body: reward,
  },
  {
    name: 'updateLoyaltyReward',
    method: 'PUT',
    path: `${loyalty}/rewards/reward%2F1`,
    call: (api) =>
      api.updateLoyaltyReward(orgId, 'reward/1', { ...reward, sortOrder: 4, version: 5 }),
    body: { ...reward, sortOrder: 4, version: 5 },
  },
  {
    name: 'removeLoyaltyReward',
    method: 'DELETE',
    path: `${loyalty}/rewards/reward%2F1`,
    call: (api) => api.removeLoyaltyReward(orgId, 'reward/1'),
    noContent: true,
  },
  {
    name: 'loyaltyTransactions',
    method: 'GET',
    path: `${loyalty}/transactions?limit=7`,
    call: (api) => api.loyaltyTransactions(orgId, 7),
  },
  {
    name: 'guardSettings',
    method: 'GET',
    path: guard,
    call: (api) => api.guardSettings(orgId, salonId),
  },
  {
    name: 'saveGuardSettings',
    method: 'PUT',
    path: guard,
    call: (api) => api.saveGuardSettings(orgId, salonId, protection),
    body: protection,
  },
  {
    name: 'guardedClients',
    method: 'GET',
    path: `${guard}/clients`,
    call: (api) => api.guardedClients(orgId, salonId),
  },
  {
    name: 'guardClient',
    method: 'GET',
    path: clientGuard,
    call: (api) => api.guardClient(orgId, salonId, 'client/5'),
  },
  {
    name: 'updateClientRule',
    method: 'PUT',
    path: `${clientGuard}/rule`,
    call: (api) => api.updateClientRule(orgId, salonId, 'client/5', 'trusted'),
    body: { rule: 'trusted' },
  },
  {
    name: 'releaseGuard',
    method: 'POST',
    path: `${clientGuard}/release`,
    call: (api) => api.releaseGuard(orgId, salonId, 'client/5', '  resolved  '),
    body: { note: 'resolved' },
  },
  {
    name: 'notifications',
    method: 'GET',
    path: '/v1/me/notifications?limit=12',
    call: (api) => api.notifications(12),
  },
  {
    name: 'unreadNotifications',
    method: 'GET',
    path: '/v1/me/notifications/unread-count',
    call: (api) => api.unreadNotifications(),
  },
  {
    name: 'markNotificationsRead',
    method: 'POST',
    path: '/v1/me/notifications/read',
    call: (api) => api.markNotificationsRead({ ids: ['n1', 'n2'] }),
    body: { ids: ['n1', 'n2'] },
  },
  {
    name: 'auditLog',
    method: 'GET',
    path: `${org}/audit-log?limit=12&before=2026-11-24T10%3A30%3A00Z`,
    call: (api) => api.auditLog(orgId, '2026-11-24T10:30:00Z', 12),
  },
  {
    name: 'reviewSettings',
    method: 'GET',
    path: `${salon}/review-settings`,
    call: (api) => api.reviewSettings(orgId, salonId),
  },
  {
    name: 'saveReviewSettings',
    method: 'PUT',
    path: `${salon}/review-settings`,
    call: (api) => api.saveReviewSettings(orgId, salonId, reviewSettings),
    body: reviewSettings,
  },
  {
    name: 'reviews',
    method: 'GET',
    path: `${salon}/reviews?before=cursor%2B1&staffId=staff%2F3&serviceId=service%234&rating=4&unanswered=true`,
    call: (api) =>
      api.reviews(orgId, salonId, {
        before: 'cursor+1',
        staffId,
        serviceId,
        rating: 4,
        unanswered: true,
      }),
  },
  {
    name: 'reviewsCsv',
    method: 'GET',
    path: `${salon}/reviews/export.csv?lang=en&staffId=staff%2F3&serviceId=service%234&rating=4&unanswered=true`,
    call: (api) =>
      api.reviewsCsv(orgId, salonId, 'en', { staffId, serviceId, rating: 4, unanswered: true }),
    csvFile: 'opinie.csv',
  },
  {
    name: 'replyToReview',
    method: 'PUT',
    path: `${salon}/reviews/review%2F1/reply`,
    call: (api) => api.replyToReview(orgId, salonId, 'review/1', 'Thank you'),
    body: { text: 'Thank you' },
  },
  {
    name: 'removeReviewReply',
    method: 'DELETE',
    path: `${salon}/reviews/review%2F1/reply`,
    call: (api) => api.removeReviewReply(orgId, salonId, 'review/1'),
  },
  {
    name: 'commissions',
    method: 'GET',
    path: `${salon}/reports/commissions`,
    call: (api) => api.commissions(orgId, salonId),
  },
  {
    name: 'setCommission',
    method: 'PUT',
    path: `${salon}/reports/commissions/staff%2F3`,
    call: (api) => api.setCommission(orgId, salonId, staffId, null),
    body: { commissionPercent: null },
  },
]);

it('requests the public hours in the device language before sign-in', async () => {
  using locale = vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions');
  locale.mockReturnValue({ ...new Intl.DateTimeFormat().resolvedOptions(), locale: 'uk-UA' });
  const fetchFn = vi
    .fn<(url: string, init?: RequestInit) => Promise<Response>>()
    .mockResolvedValueOnce(Response.json({}));
  const api = new BusinessApi(
    'https://api.test',
    { get: async () => null, set: async () => {} },
    fetchFn,
  );
  await api.publicHours('salon');
  expect(new Headers(fetchFn.mock.calls[0]?.[1]?.headers).get('accept-language')).toBe('uk');
});

it('uses the current web app language after the user switches it', async () => {
  const element = { lang: 'pl' };
  vi.stubGlobal('document', { documentElement: element });
  try {
    const languages: (string | null)[] = [];
    const api = new BusinessApi(
      'https://api.test',
      { get: async () => null, set: async () => {} },
      async (_url, init) => {
        languages.push(new Headers(init?.headers).get('accept-language'));
        return Response.json({});
      },
    );
    await api.publicHours('salon');
    element.lang = 'ru';
    await api.publicHours('salon');
    expect(languages).toEqual(['pl', 'ru']);
  } finally {
    vi.unstubAllGlobals();
  }
});

it('rejects a response interrupted after the HTTP success headers', async () => {
  const offline = new TypeError('Connection closed during download');
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(offline);
    },
  });
  const api = new BusinessApi(
    'https://api.test',
    { get: async () => null, set: async () => {} },
    async () => new Response(body),
  );
  await expect(api.publicHours('salon')).rejects.toBe(offline);
});
