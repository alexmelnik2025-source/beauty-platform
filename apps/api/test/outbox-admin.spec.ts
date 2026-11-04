import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { LOCK_SECONDS, OutboxService, SimulatedCrash } from '../src/booking/outbox.service';
import { MailRetryableError, maskEmails, ResendMailService } from '../src/mail/mail.service';
import { addDays, localToday, zonedToInstant } from '../src/scheduling/time';
import {
  createOrgWithLocation,
  createTestApp,
  resetState,
  signUp,
  type SignedInUser,
  type TestContext,
} from './helpers';

const TZ = 'Europe/Warsaw';
let ctx: TestContext;
let outbox: OutboxService;
let owner: SignedInUser;
let admin: SignedInUser;
let base: string;
let serviceId: string;
let staffId: string;
let day: string;

const at = (hh: number) => new Date(zonedToInstant(day, hh * 60, TZ)).toISOString();

/** A manual appointment with a client email → one confirmation email in the queue. */
const book = (hh: number, email = 'anna@example.com') =>
  ctx
    .http()
    .post(`${base}/appointments`)
    .set(owner.auth)
    .send({
      serviceId,
      staffId,
      start: at(hh),
      customer: { name: 'Anna', phone: '+48600100200', email },
    })
    .expect(201);

const makeQueueDue = () =>
  ctx.prisma
    .$executeRaw`UPDATE notification_outbox SET next_attempt_at = now(), locked_until = NULL WHERE status = 'pending'`;

beforeAll(async () => {
  ctx = await createTestApp();
  outbox = ctx.app.get(OutboxService);
});

afterAll(async () => {
  await ctx.app.close();
});

beforeEach(async () => {
  await resetState(ctx);
  owner = await signUp(ctx, 'owner@example.com');
  admin = await signUp(ctx, 'admin@example.com');
  const org = await createOrgWithLocation(ctx, owner, 'Barber');
  base = `/v1/organizations/${org.orgId}/locations/${org.locationId}`;
  serviceId = (
    await ctx
      .http()
      .post(`${base}/services`)
      .set(owner.auth)
      .send({ name: 'Strzyżenie', durationMinutes: 30, priceGrosze: 5000 })
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
  day = addDays(localToday(Date.now(), TZ), 3);
  ctx.mail.clear();
});

describe('sending one email at a time', () => {
  it('claims a single email and locks it for 5 minutes', async () => {
    await book(10);
    await book(12);
    expect(
      await ctx.prisma.notificationOutbox.count({ where: { type: 'client_confirmation' } }),
    ).toBe(2);

    // The process "dies" right after the first send: only that email is claimed.
    await expect(
      outbox.drain({
        afterSend: () => {
          throw new SimulatedCrash('process died');
        },
      }),
    ).rejects.toThrow('process died');
    const rows = await ctx.prisma.notificationOutbox.findMany({
      where: { type: 'client_confirmation' },
      orderBy: { id: 'asc' },
    });
    expect(rows.map((r) => r.attempts)).toEqual([1, 0]);
    expect(rows[1]!.lockedUntil).toBeNull();
    const lockedFor = (rows[0]!.lockedUntil!.getTime() - Date.now()) / 1000;
    expect(lockedFor).toBeGreaterThan(LOCK_SECONDS - 30);
    expect(lockedFor).toBeLessThanOrEqual(LOCK_SECONDS + 1);
  });
});

describe('failed emails: monitoring and manual retry', () => {
  async function failCompletely(): Promise<void> {
    // Only the confirmation should take the simulated failures, not tomorrow's reminder.
    await ctx.prisma.notificationOutbox.deleteMany({ where: { type: 'client_reminder' } });
    ctx.mail.failNext(5, 'Mailbox anna@example.com rejected the message');
    for (let i = 0; i < 5; i += 1) {
      await makeQueueDue();
      await outbox.drain();
    }
  }

  it('the administrator sees failed emails without addresses and sends them again once', async () => {
    await book(10);
    await failCompletely();
    const row = await ctx.prisma.notificationOutbox.findFirstOrThrow({
      where: { type: 'client_confirmation' },
    });
    expect(row.status).toBe('failed');
    expect(row.lastError).toBe('Mailbox ***@*** rejected the message');

    const stats = await ctx.http().get('/v1/admin/outbox').set(admin.auth).expect(200);
    expect(stats.body).toMatchObject({ status: 'warning', problems: ['failed'], failed: 1 });
    const failed = await ctx.http().get('/v1/admin/outbox/failed').set(admin.auth).expect(200);
    expect(failed.body).toHaveLength(1);
    expect(failed.body[0]).toMatchObject({ type: 'client_confirmation', attempts: 5 });
    expect(JSON.stringify(failed.body)).not.toContain('anna@example.com');

    const retried = await ctx
      .http()
      .post('/v1/admin/outbox/retry')
      .set(admin.auth)
      .send({ ids: [failed.body[0].id] })
      .expect(200);
    expect(retried.body).toEqual({ requeued: 1 });
    await outbox.drain();
    await outbox.drain();
    expect(ctx.mail.allTo('anna@example.com')).toHaveLength(1);
    const after = await ctx.http().get('/v1/admin/outbox').set(admin.auth).expect(200);
    expect(after.body).toMatchObject({ status: 'ok', failed: 0, sentLast24h: 1 });
  });

  it('only platform administrators reach the queue pages (others get 404)', async () => {
    await ctx.http().get('/v1/admin/outbox').set(owner.auth).expect(404);
    await ctx.http().post('/v1/admin/outbox/retry').set(owner.auth).send({ all: true }).expect(404);
    await ctx.http().get('/v1/admin/outbox').expect(401);
    const me = await ctx.http().get('/v1/me').set(admin.auth).expect(200);
    expect(me.body.isPlatformAdmin).toBe(true);
    const ownerMe = await ctx.http().get('/v1/me').set(owner.auth).expect(200);
    expect(ownerMe.body.isPlatformAdmin).toBe(false);
  });

  it('alerts the administrators once an hour while there is a problem', async () => {
    await book(10);
    await failCompletely();
    ctx.mail.clear();
    const now = Date.now() + 2 * 3600_000; // independent of alerts sent by earlier tests
    expect(await outbox.checkAlerts(now)).toBe(true);
    expect(ctx.mail.lastTo('admin@example.com')?.subject).toContain('email queue');
    expect(await outbox.checkAlerts(now + 60_000)).toBe(false);
    expect(ctx.mail.allTo('admin@example.com')).toHaveLength(1);
  });

  it('a due email waiting too long counts as stuck', async () => {
    await book(10);
    await ctx.prisma
      .$executeRaw`UPDATE notification_outbox SET next_attempt_at = now() - interval '20 minutes'`;
    const stats = await outbox.stats();
    expect(stats.problems).toEqual(['stuck']);
    expect(stats.oldestDueSeconds).toBeGreaterThanOrEqual(20 * 60);
  });
});

describe('cleanup', () => {
  it('deletes sent emails after 30 days and failed ones after 90', async () => {
    const old = (days: number) => new Date(Date.now() - days * 86_400_000);
    const row = (status: 'sent' | 'failed' | 'pending', createdAt: Date, key: string) => ({
      type: 'client_confirmation',
      payload: { appointmentId: '00000000-0000-7000-8000-000000000000', version: 1 },
      status,
      createdAt,
      dedupeKey: key,
    });
    await ctx.prisma.notificationOutbox.createMany({
      data: [
        row('sent', old(31), 'a'),
        row('sent', old(5), 'b'),
        row('failed', old(60), 'c'),
        row('failed', old(91), 'd'),
        row('pending', old(120), 'e'),
      ],
    });
    expect(await outbox.cleanup()).toBe(2);
    const left = await ctx.prisma.notificationOutbox.findMany({ orderBy: { dedupeKey: 'asc' } });
    expect(left.map((r) => r.dedupeKey)).toEqual(['b', 'c', 'e']);
  });
});

describe('Resend: duplicates are refused by idempotency key', () => {
  /** A stand-in for api.resend.com that behaves as its documentation describes. */
  let server: Server;
  let url: string;
  let delivered: string[];
  let lastBody: Record<string, unknown> = {};
  const seen = new Map<string, string>();
  let busyKey: string | undefined;

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        const key = req.headers['idempotency-key'] as string | undefined;
        const reply = (status: number, json: object) => {
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(json));
        };
        if (req.headers.authorization !== 'Bearer re_test') {
          return reply(401, { name: 'missing_api_key' });
        }
        if (key && key === busyKey) return reply(409, { name: 'concurrent_idempotent_requests' });
        if (key && seen.has(key)) {
          if (seen.get(key) !== body) return reply(409, { name: 'invalid_idempotent_request' });
          return reply(200, { id: `email-${key}` });
        }
        if (key) seen.set(key, body);
        lastBody = JSON.parse(body);
        delivered.push(JSON.parse(body).to[0]);
        return reply(200, { id: `email-${delivered.length}` });
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  beforeEach(() => {
    delivered = [];
    seen.clear();
    busyKey = undefined;
  });

  const message = { to: 'anna@example.com', subject: 'Wizyta potwierdzona', text: 'Do zobaczenia' };

  it('a resend with the same key after a crash delivers nothing new', async () => {
    const mail = new ResendMailService(url, 're_test', 'Salon <no-reply@example.com>');
    await mail.send(message, { idempotencyKey: 'row-1-0' });
    await mail.send(message, { idempotencyKey: 'row-1-0' });
    await mail.send(message, { idempotencyKey: 'row-2-0' });
    expect(delivered).toEqual(['anna@example.com', 'anna@example.com']);
  });

  it('"same key still in progress" is retried later; other refusals are errors', async () => {
    const mail = new ResendMailService(url, 're_test', 'Salon <no-reply@example.com>');
    busyKey = 'row-3-0';
    await expect(mail.send(message, { idempotencyKey: 'row-3-0' })).rejects.toBeInstanceOf(
      MailRetryableError,
    );
    const wrongKey = new ResendMailService(url, 're_wrong', 'Salon <no-reply@example.com>');
    await expect(wrongKey.send(message)).rejects.toThrow('Resend answered 401 missing_api_key');
  });

  it('sends the salon as sender, its reply address and an HTML version (L2)', async () => {
    const mail = new ResendMailService(url, 're_test', 'Salon <no-reply@example.com>');
    await mail.send({
      ...message,
      senderName: 'Berber Moda',
      replyTo: 'salon@example.com',
      lang: 'tr',
    });
    expect(lastBody).toMatchObject({
      from: '"Berber Moda" <no-reply@example.com>',
      to: ['anna@example.com'],
      reply_to: 'salon@example.com',
      text: 'Do zobaczenia',
    });
    expect(lastBody.html).toContain('<html lang="tr">');
  });

  it('removes addresses from error texts', () => {
    expect(maskEmails('550 <anna.k@example.com>: no such user')).toBe(
      '550 <***@***>: no such user',
    );
  });
});
