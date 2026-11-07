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

  it("the report lists the counted days of the period; not in a specialist's own report (tasks 233, 237)", async () => {
    await walkIn(at(10), { paid: true, paymentMethod: 'cash' }).expect(201);
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
        },
        {
          date: DAY,
          expectedCashGrosze: 8000,
          countedCashGrosze: 7000,
          differenceGrosze: -1000,
          cashInGrosze: 5000,
          cashOutGrosze: 5000,
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
    expect(lines[0]).toBe('Data;Godzina;Rodzaj;Kwota;Powinno być;Różnica;Powód / notatka;Kto');
    const rows = lines.slice(1).map((l) => l.replace(/;\d\d:\d\d;/, ';HH:MM;'));
    expect(rows).toEqual([
      `${earlier};HH:MM;Wypłata z kasy;5,00;;;Kawa;Anna Właścicielka`,
      `${DAY};HH:MM;Wpłata do kasy;100,00;;;Reszta na początek;Anna Właścicielka`,
      `${DAY};HH:MM;Wypłata z kasy;15,50;;;"'=Ręczniki; ""Biedronka""";Anna Właścicielka`,
      `${DAY};HH:MM;Zamknięcie kasy;150,00;164,50;-14,50;Brak;Anna Właścicielka`,
    ]);

    const english = (await csv({ locale: 'en' }).expect(200)).body as string;
    expect(english).toContain('Date;Time;Entry;Amount;Should be;Difference;Reason / note;By');
    expect(english).toContain(';Till closed;150.00;164.50;-14.50;Brak;');
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
