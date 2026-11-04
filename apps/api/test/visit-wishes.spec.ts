import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { addDays, localToday, zonedToInstant } from '../src/scheduling/time';
import {
  createOrgWithLocation,
  createTestApp,
  LEGAL_TEXTS,
  resetState,
  signUp,
  type SignedInUser,
  type TestContext,
} from './helpers';

/** Task 80: the client's wishes for a visit — asked on the last booking step. */

const TZ = 'Europe/Warsaw';
const CLIENT = {
  name: 'Anna Kowalska',
  phone: '+48 600 100 200',
  email: 'anna.client@example.com',
  locale: 'pl',
  acceptTerms: true,
};

let ctx: TestContext;
let owner: SignedInUser;
let orgId: string;
let slug: string;
let base: string;
let serviceId: string;
let staffId: string;
let day: string;

beforeAll(async () => {
  ctx = await createTestApp();
});

afterAll(async () => {
  await ctx.app.close();
});

beforeEach(async () => {
  await resetState(ctx);
  owner = await signUp(ctx, 'owner@example.com');
  const org = await createOrgWithLocation(ctx, owner, 'Barber');
  ({ orgId, slug } = org);
  base = `/v1/organizations/${orgId}/locations/${org.locationId}`;
  serviceId = (
    await ctx
      .http()
      .post(`${base}/services`)
      .set(owner.auth)
      .send({ name: 'Strzyżenie', durationMinutes: 30, priceGrosze: 8000 })
      .expect(201)
  ).body.id;
  staffId = (
    await ctx
      .http()
      .post(`${base}/staff`)
      .set(owner.auth)
      .send({ displayName: 'Kasia', serviceIds: [serviceId] })
      .expect(201)
  ).body.id;
  await ctx
    .http()
    .put(`${base}/staff/${staffId}/working-hours`)
    .set(owner.auth)
    .send({
      days: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
        weekday,
        intervals: [{ start: '09:00', end: '18:00' }],
      })),
    })
    .expect(200);
  await settings({ onlineBookingEnabled: true, ...LEGAL_TEXTS });
  day = addDays(localToday(Date.now(), TZ), 3);
});

async function settings(changes: object) {
  const loc = await ctx.http().get(base).set(owner.auth).expect(200);
  return ctx
    .http()
    .patch(base)
    .set(owner.auth)
    .send({ version: loc.body.version, ...changes });
}

const at = (hh: number) => new Date(zonedToInstant(day, hh * 60, TZ)).toISOString();

function lastCode(): string {
  const match = ctx.mail.lastTo(CLIENT.email)?.text.match(/\b(\d{6})\b/);
  if (!match?.[1]) throw new Error('no code sent');
  return match[1];
}

/** Books online with these wishes; returns the confirmation body. */
async function book(hh: number, wishes?: object) {
  const h = await ctx
    .http()
    .post(`/v1/public/locations/${slug}/holds`)
    .send({ serviceId, staffId, start: at(hh) })
    .expect(201);
  await ctx
    .http()
    .post(`/v1/public/holds/${h.body.holdId}/code`)
    .send({ holdToken: h.body.holdToken, ...CLIENT })
    .expect(202);
  const c = await ctx
    .http()
    .post(`/v1/public/holds/${h.body.holdId}/confirm`)
    .send({ holdToken: h.body.holdToken, code: lastCode(), ...(wishes ? { wishes } : {}) })
    .expect(200);
  return c.body as {
    appointment: { id: string; wishes: object; wishQuestions: object; canChangeWishes: boolean };
    manageToken: string;
  };
}

describe('visit wishes', () => {
  it('the salon chooses the questions: mood and note by default, drinks it offers', async () => {
    const loc = await ctx.http().get(base).set(owner.auth).expect(200);
    expect(loc.body).toMatchObject({ askMood: true, askDrink: false, drinks: [], askNote: true });
    const page = await ctx.http().get(`/v1/public/locations/${slug}`).expect(200);
    expect(page.body.wishQuestions).toEqual({ mood: true, drinks: [], note: true });

    const saved = await settings({
      askDrink: true,
      drinks: ['tea', 'coffee', 'tea'],
      askMood: false,
    });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ askMood: false, askDrink: true, drinks: ['tea', 'coffee'] });
    const after = await ctx.http().get(`/v1/public/locations/${slug}`).expect(200);
    expect(after.body.wishQuestions).toEqual({
      mood: false,
      drinks: ['tea', 'coffee'],
      note: true,
    });

    // "none" is an answer, not something a salon offers.
    expect((await settings({ drinks: ['none'] })).status).toBe(400);
  });

  it('answers are kept on the visit and the client; questions not asked are ignored', async () => {
    await settings({ askDrink: true, drinks: ['coffee', 'water'] });
    const first = await book(10, {
      mood: 'quiet',
      drink: 'tea', // not offered: dropped
      note: '  Wrażliwa skóra głowy  ',
    });
    expect(first.appointment.wishes).toEqual({
      mood: 'quiet',
      drink: null,
      note: 'Wrażliwa skóra głowy',
    });
    expect(first.appointment.wishQuestions).toEqual({
      mood: true,
      drinks: ['coffee', 'water'],
      note: true,
    });

    // The salon sees them on the visit (like the visit note).
    const visit = await ctx
      .http()
      .get(`${base}/appointments/${first.appointment.id}`)
      .set(owner.auth)
      .expect(200);
    expect(visit.body.wishes).toEqual({ mood: 'quiet', drink: null, note: 'Wrażliwa skóra głowy' });

    // Remembered on the client's card for the next booking.
    const customer = await ctx.prisma.customer.findFirstOrThrow({
      where: { email: CLIENT.email },
    });
    expect([customer.wishMood, customer.wishDrink, customer.wishNote]).toEqual([
      'quiet',
      null,
      'Wrażliwa skóra głowy',
    ]);

    // A skipped step does not wipe what was remembered; the visit itself has no wishes.
    const second = await book(12);
    expect(second.appointment.wishes).toEqual({ mood: null, drink: null, note: null });
    const still = await ctx.prisma.customer.findUniqueOrThrow({ where: { id: customer.id } });
    expect(still.wishMood).toBe('quiet');

    // Too long a note is refused.
    const h = await ctx
      .http()
      .post(`/v1/public/locations/${slug}/holds`)
      .send({ serviceId, staffId, start: at(14) })
      .expect(201);
    await ctx
      .http()
      .post(`/v1/public/holds/${h.body.holdId}/code`)
      .send({ holdToken: h.body.holdToken, ...CLIENT })
      .expect(202);
    await ctx
      .http()
      .post(`/v1/public/holds/${h.body.holdId}/confirm`)
      .send({ holdToken: h.body.holdToken, code: lastCode(), wishes: { note: 'x'.repeat(201) } })
      .expect(400);
  });

  it('the client changes them by the link until the visit starts', async () => {
    await settings({ askDrink: true, drinks: ['coffee'] });
    const booked = await book(10, { mood: 'chat' });
    const url = `/v1/public/appointments/${booked.manageToken}`;
    expect(booked.appointment.canChangeWishes).toBe(true);

    const changed = await ctx
      .http()
      .put(`${url}/wishes`)
      .send({ mood: 'relax', drink: 'coffee', note: 'Bez golenia karku' })
      .expect(200);
    expect(changed.body.wishes).toEqual({
      mood: 'relax',
      drink: 'coffee',
      note: 'Bez golenia karku',
    });
    const read = await ctx.http().get(url).expect(200);
    expect(read.body.wishes.mood).toBe('relax');
    const customer = await ctx.prisma.customer.findFirstOrThrow({
      where: { email: CLIENT.email },
    });
    expect(customer.wishDrink).toBe('coffee');
    const history = await ctx
      .http()
      .get(`${base}/appointments/${booked.appointment.id}`)
      .set(owner.auth)
      .expect(200);
    expect(history.body.history.map((e: { type: string }) => e.type)).toContain('wishes_changed');

    // Clearing the note; "none" is always a valid drink answer.
    const cleared = await ctx
      .http()
      .put(`${url}/wishes`)
      .send({ note: '', drink: 'none' })
      .expect(200);
    expect(cleared.body.wishes).toEqual({ mood: 'relax', drink: 'none', note: null });

    // Once the visit has started — too late.
    const start = new Date(Date.now() - 60_000);
    await ctx.prisma.appointment.update({
      where: { id: booked.appointment.id },
      data: {
        startAt: start,
        endAt: new Date(start.getTime() + 30 * 60_000),
        blockedUntil: new Date(start.getTime() + 30 * 60_000),
      },
    });
    const late = await ctx.http().put(`${url}/wishes`).send({ mood: 'quiet' }).expect(409);
    expect(late.body.error.code).toBe('TOO_LATE_TO_CHANGE');
    expect((await ctx.http().get(url).expect(200)).body.canChangeWishes).toBe(false);
    await ctx.http().put(`/v1/public/appointments/not-a-token/wishes`).send({}).expect(404);
  });
});
