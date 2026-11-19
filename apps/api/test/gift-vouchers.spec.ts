import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { registeredResponseSchema } from '../src/common/openapi';
import { addDays, localToday, zonedToInstant } from '../src/scheduling/time';
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
let slug: string;

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
  slug = created.slug;
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

  it('"Zmień bon": owners and managers move the last day and fix who it is for (task 498)', async () => {
    const today = localToday(Date.now(), 'Europe/Warsaw');
    const sold = (
      await ctx
        .http()
        .post(base)
        .set(owner.auth)
        .send({ amountGrosze: 10000, validUntil: today, recipient: 'Jan', note: 'Na urodziny' })
        .expect(201)
    ).body as Voucher;
    // Its last day passes: it cannot be used…
    await ctx.prisma.giftVoucher.update({
      where: { id: sold.id },
      data: { validUntil: new Date(`${addDays(today, -1)}T00:00:00.000Z`) },
    });
    await ctx
      .http()
      .post(`${base}/${sold.id}/redeem`)
      .set(owner.auth)
      .send({ amountGrosze: 100 })
      .expect(409);
    // …until the salon gives it more time.
    const later = addDays(today, 30);
    await ctx
      .http()
      .patch(`${base}/${sold.id}`)
      .set(staffUser.auth)
      .send({ validUntil: later })
      .expect(403);
    const extended = await ctx
      .http()
      .patch(`${base}/${sold.id}`)
      .set(owner.auth)
      .send({ validUntil: later, recipient: 'Jan Kowalski' })
      .expect(200);
    expectShape('GiftVoucher', extended.body);
    expect(extended.body).toMatchObject({
      validUntil: later,
      recipient: 'Jan Kowalski',
      note: 'Na urodziny',
      status: 'active',
      amountGrosze: 10000,
      balanceGrosze: 10000,
    });
    await ctx
      .http()
      .post(`${base}/${sold.id}/redeem`)
      .set(staffUser.auth)
      .send({ amountGrosze: 2500 })
      .expect(200);

    // null clears: no last day, no note.
    const cleared = await ctx
      .http()
      .patch(`${base}/${sold.id}`)
      .set(owner.auth)
      .send({ validUntil: null, note: null })
      .expect(200);
    expect(cleared.body).toMatchObject({
      validUntil: null,
      note: null,
      recipient: 'Jan Kowalski',
      balanceGrosze: 7500,
    });

    await ctx
      .http()
      .patch(`${base}/${sold.id}`)
      .set(owner.auth)
      .send({ validUntil: addDays(today, -1) })
      .expect(400)
      .then((r) => expectError(r.body, 'VOUCHER_DATE_PAST'));
    await ctx.http().patch(`${base}/${sold.id}`).set(owner.auth).send({}).expect(400);
    // Task 550: how it was paid, fixed and cleared; other fields stay.
    const paid = await ctx
      .http()
      .patch(`${base}/${sold.id}`)
      .set(owner.auth)
      .send({ paymentMethod: 'blik' })
      .expect(200);
    expect(paid.body).toMatchObject({ paymentMethod: 'blik', recipient: 'Jan Kowalski' });
    await ctx
      .http()
      .patch(`${base}/${sold.id}`)
      .set(owner.auth)
      .send({ paymentMethod: 'cheque' })
      .expect(400);
    const unpaid = await ctx
      .http()
      .patch(`${base}/${sold.id}`)
      .set(owner.auth)
      .send({ paymentMethod: null })
      .expect(200);
    expect(unpaid.body.paymentMethod).toBeNull();
    // The amount is not changed here.
    const ignored = await ctx
      .http()
      .patch(`${base}/${sold.id}`)
      .set(owner.auth)
      .send({ recipient: 'Ola', amountGrosze: 99999 })
      .expect(200);
    expect(ignored.body).toMatchObject({ recipient: 'Ola', amountGrosze: 10000 });

    await ctx.http().post(`${base}/${sold.id}/cancel`).set(owner.auth).expect(200);
    await ctx
      .http()
      .patch(`${base}/${sold.id}`)
      .set(owner.auth)
      .send({ validUntil: later })
      .expect(409)
      .then((r) => expectError(r.body, 'VOUCHER_CANCELLED'));
  });

  it('"Wygasają w ciągu 30 dni": the valid vouchers that end within 30 days (task 501)', async () => {
    const today = localToday(Date.now(), 'Europe/Warsaw');
    const sell = async (amountGrosze: number, validUntil: string | null) =>
      (await ctx.http().post(base).set(owner.auth).send({ amountGrosze, validUntil }).expect(201))
        .body as Voucher;
    const empty = await ctx.http().get(base).set(owner.auth).expect(200);
    expect(empty.body.expiringSoon).toEqual({
      until: addDays(today, 30),
      count: 0,
      balanceGrosze: 0,
    });
    await sell(5000, today); // its last day is today
    const part = await sell(8000, addDays(today, 30)); // the 30th day still counts
    await sell(9000, addDays(today, 31)); // not yet
    await sell(4000, null); // no end
    const cancelled = await sell(3000, addDays(today, 10));
    await ctx.http().post(`${base}/${cancelled.id}/cancel`).set(owner.auth).expect(200);
    const used = await sell(2000, addDays(today, 10));
    await ctx
      .http()
      .post(`${base}/${used.id}/redeem`)
      .set(owner.auth)
      .send({ amountGrosze: 2000 })
      .expect(200);
    const expired = await sell(6000, today);
    await ctx.prisma.giftVoucher.update({
      where: { id: expired.id },
      data: { validUntil: new Date(`${addDays(today, -1)}T00:00:00.000Z`) },
    });
    await ctx
      .http()
      .post(`${base}/${part.id}/redeem`)
      .set(owner.auth)
      .send({ amountGrosze: 1500 })
      .expect(200);

    const list = await ctx.http().get(base).set(owner.auth).expect(200);
    expectShape('GiftVoucherList', list.body);
    expect(list.body.expiringSoon).toEqual({
      until: addDays(today, 30),
      count: 2,
      balanceGrosze: 5000 + 6500,
    });
  });

  it('"Cofnij płatność": owners and managers undo a payment noted by mistake (task 530)', async () => {
    const sold = (
      await ctx.http().post(base).set(owner.auth).send({ amountGrosze: 10000 }).expect(201)
    ).body as Voucher;
    const paid = await ctx
      .http()
      .post(`${base}/${sold.id}/redeem`)
      .set(staffUser.auth)
      .send({ amountGrosze: 10000, note: 'Pomyłka' })
      .expect(200);
    expect(paid.body.voucher).toMatchObject({ balanceGrosze: 0, status: 'used' });
    const use = paid.body.uses[0] as { id: string };
    expect(paid.body.uses[0]).toMatchObject({ undoneDate: null, undoneByName: null });
    const undo = (auth = owner.auth, id = sold.id, useId = use.id) =>
      ctx.http().post(`${base}/${id}/uses/${useId}/undo`).set(auth);

    // The specialist cannot undo a payment.
    await undo(staffUser.auth).expect(403);
    const undone = await undo().expect(200);
    expectShape('GiftVoucherDetails', undone.body);
    expect(undone.body.voucher).toMatchObject({ balanceGrosze: 10000, status: 'active' });
    expect(undone.body.uses).toMatchObject([
      {
        id: use.id,
        amountGrosze: 10000,
        note: 'Pomyłka',
        byName: 'Kasia',
        undoneDate: localToday(Date.now(), 'Europe/Warsaw'),
        undoneByName: 'Anna Owner',
      },
    ]);
    // Again — or two at the same moment — the amount goes back only once.
    await Promise.all([undo().expect(200), undo().expect(200)]);
    const after = await ctx.http().get(`${base}/${sold.id}`).set(owner.auth).expect(200);
    expect(after.body.voucher.balanceGrosze).toBe(10000);

    // The right payment, then the report counts only it.
    await ctx
      .http()
      .post(`${base}/${sold.id}/redeem`)
      .set(staffUser.auth)
      .send({ amountGrosze: 4000 })
      .expect(200);
    const today = localToday(Date.now(), 'Europe/Warsaw');
    const report = await ctx
      .http()
      .get(base.replace('/gift-vouchers', '/reports'))
      .query({ from: today, to: today })
      .set(owner.auth)
      .expect(200);
    expect(report.body.giftVouchers).toMatchObject({ payments: 1, paidGrosze: 4000 });

    // Unknown payment, or a payment of another voucher → 404.
    const other = (
      await ctx.http().post(base).set(owner.auth).send({ amountGrosze: 5000 }).expect(201)
    ).body as Voucher;
    await undo(owner.auth, other.id).expect(404);
    await undo(owner.auth, sold.id, '0190a000-0000-7000-8000-000000000000').expect(404);
    await undo(owner.auth, sold.id, 'nope').expect(404);

    // A cancelled voucher stays as it is.
    await ctx.http().post(`${base}/${sold.id}/cancel`).set(owner.auth).expect(200);
    const last = (await ctx.http().get(`${base}/${sold.id}`).set(owner.auth).expect(200)).body
      .uses[0] as { id: string };
    expectError((await undo(owner.auth, sold.id, last.id).expect(409)).body, 'VOUCHER_CANCELLED');
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
    const paid = await ctx
      .http()
      .post(`${base}/${voucher.id}/redeem`)
      .set(owner.auth)
      .send({ amountGrosze: 1000 })
      .expect(200);
    const useId = (paid.body.uses[0] as { id: string }).id;
    await ctx
      .http()
      .post(`${theirBase}/${voucher.id}/uses/${useId}/undo`)
      .set(other.auth)
      .expect(404);
    await ctx
      .http()
      .patch(`${theirBase}/${voucher.id}`)
      .set(other.auth)
      .send({ recipient: 'X' })
      .expect(404);
    const mine = await ctx.http().get(`${base}/${voucher.id}`).set(owner.auth).expect(200);
    expect(mine.body.voucher.balanceGrosze).toBe(8000);
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

describe('"CSV bonów" (task 494)', () => {
  const csv = (auth: Record<string, string>, locale?: string) =>
    ctx
      .http()
      .get(`${base}/export.csv`)
      .query(locale ? { locale } : {})
      .set(auth)
      .buffer(true)
      .parse((res, done) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (text += chunk));
        res.on('end', () => done(null, text));
      });

  const rows = (text: string): string[][] =>
    text
      .replace(/^\uFEFF/, '')
      .trimEnd()
      .split('\r\n')
      .map((line) => line.split(';').map((c) => c.replace(/^"|"$/g, '')));

  it('lists every voucher, oldest first, with what was used and what is left', async () => {
    const first = (
      await ctx
        .http()
        .post(base)
        .set(owner.auth)
        .send({
          amountGrosze: 20000,
          recipient: 'Jan Kowalski',
          note: 'Na urodziny',
          paymentMethod: 'cash',
        })
        .expect(201)
    ).body as Voucher;
    await ctx
      .http()
      .post(`${base}/${first.id}/redeem`)
      .set(staffUser.auth)
      .send({ amountGrosze: 5050 })
      .expect(200);
    const lastDay = addDays(localToday(Date.now(), 'Europe/Warsaw'), 30);
    const second = (
      await ctx
        .http()
        .post(base)
        .set(owner.auth)
        .send({ amountGrosze: 10000, validUntil: lastDay })
        .expect(201)
    ).body as Voucher;
    await ctx.http().post(`${base}/${second.id}/cancel`).set(owner.auth).expect(200);

    const res = await csv(owner.auth).expect(200);
    expect(res.headers['content-type']).toMatch(/^text\/csv/);
    expect(res.headers['content-disposition']).toMatch(/attachment; filename="vouchers-.+\.csv"/);
    const text = res.body as string;
    expect(text.startsWith('\uFEFF')).toBe(true);
    const today = localToday(Date.now(), 'Europe/Warsaw');
    expect(rows(text)).toEqual([
      [
        'Kod',
        'Data sprzedaży',
        'Sprzedał(a)',
        'Dla kogo',
        'Kwota',
        'Wykorzystano',
        'Pozostało',
        'Ważny do',
        'Status',
        'Notatka',
        'Sposób płatności',
      ],
      [
        first.code,
        today,
        'Anna Owner',
        'Jan Kowalski',
        '200,00',
        '50,50',
        '149,50',
        '',
        'Aktywny',
        'Na urodziny',
        'Gotówka',
      ],
      [
        second.code,
        today,
        'Anna Owner',
        '',
        '100,00',
        '0,00',
        '100,00',
        lastDay,
        'Anulowany',
        '',
        '',
      ],
    ]);

    const en = rows((await csv(owner.auth, 'en').expect(200)).body as string);
    expect(en[0]![0]).toBe('Code');
    expect(en[1]!.slice(4, 7)).toEqual(['200.00', '50.50', '149.50']);
    expect(en[2]![8]).toBe('Cancelled');
    expect(en[1]![10]).toBe('Cash');
    expect(en[0]![10]).toBe('Payment');
  });

  it('is for owners and managers only', async () => {
    await csv(staffUser.auth).expect(403);
    const empty = rows((await csv(owner.auth).expect(200)).body as string);
    expect(empty).toHaveLength(1);
  });
});

describe('"CSV płatności bonami" (task 533)', () => {
  const csv = (auth: Record<string, string>, locale?: string, at = base) =>
    ctx
      .http()
      .get(`${at}/uses.csv`)
      .query(locale ? { locale } : {})
      .set(auth)
      .buffer(true)
      .parse((res, done) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (text += chunk));
        res.on('end', () => done(null, text));
      });

  const rows = (text: string): string[][] =>
    text
      .replace(/^\uFEFF/, '')
      .trimEnd()
      .split('\r\n')
      .map((line) => line.split(';').map((c) => c.replace(/^"|"$/g, '')));

  it('lists every payment, oldest first, with the undone ones marked', async () => {
    const voucher = (
      await ctx
        .http()
        .post(base)
        .set(owner.auth)
        .send({ amountGrosze: 20000, recipient: 'Jan Kowalski' })
        .expect(201)
    ).body as Voucher;
    const pay = (amountGrosze: number, auth: Record<string, string>, note?: string) =>
      ctx
        .http()
        .post(`${base}/${voucher.id}/redeem`)
        .set(auth)
        .send({ amountGrosze, ...(note ? { note } : {}) })
        .expect(200);
    const first = await pay(5050, staffUser.auth, 'Strzyżenie');
    const firstUse = (first.body.uses as { id: string }[])[0]!;
    await ctx.prisma.giftVoucherUse.update({
      where: { id: firstUse.id },
      data: { createdAt: new Date('2026-03-02T09:15:00Z') },
    });
    const second = await pay(3000, owner.auth);
    const secondUse = (second.body.uses as { id: string; amountGrosze: number }[]).find(
      (u) => u.amountGrosze === 3000,
    )!;
    await ctx
      .http()
      .post(`${base}/${voucher.id}/uses/${secondUse.id}/undo`)
      .set(owner.auth)
      .expect(200);

    const res = await csv(owner.auth).expect(200);
    expect(res.headers['content-type']).toMatch(/^text\/csv/);
    expect(res.headers['content-disposition']).toMatch(
      /attachment; filename="voucher-payments-.+\.csv"/,
    );
    const today = localToday(Date.now(), 'Europe/Warsaw');
    const lines = rows(res.body as string);
    expect(lines[0]).toEqual([
      'Data',
      'Godzina',
      'Kod bonu',
      'Dla kogo',
      'Kwota',
      'Za co',
      'Przyjął(a)',
      'Cofnięta',
      'Wizyta',
      'Specjalista wizyty',
    ]);
    expect(lines[1]).toEqual([
      '2026-03-02',
      '10:15',
      voucher.code,
      'Jan Kowalski',
      '50,50',
      'Strzyżenie',
      'Kasia',
      '',
      '',
      '',
    ]);
    expect(lines[2]!.slice(0, 1)).toEqual([today]);
    expect(lines[2]!.slice(2)).toEqual([
      voucher.code,
      'Jan Kowalski',
      '30,00',
      '',
      'Anna Owner',
      today,
      '',
      '',
    ]);
    expect(lines).toHaveLength(3);

    const en = rows((await csv(owner.auth, 'en').expect(200)).body as string);
    expect(en[0]![2]).toBe('Voucher code');
    expect(en[1]![4]).toBe('50.50');
  });

  it('is for owners and managers only, and only for the salon’s own vouchers', async () => {
    await csv(staffUser.auth).expect(403);
    const voucher = (
      await ctx.http().post(base).set(owner.auth).send({ amountGrosze: 9000 }).expect(201)
    ).body as Voucher;
    await ctx
      .http()
      .post(`${base}/${voucher.id}/redeem`)
      .set(owner.auth)
      .send({ amountGrosze: 1000 })
      .expect(200);
    const other = await signUp(ctx, 'other@example.com');
    const theirs = await createOrgWithLocation(ctx, other, 'Other');
    const theirBase = `/v1/organizations/${theirs.orgId}/locations/${theirs.locationId}/gift-vouchers`;
    expect(
      rows((await csv(other.auth, undefined, theirBase).expect(200)).body as string),
    ).toHaveLength(1);
    await csv(other.auth, undefined, base).expect(404);
  });
});

describe('"Sprawdź bon" for the client (task 536)', () => {
  const sell = async (body: Record<string, unknown>) =>
    (await ctx.http().post(base).set(owner.auth).send(body).expect(201)).body as Voucher;
  const check = (code: string, onSlug = slug) =>
    ctx.http().get(`/v1/public/locations/${onSlug}/gift-vouchers/${encodeURIComponent(code)}`);

  it('shows what the voucher is worth and what is left — nothing about who it is for', async () => {
    const voucher = await sell({
      amountGrosze: 20000,
      recipient: 'Jan Kowalski',
      note: 'Na urodziny',
      validUntil: addDays(localToday(Date.now(), 'Europe/Warsaw'), 60),
    });
    // The salon page is not public yet: the code tells nothing.
    await check(voucher.code).expect(404);
    await ctx.prisma.location.update({
      where: { id: locationId },
      data: { onlineBookingEnabled: true },
    });

    await ctx
      .http()
      .post(`${base}/${voucher.id}/redeem`)
      .set(owner.auth)
      .send({ amountGrosze: 5000 })
      .expect(200);
    const typed = `${voucher.code.slice(0, 4).toLowerCase()}-${voucher.code.slice(4)}`;
    const res = await check(typed).expect(200);
    expectShape('PublicGiftVoucher', res.body);
    expect(res.body).toEqual({
      code: voucher.code,
      amountGrosze: 20000,
      balanceGrosze: 15000,
      currency: 'PLN',
      validUntil: voucher.validUntil,
      status: 'active',
    });
    expect(JSON.stringify(res.body)).not.toContain('Kowalski');
    expect(JSON.stringify(res.body)).not.toContain('urodziny');

    // Unknown code, unknown salon, a too-short code.
    await check('ZZZZZZZZ').expect(404);
    await check(voucher.code, 'no-such-salon').expect(404);
    await check('AB').expect(400);

    // Cancelled by the salon.
    await ctx.http().post(`${base}/${voucher.id}/cancel`).set(owner.auth).expect(200);
    expect((await check(voucher.code).expect(200)).body.status).toBe('cancelled');
  });

  it('a voucher of another salon is not found on this salon page', async () => {
    await ctx.prisma.location.update({
      where: { id: locationId },
      data: { onlineBookingEnabled: true },
    });
    const other = await createOrgWithLocation(ctx, staffUser, 'Other');
    const foreign = (
      await ctx
        .http()
        .post(`/v1/organizations/${other.orgId}/locations/${other.locationId}/gift-vouchers`)
        .set(staffUser.auth)
        .send({ amountGrosze: 10000 })
        .expect(201)
    ).body as Voucher;
    await check(foreign.code).expect(404);
  });

  it('at most 20 checks an hour from one address, so codes cannot be guessed', async () => {
    await ctx.prisma.location.update({
      where: { id: locationId },
      data: { onlineBookingEnabled: true },
    });
    for (let i = 0; i < 20; i += 1) await check('ZZZZZZZZ').expect(404);
    const res = await check('ZZZZZZZZ').expect(429);
    expectError(res.body, 'RATE_LIMITED');
  });
});

describe('"Zapłać bonem" in the visit card (task 540)', () => {
  let locBase: string;
  let kasiaVisit: string;
  let olaVisit: string;

  beforeEach(async () => {
    locBase = base.replace(/\/gift-vouchers$/, '');
    const serviceId = (
      await ctx
        .http()
        .post(`${locBase}/services`)
        .set(owner.auth)
        .send({ name: 'Strzyżenie', durationMinutes: 30, priceGrosze: 8000 })
        .expect(201)
    ).body.id as string;
    const staff = async (displayName: string) =>
      (
        await ctx
          .http()
          .post(`${locBase}/staff`)
          .set(owner.auth)
          .send({ displayName, serviceIds: [serviceId] })
          .expect(201)
      ).body.id as string;
    const kasiaId = await staff('Kasia');
    const olaId = await staff('Ola');
    await ctx.prisma.staffMember.update({
      where: { id: kasiaId },
      data: { userId: staffUser.userId },
    });
    const day = addDays(localToday(Date.now(), 'Europe/Warsaw'), 2);
    const book = async (staffId: string, hour: number) =>
      (
        await ctx
          .http()
          .post(`${locBase}/appointments`)
          .set(owner.auth)
          .send({
            serviceId,
            staffId,
            start: new Date(zonedToInstant(day, hour * 60, 'Europe/Warsaw')).toISOString(),
            allowOutsideHours: true,
            customer: { name: 'Jan Nowak', phone: '+48600000002' },
          })
          .expect(201)
      ).body.id as string;
    kasiaVisit = await book(kasiaId, 10);
    olaVisit = await book(olaId, 12);
  });

  it('remembers the visit a payment was for and lists the payments in its card', async () => {
    const voucher = (
      await ctx.http().post(base).set(owner.auth).send({ amountGrosze: 20000 }).expect(201)
    ).body as Voucher;
    const payments = (visitId: string, auth = staffUser.auth) =>
      ctx.http().get(`${locBase}/appointments/${visitId}/gift-voucher-payments`).set(auth);

    const empty = await payments(kasiaVisit).expect(200);
    expectShape('VisitVoucherPayments', empty.body);
    expect(empty.body).toEqual({ payments: [], totalGrosze: 0 });

    // The specialist pays for her own visit with the voucher.
    const paid = await ctx
      .http()
      .post(`${base}/${voucher.id}/redeem`)
      .set(staffUser.auth)
      .send({ amountGrosze: 8000, appointmentId: kasiaVisit })
      .expect(200);
    expect(paid.body.voucher.balanceGrosze).toBe(12000);
    expect(paid.body.uses).toMatchObject([{ amountGrosze: 8000, appointmentId: kasiaVisit }]);
    // A payment at the till belongs to no visit.
    const till = await ctx
      .http()
      .post(`${base}/${voucher.id}/redeem`)
      .set(owner.auth)
      .send({ amountGrosze: 1000 })
      .expect(200);
    expect(till.body.uses[0]).toMatchObject({ amountGrosze: 1000, appointmentId: null });
    await ctx
      .http()
      .post(`${base}/${voucher.id}/redeem`)
      .set(owner.auth)
      .send({ amountGrosze: 2000, appointmentId: kasiaVisit })
      .expect(200);

    const listed = await payments(kasiaVisit).expect(200);
    expectShape('VisitVoucherPayments', listed.body);
    expect(listed.body).toMatchObject({
      payments: [
        { voucherId: voucher.id, code: voucher.code, amountGrosze: 8000, byName: 'Kasia' },
        { amountGrosze: 2000, byName: 'Anna Owner', undoneDate: null },
      ],
      totalGrosze: 10000,
    });

    // An undone payment stays in the list, marked, and leaves the total.
    const undoId = (listed.body.payments as { id: string }[])[1]!.id;
    await ctx.http().post(`${base}/${voucher.id}/uses/${undoId}/undo`).set(owner.auth).expect(200);
    const after = await payments(kasiaVisit, owner.auth).expect(200);
    expect(after.body.totalGrosze).toBe(8000);
    expect(after.body.payments[1].undoneDate).toBe(localToday(Date.now(), 'Europe/Warsaw'));
    expect((await payments(olaVisit, owner.auth).expect(200)).body.payments).toEqual([]);

    // Task 543: "CSV płatności bonami" names the visit and its specialist; at the till — empty.
    const file = await ctx
      .http()
      .get(`${base}/uses.csv`)
      .set(owner.auth)
      .buffer(true)
      .parse((res, done) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (text += chunk));
        res.on('end', () => done(null, text));
      })
      .expect(200);
    const csvLines = (file.body as string)
      .replace(/^\uFEFF/, '')
      .trimEnd()
      .split('\r\n')
      .map((line) => line.split(';').map((c) => c.replace(/^"|"$/g, '')));
    const visitAt = `${addDays(localToday(Date.now(), 'Europe/Warsaw'), 2)} 10:00`;
    expect(csvLines.map((l) => [l[4], l[8], l[9]])).toEqual([
      ['Kwota', 'Wizyta', 'Specjalista wizyty'],
      ['80,00', visitAt, 'Kasia'],
      ['10,00', '', ''],
      ['20,00', visitAt, 'Kasia'],
    ]);
  });

  it('only for a visit the member may see, and nothing is taken otherwise', async () => {
    const voucher = (
      await ctx.http().post(base).set(owner.auth).send({ amountGrosze: 5000 }).expect(201)
    ).body as Voucher;
    // Kasia does not see Ola's visits: neither paying for one nor its payments.
    await ctx
      .http()
      .post(`${base}/${voucher.id}/redeem`)
      .set(staffUser.auth)
      .send({ amountGrosze: 1000, appointmentId: olaVisit })
      .expect(404);
    await ctx
      .http()
      .get(`${locBase}/appointments/${olaVisit}/gift-voucher-payments`)
      .set(staffUser.auth)
      .expect(404);
    await ctx
      .http()
      .post(`${base}/${voucher.id}/redeem`)
      .set(owner.auth)
      .send({ amountGrosze: 1000, appointmentId: 'not-a-uuid' })
      .expect(400);

    // A visit of another salon is not found, and the voucher keeps its balance.
    const other = await signUp(ctx, 'other@example.com', 'Other Owner');
    const otherSalon = await createOrgWithLocation(ctx, other, 'Other');
    const otherBase = `/v1/organizations/${otherSalon.orgId}/locations/${otherSalon.locationId}`;
    const otherService = (
      await ctx
        .http()
        .post(`${otherBase}/services`)
        .set(other.auth)
        .send({ name: 'Broda', durationMinutes: 30, priceGrosze: 5000 })
        .expect(201)
    ).body.id as string;
    const otherStaff = (
      await ctx
        .http()
        .post(`${otherBase}/staff`)
        .set(other.auth)
        .send({ displayName: 'Piotr', serviceIds: [otherService] })
        .expect(201)
    ).body.id as string;
    const otherVisit = (
      await ctx
        .http()
        .post(`${otherBase}/appointments`)
        .set(other.auth)
        .send({
          serviceId: otherService,
          staffId: otherStaff,
          start: new Date(
            zonedToInstant(
              addDays(localToday(Date.now(), 'Europe/Warsaw'), 2),
              600,
              'Europe/Warsaw',
            ),
          ).toISOString(),
          allowOutsideHours: true,
          customer: { name: 'Adam', phone: '+48600000003' },
        })
        .expect(201)
    ).body.id as string;
    await ctx
      .http()
      .post(`${base}/${voucher.id}/redeem`)
      .set(owner.auth)
      .send({ amountGrosze: 1000, appointmentId: otherVisit })
      .expect(404);
    await ctx
      .http()
      .get(`${locBase}/appointments/${otherVisit}/gift-voucher-payments`)
      .set(owner.auth)
      .expect(404);
    const check = await ctx.http().get(`${base}/${voucher.id}`).set(owner.auth).expect(200);
    expect(check.body).toMatchObject({ voucher: { balanceGrosze: 5000 }, uses: [] });
  });
});
