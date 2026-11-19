import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RateLimiterService } from '../src/common/rate-limiter.service';
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

/**
 * Task Q2: where an online booking came from — the booking page sends a channel with the hold
 * ("qr" with the specialist whose code was scanned, "embed", "app", a utm_source…); the salon
 * report counts the visits of the period by channel ("Skąd przyszli").
 */

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
let base: string;
let slug: string;
let locationId: string;
let serviceId: string;
let kasia: string;
let ola: string;
let day: string;

const at = (date: string, hh: number, mm = 0): string =>
  new Date(zonedToInstant(date, hh * 60 + mm, TZ)).toISOString();

beforeAll(async () => {
  ctx = await createTestApp();
});

afterAll(async () => {
  await ctx.app.close();
});

beforeEach(async () => {
  await resetState(ctx);
  // Several bookings from one address in a row: not what the rate limiter is for here.
  ctx.app.get(RateLimiterService).enabled = false;
  owner = await signUp(ctx, 'owner@example.com');
  const org = await createOrgWithLocation(ctx, owner, 'Barber');
  ({ locationId, slug } = org);
  base = `/v1/organizations/${org.orgId}/locations/${locationId}`;
  const service = await ctx
    .http()
    .post(`${base}/services`)
    .set(owner.auth)
    .send({ name: 'Strzyżenie', durationMinutes: 45, bufferMinutes: 15, priceGrosze: 8000 })
    .expect(201);
  serviceId = service.body.id;
  const created: string[] = [];
  for (const name of ['Kasia', 'Ola']) {
    const staff = await ctx
      .http()
      .post(`${base}/staff`)
      .set(owner.auth)
      .send({ displayName: name, serviceIds: [serviceId] })
      .expect(201);
    await ctx
      .http()
      .put(`${base}/staff/${staff.body.id}/working-hours`)
      .set(owner.auth)
      .send({
        days: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
          weekday,
          intervals: [{ start: '09:00', end: '18:00' }],
        })),
      })
      .expect(200);
    created.push(staff.body.id);
  }
  [kasia, ola] = created as [string, string];
  const loc = await ctx.http().get(base).set(owner.auth).expect(200);
  await ctx
    .http()
    .patch(base)
    .set(owner.auth)
    .send({ version: loc.body.version, onlineBookingEnabled: true, ...LEGAL_TEXTS })
    .expect(200);
  day = addDays(localToday(Date.now(), TZ), 3);
});

const hold = (start: string, staffId: string, extra: Record<string, unknown> = {}) =>
  ctx
    .http()
    .post(`/v1/public/locations/${slug}/holds`)
    .send({ serviceId, start, staffId, ...extra });

function lastCode(email = CLIENT.email): string {
  const match = ctx.mail.lastTo(email)?.text.match(/\b(\d{6})\b/);
  if (!match?.[1]) throw new Error(`no code sent to ${email}`);
  return match[1];
}

/** Books `start` with `staffId` online, sending `extra` (channel…) with the hold. */
async function book(
  start: string,
  staffId: string,
  extra: Record<string, unknown> = {},
  client = CLIENT,
): Promise<string> {
  const h = await hold(start, staffId, extra).expect(201);
  await ctx
    .http()
    .post(`/v1/public/holds/${h.body.holdId}/code`)
    .send({ holdToken: h.body.holdToken, ...client })
    .expect(202);
  await ctx
    .http()
    .post(`/v1/public/holds/${h.body.holdId}/confirm`)
    .send({ holdToken: h.body.holdToken, code: lastCode(client.email) })
    .expect(200);
  return h.body.holdId as string;
}

const stored = (id: string) =>
  ctx.prisma.appointment.findUniqueOrThrow({
    where: { id },
    select: { channel: true, channelStaffId: true, status: true },
  });

describe('the channel of an online booking (task Q2)', () => {
  it('a hold keeps the channel and, for a QR code, the specialist whose code it was', async () => {
    const id = await book(at(day, 10), kasia, {
      channel: 'qr',
      channelStaffId: ola,
    });
    expect(await stored(id)).toEqual({
      channel: 'qr',
      channelStaffId: ola,
      status: 'confirmed',
    });
  });

  it('without a channel nothing is kept; the channel is lower-cased; a specialist of another salon does not count', async () => {
    const plain = await book(at(day, 10), kasia);
    expect(await stored(plain)).toMatchObject({ channel: null, channelStaffId: null });

    const other = await signUp(ctx, 'other@example.com');
    const otherOrg = await createOrgWithLocation(ctx, other, 'Inny');
    const foreign = await ctx
      .http()
      .post(`/v1/organizations/${otherOrg.orgId}/locations/${otherOrg.locationId}/staff`)
      .set(other.auth)
      .send({ displayName: 'Obcy' })
      .expect(201);

    const qr = await book(
      at(day, 12),
      kasia,
      { channel: ' Instagram ', channelStaffId: foreign.body.id },
      { ...CLIENT, email: 'second.client@example.com' },
    );
    expect(await stored(qr)).toMatchObject({ channel: 'instagram', channelStaffId: null });

    // The specialist is kept only for a QR code.
    const embed = await book(
      at(day, 14),
      kasia,
      { channel: 'embed', channelStaffId: ola },
      { ...CLIENT, email: 'third.client@example.com' },
    );
    expect(await stored(embed)).toMatchObject({ channel: 'embed', channelStaffId: null });
  });

  it('a channel that is not letters, digits, "-" or "_" is refused', async () => {
    const bad = await hold(at(day, 10), kasia, { channel: 'kod QR!' }).expect(400);
    expect(bad.body.error.code).toBe('VALIDATION_ERROR');
    await hold(at(day, 10), kasia, { channel: 'a'.repeat(41) }).expect(400);
  });
});

describe('"Skąd przyszli" in the salon report (task Q2)', () => {
  it('counts the online visits of the period by channel, with new clients and the QR codes of specialists', async () => {
    await book(at(day, 9), kasia, { channel: 'qr', channelStaffId: ola });
    await book(
      at(day, 10),
      kasia,
      { channel: 'qr', channelStaffId: ola },
      { ...CLIENT, email: 'b@example.com' },
    );
    await book(at(day, 11), kasia, { channel: 'qr' }, { ...CLIENT, email: 'c@example.com' });
    // Anna again, from the salon's site: not a new client any more.
    await book(at(day, 13), kasia, { channel: 'embed' });
    // An older visit of Anna before the period: she is not new in the period at all.
    await book(at(day, 15), ola, { channel: 'web' });
    // Written down by the salon: not online, so not in the channels.
    await ctx
      .http()
      .post(`${base}/appointments`)
      .set(owner.auth)
      .send({
        serviceId,
        staffId: ola,
        start: at(day, 16),
        customer: { name: 'Jan', phone: '+48 600 300 400' },
      })
      .expect(201);

    const report = await ctx
      .http()
      .get(`${base}/reports`)
      .set(owner.auth)
      .query({ from: day, to: day })
      .expect(200);
    const channels = report.body.channels;
    expect(channels.online).toBe(5);
    expect(channels.items).toEqual([
      { key: 'qr', visits: 3, completed: 0, cancelled: 0, newClients: 3 },
      { key: 'embed', visits: 1, completed: 0, cancelled: 0, newClients: 0 },
      { key: 'web', visits: 1, completed: 0, cancelled: 0, newClients: 0 },
    ]);
    expect(channels.qrStaff).toEqual([{ id: ola, name: 'Ola', visits: 2 }]);
  });

  it('visits booked before channels were kept are "unknown"; a client with an earlier visit is not new', async () => {
    const earlierDay = addDays(day, -1);
    await book(at(earlierDay, 9), kasia, { channel: 'app' });
    const id = await book(at(day, 9), kasia, { channel: 'app' });
    await ctx.prisma.appointment.update({ where: { id }, data: { channel: null } });

    const report = await ctx
      .http()
      .get(`${base}/reports`)
      .set(owner.auth)
      .query({ from: day, to: day })
      .expect(200);
    expect(report.body.channels).toEqual({
      online: 1,
      items: [{ key: 'unknown', visits: 1, completed: 0, cancelled: 0, newClients: 0 }],
      qrStaff: [],
    });
  });
});
