import { checkRequests } from './support/apiRequests';

const orgId = 'org/1';
const salonId = 'salon 2';
const org = '/v1/organizations/org%2F1';
const salon = `${org}/locations/salon%202`;
const date = '2026-11-24';

const clientId = 'client/3';
const visitId = 'visit#4';
const voucherId = 'voucher/5';
const client = `${org}/customers/client%2F3`;
const visit = `${salon}/appointments/visit%234`;
const vouchers = `${salon}/gift-vouchers`;
const voucher = `${vouchers}/voucher%2F5`;
const products = `${salon}/products`;
const newClient = {
  name: 'Anna',
  phone: '+48123456789',
  locale: 'pl' as const,
  allowDuplicatePhone: true,
};
const voucherSale = {
  amountGrosze: 20000,
  validUntil: date,
  recipient: 'Ewa',
  note: null,
  paymentMethod: 'cash' as const,
};
const voucherUpdate = { validUntil: null, recipient: null, note: 'Gift' };
const block = {
  staffId: null,
  start: '2026-11-24T09:00:00+01:00',
  end: '2026-11-24T11:00:00+01:00',
  reason: 'Training',
};
const quantities = [{ productId: 'p1', quantity: 0 }];
const shipment = [{ productId: 'p2', quantity: 3 }];

checkRequests('business clients-visits', 'uk', [
  {
    name: 'customerTags',
    method: 'GET',
    path: `${org}/customers/tags`,
    call: (api) => api.customerTags(orgId),
  },
  {
    name: 'customerSegments',
    method: 'GET',
    path: `${org}/customers/segments`,
    call: (api) => api.customerSegments(orgId),
  },
  {
    name: 'customer',
    method: 'GET',
    path: client,
    call: (api) => api.customer(orgId, clientId),
  },
  {
    name: 'createCustomer',
    method: 'POST',
    path: `${org}/customers`,
    call: (api) => api.createCustomer(orgId, newClient),
    body: newClient,
  },
  {
    name: 'updateCustomerContacts',
    method: 'PATCH',
    path: client,
    call: (api) => api.updateCustomerContacts(orgId, clientId, 4, { email: null, locale: 'en' }),
    body: { version: 4, email: null, locale: 'en' },
  },
  {
    name: 'exportCustomer',
    method: 'GET',
    path: `${client}/export`,
    call: (api) => api.exportCustomer(orgId, clientId),
  },
  {
    name: 'anonymizeCustomer',
    method: 'POST',
    path: `${client}/anonymize`,
    call: (api) => api.anonymizeCustomer(orgId, clientId, 8),
    body: { version: 8 },
  },
  {
    name: 'updateCustomerNotes',
    method: 'PATCH',
    path: client,
    call: (api) => api.updateCustomerNotes(orgId, clientId, 2, null, ['VIP']),
    body: { version: 2, note: null, tags: ['VIP'] },
  },
  {
    name: 'updateCustomerBirthday',
    method: 'PATCH',
    path: client,
    call: (api) => api.updateCustomerBirthday(orgId, clientId, 3, null),
    body: { version: 3, birthday: null },
  },
  {
    name: 'loyaltyAccount',
    method: 'GET',
    path: `${org}/loyalty/accounts/client%2F3`,
    call: (api) => api.loyaltyAccount(orgId, clientId),
  },
  {
    name: 'redeemLoyaltyReward',
    method: 'POST',
    path: `${org}/loyalty/accounts/client%2F3/redemptions`,
    call: (api) => api.redeemLoyaltyReward(orgId, clientId, 'reward-6'),
    body: { rewardId: 'reward-6' },
  },
  {
    name: 'adjustLoyaltyBalance',
    method: 'POST',
    path: `${org}/loyalty/accounts/client%2F3/adjustments`,
    call: (api) => api.adjustLoyaltyBalance(orgId, clientId, -2, 'Correction'),
    body: { points: -2, reason: 'Correction' },
  },
  {
    name: 'cancelLoyaltyCoupon',
    method: 'POST',
    path: `${org}/loyalty/coupons/coupon%2F6/cancel`,
    call: (api) => api.cancelLoyaltyCoupon(orgId, 'coupon/6', 4),
    body: { version: 4 },
  },
  {
    name: 'calendarRange',
    method: 'GET',
    path: `${salon}/calendar?from=2026-11-24&to=2026-11-30`,
    call: (api) => api.calendarRange(orgId, salonId, date, '2026-11-30'),
  },
  {
    name: 'visitPhotos',
    method: 'GET',
    path: `${visit}/photos`,
    call: (api) => api.visitPhotos(orgId, salonId, visitId),
  },
  {
    name: 'approve',
    method: 'POST',
    path: `${visit}/approve`,
    call: (api) => api.approve(orgId, salonId, visitId, 5),
    body: { version: 5 },
  },
  {
    name: 'setTip',
    method: 'PUT',
    path: `${visit}/tip`,
    call: (api) => api.setTip(orgId, salonId, visitId, 9, 0),
    body: { version: 9, tipGrosze: 0 },
  },
  {
    name: 'waitlist',
    method: 'GET',
    path: `${salon}/waitlist?from=2026-11-24`,
    call: (api) => api.waitlist(orgId, salonId, date),
  },
  {
    name: 'removeFromWaitlist',
    method: 'POST',
    path: `${salon}/waitlist/entry%2F1/remove`,
    call: (api) => api.removeFromWaitlist(orgId, salonId, 'entry/1'),
  },
  {
    name: 'visitCoupons',
    method: 'GET',
    path: `${visit}/coupons`,
    call: (api) => api.visitCoupons(orgId, salonId, visitId),
  },
  {
    name: 'applyVisitCoupon by ID',
    method: 'POST',
    path: `${visit}/coupons`,
    call: (api) => api.applyVisitCoupon(orgId, salonId, visitId, 2, { couponId: 'coupon/1' }),
    body: { version: 2, couponId: 'coupon/1' },
  },
  {
    name: 'applyVisitCoupon by code',
    method: 'POST',
    path: `${visit}/coupons`,
    call: (api) => api.applyVisitCoupon(orgId, salonId, visitId, 3, { code: 'PROMO' }),
    body: { version: 3, code: 'PROMO' },
  },
  {
    name: 'removeVisitCoupon',
    method: 'POST',
    path: `${visit}/coupons/coupon%2F1/remove`,
    call: (api) => api.removeVisitCoupon(orgId, salonId, visitId, 4, 'coupon/1'),
    body: { version: 4 },
  },
  {
    name: 'setTierDiscount',
    method: 'POST',
    path: `${visit}/tier-discount`,
    call: (api) => api.setTierDiscount(orgId, salonId, visitId, 5, true),
    body: { version: 5 },
  },
  {
    name: 'setTierDiscount',
    method: 'POST',
    path: `${visit}/tier-discount/remove`,
    call: (api) => api.setTierDiscount(orgId, salonId, visitId, 6, false),
    body: { version: 6 },
  },
  {
    name: 'giftVouchers',
    method: 'GET',
    path: vouchers,
    call: (api) => api.giftVouchers(orgId, salonId),
  },
  {
    name: 'giftVouchersCsv',
    method: 'GET',
    path: `${vouchers}/export.csv?locale=en`,
    call: (api) => api.giftVouchersCsv(orgId, salonId, 'en'),
    csvFile: 'vouchers.csv',
  },
  {
    name: 'giftVoucherUsesCsv',
    method: 'GET',
    path: `${vouchers}/uses.csv?locale=en`,
    call: (api) => api.giftVoucherUsesCsv(orgId, salonId, 'en'),
    csvFile: 'voucher-payments.csv',
  },
  {
    name: 'sellGiftVoucher',
    method: 'POST',
    path: vouchers,
    call: (api) => api.sellGiftVoucher(orgId, salonId, voucherSale),
    body: voucherSale,
  },
  {
    name: 'giftVoucherByCode',
    method: 'GET',
    path: `${vouchers}/code/GC%20%2F%23`,
    call: (api) => api.giftVoucherByCode(orgId, salonId, ' GC /# '),
  },
  {
    name: 'giftVoucher',
    method: 'GET',
    path: voucher,
    call: (api) => api.giftVoucher(orgId, salonId, voucherId),
  },
  {
    name: 'redeemGiftVoucher for a visit',
    method: 'POST',
    path: `${voucher}/redeem`,
    call: (api) => api.redeemGiftVoucher(orgId, salonId, voucherId, 950, '  Visit  ', visitId),
    body: { amountGrosze: 950, note: 'Visit', appointmentId: visitId },
  },
  {
    name: 'redeemGiftVoucher without a note or a visit',
    method: 'POST',
    path: `${voucher}/redeem`,
    call: (api) => api.redeemGiftVoucher(orgId, salonId, voucherId, 100, '  '),
    body: { amountGrosze: 100 },
  },
  {
    name: 'visitVoucherPayments',
    method: 'GET',
    path: `${visit}/gift-voucher-payments`,
    call: (api) => api.visitVoucherPayments(orgId, salonId, visitId),
  },
  {
    name: 'undoGiftVoucherUse',
    method: 'POST',
    path: `${voucher}/uses/use%3F1/undo`,
    call: (api) => api.undoGiftVoucherUse(orgId, salonId, voucherId, 'use?1'),
  },
  {
    name: 'updateGiftVoucher',
    method: 'PATCH',
    path: voucher,
    call: (api) => api.updateGiftVoucher(orgId, salonId, voucherId, voucherUpdate),
    body: voucherUpdate,
  },
  {
    name: 'cancelGiftVoucher',
    method: 'POST',
    path: `${voucher}/cancel`,
    call: (api) => api.cancelGiftVoucher(orgId, salonId, voucherId),
  },
  {
    name: 'productSales',
    method: 'GET',
    path: `${visit}/products`,
    call: (api) => api.productSales(orgId, salonId, visitId),
  },
  {
    name: 'addProductSale',
    method: 'POST',
    path: `${visit}/products`,
    call: (api) => api.addProductSale(orgId, salonId, visitId, 'p1', 3),
    body: { productId: 'p1', quantity: 3 },
  },
  {
    name: 'removeProductSale',
    method: 'DELETE',
    path: `${visit}/products/sale%2F1`,
    call: (api) => api.removeProductSale(orgId, salonId, visitId, 'sale/1'),
  },
  {
    name: 'visitReservations',
    method: 'GET',
    path: `${visit}/reservations`,
    call: (api) => api.visitReservations(orgId, salonId, visitId),
  },
  {
    name: 'reservationAction',
    method: 'POST',
    path: `${visit}/reservations/res%2F1/hand-over`,
    call: (api) => api.reservationAction(orgId, salonId, visitId, 'res/1', 'hand-over'),
  },
  {
    name: 'reservationAction',
    method: 'POST',
    path: `${visit}/reservations/res%2F1/cancel`,
    call: (api) => api.reservationAction(orgId, salonId, visitId, 'res/1', 'cancel'),
  },
  {
    name: 'products',
    method: 'GET',
    path: products,
    call: (api) => api.products(orgId, salonId),
  },
  {
    name: 'addProduct',
    method: 'POST',
    path: products,
    call: (api) =>
      api.addProduct(orgId, salonId, 'Oil', 2900, 8, 2, 1400, 'Supplier', '12345678', true),
    body: {
      name: 'Oil',
      priceGrosze: 2900,
      stockQuantity: 8,
      lowStockAt: 2,
      purchasePriceGrosze: 1400,
      supplier: 'Supplier',
      barcode: '12345678',
      inSalonShop: true,
    },
  },
  {
    name: 'catalogSearch',
    method: 'GET',
    path: `${salon}/shop/catalog?q=oil%20%26%20wax&limit=20`,
    call: (api) => api.catalogSearch(orgId, salonId, 'oil & wax'),
  },
  {
    name: 'catalogCard',
    method: 'GET',
    path: `${salon}/shop/catalog/card%2F1`,
    call: (api) => api.catalogCard(orgId, salonId, 'card/1'),
  },
  {
    name: 'createCatalogCard',
    method: 'POST',
    path: `${salon}/shop/catalog`,
    call: (api) => api.createCatalogCard(orgId, salonId, { name: 'Oil', brand: null }),
    body: { name: 'Oil', brand: null },
  },
  {
    name: 'baseStatus',
    method: 'GET',
    path: `${salon}/shop/integrations/base`,
    call: (api) => api.baseStatus(orgId, salonId),
  },
  {
    name: 'syncBase',
    method: 'POST',
    path: `${salon}/shop/integrations/base/sync`,
    call: (api) => api.syncBase(orgId, salonId),
  },
  {
    name: 'restockProduct',
    method: 'POST',
    path: `${products}/p%2F1/restock`,
    call: (api) => api.restockProduct(orgId, salonId, 'p/1', 5),
    body: { quantity: 5 },
  },
  {
    name: 'writeOffProduct',
    method: 'POST',
    path: `${products}/p%2F1/write-off`,
    call: (api) => api.writeOffProduct(orgId, salonId, 'p/1', 1, 'Broken'),
    body: { quantity: 1, note: 'Broken' },
  },
  {
    name: 'stocktake',
    method: 'POST',
    path: `${products}/stocktake`,
    call: (api) => api.stocktake(orgId, salonId, quantities),
    body: { counts: quantities },
  },
  {
    name: 'delivery',
    method: 'POST',
    path: `${products}/delivery`,
    call: (api) => api.delivery(orgId, salonId, shipment),
    body: { items: shipment },
  },
  {
    name: 'stockHistory',
    method: 'GET',
    path: `${products}/p%2F1/stock-history`,
    call: (api) => api.stockHistory(orgId, salonId, 'p/1'),
  },
  {
    name: 'updateProduct',
    method: 'PATCH',
    path: `${products}/p%2F1`,
    call: (api) => api.updateProduct(orgId, salonId, 'p/1', { active: false, stockQuantity: null }),
    body: { active: false, stockQuantity: null },
  },
  {
    name: 'removeProduct',
    method: 'DELETE',
    path: `${products}/p%2F1`,
    call: (api) => api.removeProduct(orgId, salonId, 'p/1'),
    noContent: true,
  },
  {
    name: 'stockHistoryCsv',
    method: 'GET',
    path: `${salon}/reports/stock-history-csv?from=2026-11-24&to=2026-11-30&locale=en`,
    call: (api) => api.stockHistoryCsv(orgId, salonId, date, '2026-11-30', 'en'),
    csvFile: 'stock-history-2026-11-24-2026-11-30.csv',
  },
  {
    name: 'timeBlocks',
    method: 'GET',
    path: `${salon}/time-blocks?from=2026-11-24&to=2026-11-24`,
    call: (api) => api.timeBlocks(orgId, salonId, date),
  },
  {
    name: 'addTimeBlock',
    method: 'POST',
    path: `${salon}/time-blocks`,
    call: (api) => api.addTimeBlock(orgId, salonId, block),
    body: block,
  },
  {
    name: 'addTimeBlockSeries',
    method: 'POST',
    path: `${salon}/time-blocks/series`,
    call: (api) => api.addTimeBlockSeries(orgId, salonId, { ...block, weeks: 3 }),
    body: { ...block, weeks: 3 },
  },
  {
    name: 'removeTimeBlockSeries',
    method: 'DELETE',
    path: `${salon}/time-blocks/series/series%2F1`,
    call: (api) => api.removeTimeBlockSeries(orgId, salonId, 'series/1'),
    noContent: true,
  },
  {
    name: 'removeTimeBlock',
    method: 'DELETE',
    path: `${salon}/time-blocks/block%2F1`,
    call: (api) => api.removeTimeBlock(orgId, salonId, 'block/1'),
    noContent: true,
  },
]);
