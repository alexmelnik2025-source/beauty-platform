import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { registeredResponseSchema } from '../src/common/openapi';
import { addDays, localToday } from '../src/scheduling/time';
import {
  createOrgWithLocation,
  createTestApp,
  expectError,
  resetState,
  signUp,
  type SignedInUser,
  type TestContext,
} from './helpers';

/** Task 490: "Bony podarunkowe" — gift vouchers sold at the salon's till. */

let ctx: TestContext;
let owner: SignedInUser;
let staffUser: SignedInUser;
let base: string;
let locationId: string;

beforeAll(async () => {
  ctx = await createTestApp();
});

afterAll(async () => {
  await ctx.app.close();
});

beforeEach(async () => {
  await resetState(ctx);
  owner = await signUp(ctx, 'owner@example.com', 'Anna Owner');
  const created = await createOrgWithLocation(ctx, owner, 'Barber');
  locationId = created.locationId;
  base = `/v1/organizations/${created.orgId}/locations/${locationId}/gift-vouchers`;
  staffUser = await signUp(ctx, 'kasia@example.com', 'Kasia');
  await ctx.prisma.membership.create({
    data: {
      userId: staffUser.userId,
      organizationId: created.orgId,
      role: 'staff',
      locations: { create: [{ locationId }] },
    },
  });
});

const expectShape = (name: string, body: unknown) =>
  expect(registeredResponseSchema(name).safeParse(body).error).toBeUndefined();

type Voucher = {
  id: string;
  code: string;
  balanceGrosze: number;
  status: string;
  validUntil: string | null;
};

describe('gift vouchers (task 490)', () => {
  it('sells a voucher, takes payments in parts until nothing is left', async () => {
    const created = await ctx
      .http()
      .post(base)
      .set(owner.auth)
      .send({ amountGrosze: 20000, recipient: 'Jan Kowalski', note: 'Na urodziny' })
      .expect(201);
    expectShape('GiftVoucher', created.body);
    const voucher = created.body as Voucher & { soldByName: string; soldDate: string };
    expect(voucher).toMatchObject({
      amountGrosze: 20000,
      balanceGrosze: 20000,
      status: 'active',
      validUntil: null,
      recipient: 'Jan Kowalski',
      note: 'Na urodziny',
      soldByName: 'Anna Owner',
      cancelledAt: null,
    });
    expect(voucher.code).toMatch(/^[A-HJKMNP-Z2-9]{8}$/);
    expect(voucher.soldDate).toBe(localToday(Date.now(), 'Europe/Warsaw'));

    // The specialist at the till finds it by the code (any case, spaces and dashes)…
    const typed = `${voucher.code.slice(0, 4).toLowerCase()}-${voucher.code.slice(4)} `;
    const found = await ctx
      .http()
      .get(`${base}/code/${encodeURIComponent(typed)}`)
      .set(staffUser.auth)
      .expect(200);
    expectShape('GiftVoucherDetails', found.body);
    expect(found.body).toMatchObject({ voucher: { id: voucher.id }, uses: [] });
    await ctx.http().get(`${base}/code/ZZZZZZZZ`).set(staffUser.auth).expect(404);

    // …and takes a payment with it.
    const redeem = (amountGrosze: number, auth = staffUser.auth, id = voucher.id) =>
      ctx.http().post(`${base}/${id}/redeem`).set(auth).send({ amountGrosze, note: 'Strzyżenie' });
    const first = await redeem(12000).expect(200);
    expectShape('GiftVoucherDetails', first.body);
    expect(first.body.voucher).toMatchObject({ balanceGrosze: 8000, status: 'active' });
    expect(first.body.uses).toMatchObject([
      { amountGrosze: 12000, note: 'Strzyżenie', byName: 'Kasia' },
    ]);

    // More than is left is refused and nothing changes.
    expectError((await redeem(8001).expect(409)).body, 'VOUCHER_BALANCE');
    await redeem(0).expect(400);

    // Two payments at the same moment never use more than is left.
    const both = await Promise.all([redeem(5000), redeem(5000)]);
    expect(both.map((r) => r.status).sort()).toEqual([200, 409]);
    const last = await redeem(3000).expect(200);
    expect(last.body.voucher).toMatchObject({ balanceGrosze: 0, status: 'used' });
    expect((last.body.uses as unknown[]).length).toBe(3);
    expectError((await redeem(1).expect(409)).body, 'VOUCHER_BALANCE');

    // The list: owners and managers, newest first, with what is left on the active ones.
    const second = (
      await ctx.http().post(base).set(owner.auth).send({ amountGrosze: 15000 }).expect(201)
    ).body as Voucher;
    expect(second.code).not.toBe(voucher.code);
    const list = await ctx.http().get(base).set(owner.auth).expect(200);
    expectShape('GiftVoucherList', list.body);
    expect(list.body.vouchers.map((v: Voucher) => v.id)).toEqual([second.id, voucher.id]);
    expect(list.body.activeBalanceGrosze).toBe(15000);
    await ctx.http().get(base).set(staffUser.auth).expect(403);
    await ctx.http().post(base).set(staffUser.auth).send({ amountGrosze: 5000 }).expect(403);
  });

  it('refuses expired and cancelled vouchers', async () => {
    const today = localToday(Date.now(), 'Europe/Warsaw');
    await ctx
      .http()
      .post(base)
      .set(owner.auth)
      .send({ amountGrosze: 5000, validUntil: addDays(today, -1) })
      .expect(400)
      .then((r) => expectError(r.body, 'VOUCHER_DATE_PAST'));
    await ctx.http().post(base).set(owner.auth).send({ amountGrosze: 50 }).expect(400);

    const lastDay = (
      await ctx
        .http()
        .post(base)
        .set(owner.auth)
        .send({ amountGrosze: 5000, validUntil: today })
        .expect(201)
    ).body as Voucher;
    expect(lastDay).toMatchObject({ validUntil: today, status: 'active' });
    // Its last day passes.
    await ctx.prisma.giftVoucher.update({
      where: { id: lastDay.id },
      data: { validUntil: new Date(`${addDays(today, -1)}T00:00:00.000Z`) },
    });
    const expired = await ctx
      .http()
      .post(`${base}/${lastDay.id}/redeem`)
      .set(owner.auth)
      .send({ amountGrosze: 100 })
      .expect(409);
    expectError(expired.body, 'VOUCHER_EXPIRED');

    const sold = (
      await ctx.http().post(base).set(owner.auth).send({ amountGrosze: 7000 }).expect(201)
    ).body as Voucher;
    await ctx.http().post(`${base}/${sold.id}/cancel`).set(staffUser.auth).expect(403);
    const cancelled = await ctx
      .http()
      .post(`${base}/${sold.id}/cancel`)
      .set(owner.auth)
      .expect(200);
    expectShape('GiftVoucher', cancelled.body);
    expect(cancelled.body.status).toBe('cancelled');
    const refused = await ctx
      .http()
      .post(`${base}/${sold.id}/redeem`)
      .set(owner.auth)
      .send({ amountGrosze: 100 })
      .expect(409);
    expectError(refused.body, 'VOUCHER_CANCELLED');

    const list = await ctx.http().get(base).set(owner.auth).expect(200);
    expect(Object.fromEntries(list.body.vouchers.map((v: Voucher) => [v.id, v.status]))).toEqual({
      [lastDay.id]: 'expired',
      [sold.id]: 'cancelled',
    });
    expect(list.body.activeBalanceGrosze).toBe(0);
  });

  it('keeps the vouchers of each salon to itself', async () => {
    const voucher = (
      await ctx.http().post(base).set(owner.auth).send({ amountGrosze: 9000 }).expect(201)
    ).body as Voucher;
    const other = await signUp(ctx, 'other@example.com');
    const theirs = await createOrgWithLocation(ctx, other, 'Other');
    const theirBase = `/v1/organizations/${theirs.orgId}/locations/${theirs.locationId}/gift-vouchers`;
    // Another salon cannot reach ours, not even through its own address.
    await ctx.http().get(`${base}/${voucher.id}`).set(other.auth).expect(404);
    await ctx.http().get(`${theirBase}/${voucher.id}`).set(other.auth).expect(404);
    await ctx.http().get(`${theirBase}/code/${voucher.code}`).set(other.auth).expect(404);
    await ctx
      .http()
      .post(`${theirBase}/${voucher.id}/redeem`)
      .set(other.auth)
      .send({ amountGrosze: 100 })
      .expect(404);
    await ctx.http().post(`${theirBase}/${voucher.id}/cancel`).set(other.auth).expect(404);
    const mine = await ctx.http().get(`${base}/${voucher.id}`).set(owner.auth).expect(200);
    expect(mine.body.voucher.balanceGrosze).toBe(9000);
    expect((await ctx.http().get(theirBase).set(other.auth).expect(200)).body.vouchers).toEqual([]);
  });
});

describe('"Bony podarunkowe" in the report (task 493)', () => {
  it('counts the vouchers sold and the payments of the period, and what is left today', async () => {
    const sell = async (amountGrosze: number) =>
      (await ctx.http().post(base).set(owner.auth).send({ amountGrosze }).expect(201))
        .body as Voucher;
    const a = await sell(20000);
    const b = await sell(10000);
    const c = await sell(5000);
    await ctx.http().post(`${base}/${c.id}/cancel`).set(owner.auth).expect(200);
    await ctx
      .http()
      .post(`${base}/${a.id}/redeem`)
      .set(staffUser.auth)
      .send({ amountGrosze: 12000 })
      .expect(200);
    await ctx
      .http()
      .post(`${base}/${b.id}/redeem`)
      .set(owner.auth)
      .send({ amountGrosze: 10000 })
      .expect(200);
    // A voucher sold long ago: not sold in the period, but what is left on it counts today.
    const old = await sell(3000);
    await ctx.prisma.giftVoucher.update({
      where: { id: old.id },
      data: { createdAt: new Date('2025-01-15T12:00:00Z') },
    });

    const today = localToday(Date.now(), 'Europe/Warsaw');
    const reports = base.replace('/gift-vouchers', '/reports');
    const report = await ctx
      .http()
      .get(reports)
      .query({ from: addDays(today, -6), to: today })
      .set(owner.auth)
      .expect(200);
    expectShape('SalonReport', report.body);
    expect(report.body.giftVouchers).toEqual({
      sold: 2,
      soldGrosze: 30000,
      payments: 2,
      paidGrosze: 22000,
      activeBalanceGrosze: 8000 + 3000,
    });

    // A period without them: nothing sold or paid, what is left today is the same.
    const earlier = await ctx
      .http()
      .get(reports)
      .query({ from: '2025-02-01', to: '2025-02-28' })
      .set(owner.auth)
      .expect(200);
    expect(earlier.body.giftVouchers).toEqual({
      sold: 0,
      soldGrosze: 0,
      payments: 0,
      paidGrosze: 0,
      activeBalanceGrosze: 11000,
    });
  });
});
