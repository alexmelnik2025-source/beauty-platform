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

/**
 * Task 232: "Zamknij kasę" — the cash counted in the till at the end of a day, beside what the
 * visits of that day paid in cash brought. Owners and managers only; only a note.
 */

let ctx: TestContext;
let owner: SignedInUser;
let kasia: SignedInUser;
let orgId: string;
let locationId: string;
let base: string;
let haircutId: string;
let kasiaStaffId: string;

const TZ = 'Europe/Warsaw';
/** Yesterday in the salon (a past visit can be entered for today or yesterday only). */
const DAY = addDays(localToday(Date.now(), TZ), -1);
/** That day at `hour`:00 salon time. */
const at = (hour: number) => new Date(zonedToInstant(DAY, hour * 60, TZ)).toISOString();

function walkIn(start: string, extra: Record<string, unknown> = {}) {
  return ctx
    .http()
    .post(`${base}/appointments`)
    .set(owner.auth)
    .send({
      serviceId: haircutId,
      staffId: kasiaStaffId,
      start,
      customer: { name: 'Jan Nowak', phone: '+48600000002', email: 'jan@example.com' },
      alreadyHappened: true,
      allowOutsideHours: true,
      ...extra,
    });
}

const till = (date = DAY, auth = owner.auth) =>
  ctx.http().get(`${base}/reports/till-close`).query({ date }).set(auth);

const close = (body: Record<string, unknown>, auth = owner.auth) =>
  ctx.http().put(`${base}/reports/till-close`).set(auth).send(body);

beforeAll(async () => {
  ctx = await createTestApp();
});

afterAll(async () => {
  await ctx.app.close();
});

beforeEach(async () => {
  await resetState(ctx);
  owner = await signUp(ctx, 'owner@example.com', 'Anna Właścicielka');
  ({ orgId, locationId } = await createOrgWithLocation(ctx, owner, 'Barber'));
  base = `/v1/organizations/${orgId}/locations/${locationId}`;
  haircutId = (
    await ctx
      .http()
      .post(`${base}/services`)
      .set(owner.auth)
      .send({ name: 'Strzyżenie', durationMinutes: 30, priceGrosze: 8000 })
      .expect(201)
  ).body.id;
  kasiaStaffId = (
    await ctx
      .http()
      .post(`${base}/staff`)
      .set(owner.auth)
      .send({ displayName: 'Kasia', serviceIds: [haircutId] })
      .expect(201)
  ).body.id;
  kasia = await signUp(ctx, 'kasia@example.com');
  await ctx.prisma.membership.create({
    data: {
      userId: kasia.userId,
      organizationId: orgId,
      role: 'staff',
      permissionOverrides: { viewOwnEarnings: true },
      locations: { create: [{ locationId }] },
    },
  });
  await ctx.prisma.staffMember.update({
    where: { id: kasiaStaffId },
    data: { userId: kasia.userId },
  });
});

describe('till close (task 232)', () => {
  it('puts the counted cash beside what the cash visits of the day brought', async () => {
    await walkIn(at(10), { paid: true, paymentMethod: 'cash' }).expect(201);
    await walkIn(at(11), { paid: true, paymentMethod: 'cash' }).expect(201);
    await walkIn(at(12), { paid: true, paymentMethod: 'card' }).expect(201);
    await walkIn(at(13)).expect(201); // came, not paid yet

    const before = await till().expect(200);
    const parsed = registeredResponseSchema('TillClose').safeParse(before.body);
    expect(parsed.error?.issues ?? []).toEqual([]);
    expect(before.body).toMatchObject({ date: DAY, expectedCashGrosze: 16_000, close: null });

    const closed = await close({
      date: DAY,
      countedCashGrosze: 15_000,
      note: ' Wydano resztę ',
    }).expect(200);
    expect(closed.body.close).toMatchObject({
      countedCashGrosze: 15_000,
      expectedCashGrosze: 16_000,
      differenceGrosze: -1000,
      note: 'Wydano resztę',
      closedByName: 'Anna Właścicielka',
    });
    expect((await till().expect(200)).body.close.differenceGrosze).toBe(-1000);

    // Counting again replaces the note; one row per day.
    const again = await close({ date: DAY, countedCashGrosze: 16_500 }).expect(200);
    expect(again.body.close).toMatchObject({ differenceGrosze: 500, note: null });
    expect(await ctx.prisma.tillClose.count({ where: { locationId } })).toBe(1);

    // Another day has nothing yet.
    const otherDay = addDays(DAY, -4);
    expect((await till(otherDay).expect(200)).body).toMatchObject({
      expectedCashGrosze: 0,
      close: null,
    });
  });

  it('refuses a day that has not started and wrong amounts', async () => {
    const tomorrow = addDays(DAY, 3);
    expectError(
      (await close({ date: tomorrow, countedCashGrosze: 100 }).expect(409)).body,
      'DAY_NOT_STARTED',
    );
    for (const countedCashGrosze of [-1, 10.5, '100', 100_000_001]) {
      expectError(
        (await close({ date: DAY, countedCashGrosze }).expect(400)).body,
        'VALIDATION_ERROR',
      );
    }
    expectError(
      (await close({ date: '2026-02-30', countedCashGrosze: 100 }).expect(400)).body,
      'VALIDATION_ERROR',
    );
    expect(await ctx.prisma.tillClose.count()).toBe(0);
  });

  it('only owners and managers; other salons do not exist', async () => {
    expectError((await till(DAY, kasia.auth).expect(403)).body, 'FORBIDDEN');
    expectError(
      (await close({ date: DAY, countedCashGrosze: 100 }, kasia.auth).expect(403)).body,
      'FORBIDDEN',
    );

    const manager = await signUp(ctx, 'manager@example.com', 'Marek');
    await ctx.prisma.membership.create({
      data: {
        userId: manager.userId,
        organizationId: orgId,
        role: 'manager',
        locations: { create: [{ locationId }] },
      },
    });
    const res = await close({ date: DAY, countedCashGrosze: 100 }, manager.auth).expect(200);
    expect(res.body.close).toMatchObject({ closedByName: 'Marek', differenceGrosze: 100 });

    const stranger = await signUp(ctx, 'stranger@example.com');
    const other = await createOrgWithLocation(ctx, stranger, 'Other');
    await ctx
      .http()
      .put(`/v1/organizations/${other.orgId}/locations/${locationId}/reports/till-close`)
      .set(stranger.auth)
      .send({ date: DAY, countedCashGrosze: 1 })
      .expect(404);
    await ctx
      .http()
      .get(`/v1/organizations/${orgId}/locations/${locationId}/reports/till-close`)
      .query({ date: DAY })
      .set(stranger.auth)
      .expect((r) => expect([403, 404]).toContain(r.status));
    expect((await till().expect(200)).body.close.countedCashGrosze).toBe(100);
  });

  it("the report lists the counted days of the period; not in a specialist's own report (tasks 233, 237, 553)", async () => {
    await walkIn(at(10), { paid: true, paymentMethod: 'cash' }).expect(201);
    // Task 553: a BLIK visit that day — "Bez gotówki", not in the till.
    await walkIn(at(12), { paid: true, paymentMethod: 'blik' }).expect(201);
    // Task 237: cash put in and taken out that day is shown beside the close.
    for (const [kind, amountGrosze] of [
      ['in', 5000],
      ['out', 1500],
      ['out', 3500],
    ] as const) {
      await ctx
        .http()
        .post(`${base}/reports/till-movements`)
        .set(owner.auth)
        .send({ date: DAY, kind, amountGrosze, note: 'Ruch' })
        .expect(201);
    }
    await close({ date: DAY, countedCashGrosze: 7000 }).expect(200);
    const earlier = addDays(DAY, -2);
    await close({ date: earlier, countedCashGrosze: 500 }).expect(200);

    const report = (
      await ctx
        .http()
        .get(`${base}/reports`)
        .query({ from: addDays(DAY, -6), to: DAY })
        .set(owner.auth)
        .expect(200)
    ).body;
    const parsed = registeredResponseSchema('SalonReport').safeParse(report);
    expect(parsed.error?.issues ?? []).toEqual([]);
    expect(report.tillCloses).toEqual({
      days: [
        {
          date: earlier,
          expectedCashGrosze: 0,
          countedCashGrosze: 500,
          differenceGrosze: 500,
          cashInGrosze: 0,
          cashOutGrosze: 0,
          nonCashGrosze: 0,
        },
        {
          date: DAY,
          expectedCashGrosze: 8000,
          countedCashGrosze: 7000,
          differenceGrosze: -1000,
          cashInGrosze: 5000,
          cashOutGrosze: 5000,
          nonCashGrosze: 8000,
        },
      ],
      differenceGrosze: -500,
    });
    // Outside the period — not listed.
    const before = (
      await ctx
        .http()
        .get(`${base}/reports`)
        .query({ from: addDays(DAY, -30), to: addDays(DAY, -3) })
        .set(owner.auth)
        .expect(200)
    ).body;
    expect(before.tillCloses).toEqual({ days: [], differenceGrosze: 0 });

    const own = (
      await ctx
        .http()
        .get(`${base}/reports`)
        .query({ from: addDays(DAY, -6), to: DAY })
        .set(kasia.auth)
        .expect(200)
    ).body;
    expect(own.scope).toBe('own');
    expect(own.tillCloses).toEqual({ days: [], differenceGrosze: 0 });
  });
});

describe('cash put into or taken out of the till (task 236)', () => {
  const move = (body: Record<string, unknown>, auth = owner.auth) =>
    ctx.http().post(`${base}/reports/till-movements`).set(auth).send(body);

  it('the till should hold the cash visits plus what was put in minus what was taken out', async () => {
    await walkIn(at(10), { paid: true, paymentMethod: 'cash' }).expect(201); // 80,00

    const putIn = await move({
      date: DAY,
      kind: 'in',
      amountGrosze: 10_000,
      note: ' Reszta ',
    }).expect(201);
    const parsed = registeredResponseSchema('TillClose').safeParse(putIn.body);
    expect(parsed.error?.issues ?? []).toEqual([]);
    expect(putIn.body).toMatchObject({
      date: DAY,
      visitsCashGrosze: 8000,
      cashInGrosze: 10_000,
      cashOutGrosze: 0,
      expectedCashGrosze: 18_000,
      movements: [
        { kind: 'in', amountGrosze: 10_000, note: 'Reszta', createdByName: 'Anna Właścicielka' },
      ],
    });

    const takenOut = await move({
      date: DAY,
      kind: 'out',
      amountGrosze: 4000,
      note: 'Ręczniki',
    }).expect(201);
    expect(takenOut.body).toMatchObject({ cashOutGrosze: 4000, expectedCashGrosze: 14_000 });
    expect(takenOut.body.movements.map((m: { note: string }) => m.note)).toEqual([
      'Reszta',
      'Ręczniki',
    ]);

    // Closing the till compares with the visits plus "in" minus "out".
    const closed = await close({ date: DAY, countedCashGrosze: 14_000 }).expect(200);
    expect(closed.body.close).toMatchObject({ expectedCashGrosze: 14_000, differenceGrosze: 0 });

    // Removing a movement noted by mistake; the close keeps what was expected when counted.
    const towels = takenOut.body.movements[1].id;
    const removed = await ctx
      .http()
      .delete(`${base}/reports/till-movements/${towels}`)
      .set(owner.auth)
      .expect(200);
    expect(removed.body).toMatchObject({ date: DAY, cashOutGrosze: 0, expectedCashGrosze: 18_000 });
    expect(removed.body.close.expectedCashGrosze).toBe(14_000);
    await ctx.http().delete(`${base}/reports/till-movements/${towels}`).set(owner.auth).expect(404);

    // Another day has its own movements.
    expect((await till(addDays(DAY, -1)).expect(200)).body).toMatchObject({
      movements: [],
      cashInGrosze: 0,
    });
  });

  it('refuses a day that has not started, wrong amounts and an empty reason', async () => {
    expectError(
      (await move({ date: addDays(DAY, 3), kind: 'in', amountGrosze: 100, note: 'x' }).expect(409))
        .body,
      'DAY_NOT_STARTED',
    );
    for (const body of [
      { amountGrosze: 0 },
      { amountGrosze: -100 },
      { amountGrosze: 10.5 },
      { amountGrosze: 100_000_001 },
      { kind: 'other' },
      { note: '   ' },
      { note: 'x'.repeat(201) },
    ]) {
      expectError(
        (
          await move({ date: DAY, kind: 'out', amountGrosze: 100, note: 'Kawa', ...body }).expect(
            400,
          )
        ).body,
        'VALIDATION_ERROR',
      );
    }
    expect(await ctx.prisma.tillMovement.count()).toBe(0);
  });

  it('only owners and managers; another salon cannot remove a movement', async () => {
    const body = { date: DAY, kind: 'out', amountGrosze: 100, note: 'Kawa' };
    expectError((await move(body, kasia.auth).expect(403)).body, 'FORBIDDEN');
    const id = (await move(body).expect(201)).body.movements[0].id;
    expectError(
      (await ctx.http().delete(`${base}/reports/till-movements/${id}`).set(kasia.auth).expect(403))
        .body,
      'FORBIDDEN',
    );

    const stranger = await signUp(ctx, 'stranger@example.com');
    const other = await createOrgWithLocation(ctx, stranger, 'Other');
    await ctx
      .http()
      .delete(
        `/v1/organizations/${other.orgId}/locations/${other.locationId}/reports/till-movements/${id}`,
      )
      .set(stranger.auth)
      .expect(404);
    await ctx
      .http()
      .delete(`${base}/reports/till-movements/not-a-uuid`)
      .set(owner.auth)
      .expect(404);
    expect(await ctx.prisma.tillMovement.count()).toBe(1);
  });
});

describe('the till as a CSV cash journal (task 238)', () => {
  const csv = (q: Record<string, string> = {}, auth = owner.auth) =>
    ctx
      .http()
      .get(`${base}/reports/till-csv`)
      .query({ from: addDays(DAY, -3), to: DAY, ...q })
      .set(auth)
      .buffer(true)
      .parse((res, done) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (text += chunk));
        res.on('end', () => done(null, text));
      });

  it('every cash put in or taken out and every close of the period, oldest first', async () => {
    await walkIn(at(10), { paid: true, paymentMethod: 'cash' }).expect(201); // 80,00
    // Task 553: a card visit — "Bez gotówki" of the close, not in the till.
    await walkIn(at(11), { paid: true, paymentMethod: 'card' }).expect(201);
    const move = (body: Record<string, unknown>) =>
      ctx
        .http()
        .post(`${base}/reports/till-movements`)
        .set(owner.auth)
        .send({ date: DAY, ...body })
        .expect(201);
    await move({ kind: 'in', amountGrosze: 10_000, note: 'Reszta na początek' });
    await move({ kind: 'out', amountGrosze: 1550, note: '=Ręczniki; "Biedronka"' });
    await close({ date: DAY, countedCashGrosze: 15_000, note: 'Brak' }).expect(200);
    // An earlier day of the period, and one outside it.
    const earlier = addDays(DAY, -2);
    await move({ date: earlier, kind: 'out', amountGrosze: 500, note: 'Kawa' });
    await move({ date: addDays(DAY, -10), kind: 'out', amountGrosze: 700, note: 'Stare' });

    const res = await csv().expect(200);
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(res.headers['content-disposition']).toMatch(
      new RegExp(`^attachment; filename="till-.+-${addDays(DAY, -3)}-${DAY}\\.csv"$`),
    );
    const text = res.body as string;
    expect(text.startsWith('\uFEFF')).toBe(true);
    const lines = text.slice(1).trimEnd().split('\r\n');
    expect(lines[0]).toBe(
      'Data;Godzina;Rodzaj;Kwota;Powinno być;Różnica;Powód / notatka;Kto;Bez gotówki',
    );
    const rows = lines.slice(1).map((l) => l.replace(/;\d\d:\d\d;/, ';HH:MM;'));
    expect(rows).toEqual([
      `${earlier};HH:MM;Wypłata z kasy;5,00;;;Kawa;Anna Właścicielka;`,
      `${DAY};HH:MM;Wpłata do kasy;100,00;;;Reszta na początek;Anna Właścicielka;`,
      `${DAY};HH:MM;Wypłata z kasy;15,50;;;"'=Ręczniki; ""Biedronka""";Anna Właścicielka;`,
      `${DAY};HH:MM;Zamknięcie kasy;150,00;164,50;-14,50;Brak;Anna Właścicielka;80,00`,
    ]);

    const english = (await csv({ locale: 'en' }).expect(200)).body as string;
    expect(english).toContain(
      'Date;Time;Entry;Amount;Should be;Difference;Reason / note;By;Not in cash',
    );
    expect(english).toContain(';Till closed;150.00;164.50;-14.50;Brak;Anna Właścicielka;80.00');
    for (const locale of ['uk', 'ru']) {
      expect(((await csv({ locale }).expect(200)).body as string).split('\r\n')).toHaveLength(6);
    }
  });

  it('owners and managers only; a wrong period is refused', async () => {
    expectError(JSON.parse((await csv({}, kasia.auth).expect(403)).body as string), 'FORBIDDEN');
    await csv({ from: DAY, to: addDays(DAY, -1) }).expect(400);
    await csv({ locale: 'de' }).expect(400);
    const empty = (await csv().expect(200)).body as string;
    expect(empty.slice(1).trimEnd().split('\r\n')).toHaveLength(1);

    const stranger = await signUp(ctx, 'stranger@example.com');
    const other = await createOrgWithLocation(ctx, stranger, 'Other');
    await ctx
      .http()
      .get(`/v1/organizations/${other.orgId}/locations/${locationId}/reports/till-csv`)
      .query({ from: DAY, to: DAY })
      .set(stranger.auth)
      .expect(404);
  });
});

describe('"Kasa nie została zamknięta" (task 239)', () => {
  const TODAY = addDays(DAY, 1);

  it('names the latest earlier day with cash whose till was not counted', async () => {
    // Nothing yet; a visit paid by card is not cash.
    expect((await till(TODAY).expect(200)).body.unclosedDay).toBeNull();
    await walkIn(at(9), { paid: true, paymentMethod: 'card' }).expect(201);
    expect((await till(TODAY).expect(200)).body.unclosedDay).toBeNull();

    await walkIn(at(10), { paid: true, paymentMethod: 'cash' }).expect(201);
    const today = await till(TODAY).expect(200);
    expect(registeredResponseSchema('TillClose').safeParse(today.body).error?.issues ?? []).toEqual(
      [],
    );
    expect(today.body.unclosedDay).toBe(DAY);
    // The day itself looks only at the days before it.
    expect((await till(DAY).expect(200)).body.unclosedDay).toBeNull();

    // Counted — the reminder goes away; an older day without a close is not brought back.
    await ctx
      .http()
      .post(`${base}/reports/till-movements`)
      .set(owner.auth)
      .send({ date: addDays(DAY, -3), kind: 'in', amountGrosze: 5000, note: 'Reszta' })
      .expect(201);
    await close({ date: DAY, countedCashGrosze: 8000 }).expect(200);
    expect((await till(TODAY).expect(200)).body.unclosedDay).toBeNull();
    // But the day after that older day still sees it.
    expect((await till(addDays(DAY, -2)).expect(200)).body.unclosedDay).toBe(addDays(DAY, -3));
    // Too long ago — not reminded any more.
    expect((await till(addDays(DAY, 16)).expect(200)).body.unclosedDay).toBeNull();
  });
});

describe('gift vouchers in the till (tasks 546–547)', () => {
  const vouchers = () => `${base}/gift-vouchers`;
  const sell = (body: Record<string, unknown>, auth = owner.auth) =>
    ctx.http().post(vouchers()).set(auth).send(body);

  it('a cash visit paid partly with a voucher expects only the rest in the till', async () => {
    const visit = (await walkIn(at(10), { paid: true, paymentMethod: 'cash' }).expect(201)).body;
    await walkIn(at(11), { paid: true, paymentMethod: 'cash' }).expect(201);
    const card = (await walkIn(at(12), { paid: true, paymentMethod: 'card' }).expect(201)).body;
    const voucher = (await sell({ amountGrosze: 20_000 }).expect(201)).body;
    const pay = (appointmentId: string, amountGrosze: number) =>
      ctx
        .http()
        .post(`${vouchers()}/${voucher.id}/redeem`)
        .set(owner.auth)
        .send({ amountGrosze, appointmentId })
        .expect(200);
    await pay(visit.id, 5000);
    await pay(card.id, 8000); // a card visit is not cash anyway

    const res = await till().expect(200);
    expect(registeredResponseSchema('TillClose').safeParse(res.body).error?.issues ?? []).toEqual(
      [],
    );
    expect(res.body).toMatchObject({
      visitsCashGrosze: 11_000, // 80,00 − 50,00 + 80,00
      visitsVoucherGrosze: 5000,
      vouchersCashGrosze: 0,
      expectedCashGrosze: 11_000,
    });

    // Paid with vouchers more than the price: nothing in cash, never below zero.
    const second = await pay(visit.id, 4000);
    expect(second.body.voucher.balanceGrosze).toBe(3000);
    const over = await till().expect(200);
    expect(over.body).toMatchObject({ visitsCashGrosze: 8000, visitsVoucherGrosze: 8000 });

    // An undone payment is cash again (the newest payment is listed first).
    const uses = second.body.uses as { id: string; amountGrosze: number }[];
    await ctx
      .http()
      .post(`${vouchers()}/${voucher.id}/uses/${uses[0]!.id}/undo`)
      .set(owner.auth)
      .expect(200);
    const undone = await till().expect(200);
    expect(uses[0]!.amountGrosze).toBe(4000);
    expect(undone.body).toMatchObject({ visitsCashGrosze: 11_000, visitsVoucherGrosze: 5000 });
  });

  it('vouchers sold for cash go into the till of the day they were sold', async () => {
    const today = localToday(Date.now(), TZ);
    const cash = await sell({ amountGrosze: 10_000, paymentMethod: 'cash' }).expect(201);
    expect(cash.body.paymentMethod).toBe('cash');
    const card = await sell({ amountGrosze: 7000, paymentMethod: 'card' }).expect(201);
    expect(card.body.paymentMethod).toBe('card');
    const unknown = await sell({ amountGrosze: 3000 }).expect(201);
    expect(unknown.body.paymentMethod).toBeNull();
    await sell({ amountGrosze: 3000, paymentMethod: 'cheque' }).expect(400);
    const cancelled = (await sell({ amountGrosze: 4000, paymentMethod: 'cash' }).expect(201)).body;
    await ctx.http().post(`${vouchers()}/${cancelled.id}/cancel`).set(owner.auth).expect(200);

    const list = await ctx.http().get(vouchers()).set(owner.auth).expect(200);
    expect(
      Object.fromEntries(
        list.body.vouchers.map((v: { id: string; paymentMethod: string | null }) => [
          v.id,
          v.paymentMethod,
        ]),
      ),
    ).toMatchObject({ [cash.body.id]: 'cash', [card.body.id]: 'card', [unknown.body.id]: null });

    const res = await till(today).expect(200);
    expect(res.body).toMatchObject({
      vouchersCashGrosze: 10_000,
      expectedCashGrosze: 10_000,
    });
    const closed = await close({ date: today, countedCashGrosze: 10_000 }).expect(200);
    expect(closed.body.close).toMatchObject({ expectedCashGrosze: 10_000, differenceGrosze: 0 });
    // Not on another day.
    expect((await till(DAY).expect(200)).body.vouchersCashGrosze).toBe(0);

    // A day with only a voucher sold for cash is a day with cash (task 239).
    await ctx.prisma.giftVoucher.update({
      where: { id: cash.body.id },
      data: { createdAt: new Date(zonedToInstant(DAY, 12 * 60, TZ)) },
    });
    expect((await till(today).expect(200)).body.unclosedDay).toBe(DAY);
    expect((await till(DAY).expect(200)).body.vouchersCashGrosze).toBe(10_000);
  });
});

describe('"Inne płatności" — what the day brought not in cash (task 552)', () => {
  const vouchers = () => `${base}/gift-vouchers`;
  const sell = (body: Record<string, unknown>) =>
    ctx.http().post(vouchers()).set(owner.auth).send(body);

  it('card, BLIK, transfer and other visits and vouchers of the day, by way of paying', async () => {
    // Nothing yet.
    expect((await till().expect(200)).body.otherPayments).toEqual([]);

    const card = (await walkIn(at(9), { paid: true, paymentMethod: 'card' }).expect(201)).body;
    await walkIn(at(10), { paid: true, paymentMethod: 'card' }).expect(201);
    await walkIn(at(11), { paid: true, paymentMethod: 'transfer' }).expect(201);
    await walkIn(at(12), { paid: true, paymentMethod: 'cash' }).expect(201); // cash — not here
    await walkIn(at(13)).expect(201); // not paid — not here

    // A card visit paid partly with a voucher: only the rest went through the terminal.
    const voucher = (await sell({ amountGrosze: 10_000 }).expect(201)).body;
    await ctx
      .http()
      .post(`${vouchers()}/${voucher.id}/redeem`)
      .set(owner.auth)
      .send({ amountGrosze: 3000, appointmentId: card.id })
      .expect(200);

    const res = await till().expect(200);
    expect(registeredResponseSchema('TillClose').safeParse(res.body).error?.issues ?? []).toEqual(
      [],
    );
    expect(res.body.otherPayments).toEqual([
      {
        method: 'card',
        visits: 2,
        visitsGrosze: 13_000, // 80,00 − 30,00 + 80,00
        vouchers: 0,
        vouchersGrosze: 0,
        totalGrosze: 13_000,
      },
      {
        method: 'transfer',
        visits: 1,
        visitsGrosze: 8000,
        vouchers: 0,
        vouchersGrosze: 0,
        totalGrosze: 8000,
      },
    ]);
    // Cash stays where it was.
    expect(res.body.visitsCashGrosze).toBe(8000);
  });

  it('vouchers sold that day by card or BLIK; a cancelled one is left out', async () => {
    const today = localToday(Date.now(), TZ);
    await sell({ amountGrosze: 15_000, paymentMethod: 'blik' }).expect(201);
    await sell({ amountGrosze: 5000, paymentMethod: 'blik' }).expect(201);
    await sell({ amountGrosze: 7000, paymentMethod: 'card' }).expect(201);
    await sell({ amountGrosze: 2000 }).expect(201); // not noted — not here
    const cancelled = (await sell({ amountGrosze: 4000, paymentMethod: 'card' }).expect(201)).body;
    await ctx.http().post(`${vouchers()}/${cancelled.id}/cancel`).set(owner.auth).expect(200);

    const res = await till(today).expect(200);
    expect(res.body.otherPayments).toEqual([
      {
        method: 'card',
        visits: 0,
        visitsGrosze: 0,
        vouchers: 1,
        vouchersGrosze: 7000,
        totalGrosze: 7000,
      },
      {
        method: 'blik',
        visits: 0,
        visitsGrosze: 0,
        vouchers: 2,
        vouchersGrosze: 20_000,
        totalGrosze: 20_000,
      },
    ]);
    // Not on another day.
    expect((await till(DAY).expect(200)).body.otherPayments).toEqual([]);
  });

  it('"Sprawdzono z terminalem i kontem" is kept with the close; counting again replaces it (task 554)', async () => {
    await walkIn(at(10), { paid: true, paymentMethod: 'card' }).expect(201);
    const before = (await till().expect(200)).body;
    expect(before.close).toBeNull();

    const checked = (
      await close({ date: DAY, countedCashGrosze: 0, nonCashChecked: true }).expect(200)
    ).body;
    expect(registeredResponseSchema('TillClose').safeParse(checked).error?.issues ?? []).toEqual(
      [],
    );
    expect(checked.close).toMatchObject({ countedCashGrosze: 0, nonCashChecked: true });
    expect((await till().expect(200)).body.close.nonCashChecked).toBe(true);

    // Counted again without the mark — not checked any more.
    const again = (await close({ date: DAY, countedCashGrosze: 0 }).expect(200)).body;
    expect(again.close.nonCashChecked).toBe(false);
    await close({ date: DAY, countedCashGrosze: 0, nonCashChecked: 'yes' }).expect(400);
  });
});
