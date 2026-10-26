import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PushService } from '../src/push/push.service';
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

const TZ = 'Europe/Warsaw';

let ctx: TestContext;
let owner: SignedInUser;
let orgId: string;
let locationId: string;
let slug: string;
let base: string;
let serviceId: string;
let kasiaId: string;
let olaId: string;
let day: string;

const at = (hh: number): string => new Date(zonedToInstant(day, hh * 60, TZ)).toISOString();
const invitations = () => `/v1/organizations/${orgId}/invitations`;

/** The invitation token from the last email sent to `email`. */
function inviteToken(email: string): string {
  const match = ctx.mail.lastTo(email)?.text.match(/\/invite\/(\S+)/);
  if (!match?.[1]) throw new Error(`no invitation sent to ${email}`);
  return match[1];
}

const invite = (body: object, auth = owner.auth) =>
  ctx.http().post(invitations()).set(auth).send(body);

/** Invites `email` as staff for `staffMemberId`, signs them up and accepts. */
async function joinAsStaff(email: string, staffMemberId: string): Promise<SignedInUser> {
  await invite({ email, role: 'staff', locationIds: [locationId], staffMemberId }).expect(201);
  const token = inviteToken(email);
  const user = await signUp(ctx, email, email.split('@')[0]);
  await ctx.http().post(`/v1/invitations/${token}/accept`).set(user.auth).expect(200);
  return user;
}

const feed = (user: SignedInUser) =>
  ctx.http().get('/v1/me/notifications').set(user.auth).expect(200);

beforeAll(async () => {
  ctx = await createTestApp();
});

afterAll(async () => {
  await ctx.app.close();
});

beforeEach(async () => {
  await resetState(ctx);
  owner = await signUp(ctx, 'owner@example.com');
  ({ orgId, locationId, slug } = await createOrgWithLocation(ctx, owner, 'Barber'));
  base = `/v1/organizations/${orgId}/locations/${locationId}`;
  serviceId = (
    await ctx
      .http()
      .post(`${base}/services`)
      .set(owner.auth)
      .send({ name: 'Strzyżenie', durationMinutes: 45, priceGrosze: 8000 })
      .expect(201)
  ).body.id;
  const ids: string[] = [];
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
    ids.push(staff.body.id);
  }
  [kasiaId, olaId] = ids as [string, string];
  day = addDays(localToday(Date.now(), TZ), 3);
});

describe('inviting staff and managers', () => {
  it('a staff member joins by link and gets the calendar profile and category', async () => {
    const category = await ctx
      .http()
      .post(`/v1/organizations/${orgId}/staff-categories`)
      .set(owner.auth)
      .send({ name: 'Senior', permissions: { viewClientContacts: true } })
      .expect(201);
    const sent = await invite({
      email: 'Kasia@Example.com',
      role: 'staff',
      locationIds: [locationId],
      staffMemberId: kasiaId,
      staffCategoryId: category.body.id,
      locale: 'uk',
    }).expect(201);
    expect(sent.body).toMatchObject({ email: 'kasia@example.com', status: 'pending' });
    expect(ctx.mail.lastTo('kasia@example.com')?.subject).toContain('Запрошення');

    const token = inviteToken('kasia@example.com');
    const preview = await ctx.http().get(`/v1/invitations/${token}`).expect(200);
    expect(preview.body).toMatchObject({ organizationName: 'Barber', role: 'staff' });

    const kasia = await signUp(ctx, 'kasia@example.com', 'Kasia');
    const joined = await ctx
      .http()
      .post(`/v1/invitations/${token}/accept`)
      .set(kasia.auth)
      .expect(200);
    expect(joined.body).toEqual({ organizationId: orgId, role: 'staff' });

    const staff = await ctx.prisma.staffMember.findUniqueOrThrow({ where: { id: kasiaId } });
    expect(staff.userId).toBe(kasia.userId);
    const members = await ctx
      .http()
      .get(`/v1/organizations/${orgId}/members`)
      .set(owner.auth)
      .expect(200);
    const member = members.body.find((m: { user: { id: string } }) => m.user.id === kasia.userId);
    expect(member).toMatchObject({ role: 'staff', staffCategoryId: category.body.id });
    expect(member.permissions.viewClientContacts).toBe(true);

    // The link works once.
    expectError(
      (await ctx.http().post(`/v1/invitations/${token}/accept`).set(kasia.auth).expect(410)).body,
      'INVITATION_EXPIRED',
    );
  });

  it('only the invited, verified email can accept', async () => {
    await invite({ email: 'kasia@example.com', role: 'staff', locationIds: [locationId] }).expect(
      201,
    );
    const stranger = await signUp(ctx, 'stranger@example.com');
    const res = await ctx
      .http()
      .post(`/v1/invitations/${inviteToken('kasia@example.com')}/accept`)
      .set(stranger.auth)
      .expect(403);
    expectError(res.body, 'EMAIL_MISMATCH');
    await ctx
      .http()
      .post(`/v1/invitations/${inviteToken('kasia@example.com')}/accept`)
      .expect(401);
  });

  it('inviting again or cancelling makes the old link stop working', async () => {
    const body = { email: 'kasia@example.com', role: 'staff', locationIds: [locationId] };
    await invite(body).expect(201);
    const first = inviteToken('kasia@example.com');
    const second = await invite(body).expect(201);
    const secondToken = inviteToken('kasia@example.com');
    const kasia = await signUp(ctx, 'kasia@example.com');
    await ctx.http().post(`/v1/invitations/${first}/accept`).set(kasia.auth).expect(410);

    await ctx.http().delete(`${invitations()}/${second.body.id}`).set(owner.auth).expect(204);
    await ctx.http().post(`/v1/invitations/${secondToken}/accept`).set(kasia.auth).expect(410);
    expect((await ctx.http().get(invitations()).set(owner.auth).expect(200)).body).toHaveLength(0);
  });

  it('an expired link is refused', async () => {
    await invite({ email: 'kasia@example.com', role: 'staff', locationIds: [locationId] }).expect(
      201,
    );
    const token = inviteToken('kasia@example.com');
    await ctx.prisma.invitation.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    const kasia = await signUp(ctx, 'kasia@example.com');
    await ctx.http().post(`/v1/invitations/${token}/accept`).set(kasia.auth).expect(410);
  });

  it('managers invite staff to their own locations only; staff cannot invite', async () => {
    const other = await ctx
      .http()
      .post(`/v1/organizations/${orgId}/locations`)
      .set(owner.auth)
      .send({ name: 'Wola', addressLine: 'ul. Wolska 1', city: 'Warszawa', postalCode: '01-001' })
      .expect(201);
    await invite({ email: 'boss@example.com', role: 'manager', locationIds: [locationId] }).expect(
      201,
    );
    const bossToken = inviteToken('boss@example.com');
    const manager = await signUp(ctx, 'boss@example.com');
    await ctx.http().post(`/v1/invitations/${bossToken}/accept`).set(manager.auth).expect(200);

    await invite(
      { email: 's1@example.com', role: 'staff', locationIds: [locationId] },
      manager.auth,
    ).expect(201);
    await invite(
      { email: 's2@example.com', role: 'staff', locationIds: [other.body.id] },
      manager.auth,
    ).expect(403);
    await invite(
      { email: 's3@example.com', role: 'manager', locationIds: [locationId] },
      manager.auth,
    ).expect(403);

    const kasia = await joinAsStaff('kasia@example.com', kasiaId);
    await invite(
      { email: 's4@example.com', role: 'staff', locationIds: [locationId] },
      kasia.auth,
    ).expect(403);
  });

  it('someone already in the team cannot be invited; an owner invite is not possible', async () => {
    expectError(
      (
        await invite({
          email: 'owner@example.com',
          role: 'staff',
          locationIds: [locationId],
        }).expect(409)
      ).body,
      'ALREADY_MEMBER',
    );
    await invite({ email: 'x@example.com', role: 'owner', locationIds: [locationId] }).expect(400);
  });

  it('removing a member ends their access at once; the calendar profile stays', async () => {
    const kasia = await joinAsStaff('kasia@example.com', kasiaId);
    await ctx
      .http()
      .get(`${base}/appointments`)
      .query({ from: day, to: day })
      .set(kasia.auth)
      .expect(200);
    const members = await ctx
      .http()
      .get(`/v1/organizations/${orgId}/members`)
      .set(owner.auth)
      .expect(200);
    const kasiaMember = members.body.find(
      (m: { user: { id: string } }) => m.user.id === kasia.userId,
    );
    const ownerMember = members.body.find((m: { role: string }) => m.role === 'owner');

    await ctx
      .http()
      .delete(`/v1/organizations/${orgId}/members/${kasiaMember.membershipId}`)
      .set(owner.auth)
      .expect(204);
    await ctx
      .http()
      .get(`${base}/appointments`)
      .query({ from: day, to: day })
      .set(kasia.auth)
      .expect(404);
    const staff = await ctx.prisma.staffMember.findUniqueOrThrow({ where: { id: kasiaId } });
    expect(staff).toMatchObject({ userId: null, displayName: 'Kasia' });

    expectError(
      (
        await ctx
          .http()
          .delete(`/v1/organizations/${orgId}/members/${ownerMember.membershipId}`)
          .set(owner.auth)
          .expect(400)
      ).body,
      'CANNOT_REMOVE_OWNER',
    );
  });
});

describe('notification feed', () => {
  async function bookOnline(staffId: string, hh: number): Promise<string> {
    const loc = await ctx.http().get(base).set(owner.auth).expect(200);
    if (!loc.body.onlineBookingEnabled) {
      await ctx
        .http()
        .patch(base)
        .set(owner.auth)
        .send({ version: loc.body.version, onlineBookingEnabled: true })
        .expect(200);
    }
    const hold = await ctx
      .http()
      .post(`/v1/public/locations/${slug}/holds`)
      .send({ serviceId, staffId, start: at(hh) })
      .expect(201);
    await ctx
      .http()
      .post(`/v1/public/holds/${hold.body.holdId}/code`)
      .send({
        holdToken: hold.body.holdToken,
        name: 'Anna Kowalska',
        phone: '+48600100200',
        email: 'anna@example.com',
        acceptTerms: true,
      })
      .expect(202);
    const code = ctx.mail.lastTo('anna@example.com')!.text.match(/\b(\d{6})\b/)![1];
    await ctx
      .http()
      .post(`/v1/public/holds/${hold.body.holdId}/confirm`)
      .send({ holdToken: hold.body.holdToken, code })
      .expect(200);
    return hold.body.holdId;
  }

  it('an online booking reaches the staff member and the owner, without client contacts', async () => {
    const kasia = await joinAsStaff('kasia@example.com', kasiaId);
    const appointmentId = await bookOnline(kasiaId, 10);

    for (const user of [kasia, owner]) {
      const items = (await feed(user)).body;
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        type: 'appointment.booked',
        appointmentId,
        read: false,
        data: { time: '10:00', serviceName: 'Strzyżenie', staffName: 'Kasia', by: 'client' },
      });
      expect(JSON.stringify(items[0])).not.toContain('600100200');
      expect(JSON.stringify(items[0])).not.toContain('anna@example.com');
    }
    const count = await ctx
      .http()
      .get('/v1/me/notifications/unread-count')
      .set(kasia.auth)
      .expect(200);
    expect(count.body).toEqual({ unread: 1 });
  });

  it('a change by the salon notifies the staff member, not the person who made it', async () => {
    const kasia = await joinAsStaff('kasia@example.com', kasiaId);
    const ola = await joinAsStaff('ola@example.com', olaId);
    const created = await ctx
      .http()
      .post(`${base}/appointments`)
      .set(owner.auth)
      .send({
        serviceId,
        staffId: kasiaId,
        start: at(11),
        customer: { name: 'Jan', phone: '+48600000001' },
      })
      .expect(201);
    expect((await feed(owner)).body).toHaveLength(0);
    expect((await feed(kasia)).body.map((n: { type: string }) => n.type)).toEqual([
      'appointment.created',
    ]);

    // Moving to Ola tells both the previous and the new staff member.
    await ctx
      .http()
      .post(`${base}/appointments/${created.body.id}/reschedule`)
      .set(owner.auth)
      .send({ version: created.body.version, start: at(14), staffId: olaId })
      .expect(200);
    expect((await feed(kasia)).body.map((n: { type: string }) => n.type)).toEqual([
      'appointment.rescheduled',
      'appointment.created',
    ]);
    expect((await feed(ola)).body.map((n: { type: string }) => n.type)).toEqual([
      'appointment.rescheduled',
    ]);
    expect((await feed(owner)).body).toHaveLength(0);
  });

  it('marking as read: own notifications only', async () => {
    const kasia = await joinAsStaff('kasia@example.com', kasiaId);
    await bookOnline(kasiaId, 10);
    await bookOnline(kasiaId, 12);
    const items = (await feed(kasia)).body;
    expect(items).toHaveLength(2);

    // The owner cannot mark Kasia's notifications.
    const foreign = await ctx
      .http()
      .post('/v1/me/notifications/read')
      .set(owner.auth)
      .send({ ids: [items[0].id] })
      .expect(200);
    expect(foreign.body).toEqual({ updated: 0 });

    await ctx
      .http()
      .post('/v1/me/notifications/read')
      .set(kasia.auth)
      .send({ ids: [items[0].id] })
      .expect(200);
    const unread = await ctx
      .http()
      .get('/v1/me/notifications')
      .query({ unreadOnly: 'true' })
      .set(kasia.auth)
      .expect(200);
    expect(unread.body.map((n: { id: string }) => n.id)).toEqual([items[1].id]);

    const all = await ctx
      .http()
      .post('/v1/me/notifications/read')
      .set(kasia.auth)
      .send({ all: true })
      .expect(200);
    expect(all.body).toEqual({ updated: 1 });
  });

  it('after leaving the team, its notifications are no longer shown', async () => {
    const kasia = await joinAsStaff('kasia@example.com', kasiaId);
    await bookOnline(kasiaId, 10);
    expect((await feed(kasia)).body).toHaveLength(1);
    await ctx.prisma.membership.deleteMany({ where: { userId: kasia.userId } });
    expect((await feed(kasia)).body).toHaveLength(0);
  });

  describe('push messages to installed apps', () => {
    const KEYS = { p256dh: 'BPublicKeyOfTheDevice_123', auth: 'AuthSecret_456' };
    const device = (name: string) => `https://push.example.com/send/${name}`;
    const subscribe = (user: SignedInUser, endpoint: string) =>
      ctx
        .http()
        .post('/v1/me/push-subscriptions')
        .set(user.auth)
        .send({ endpoint, keys: KEYS })
        .expect(204);
    const deliver = () => ctx.app.get(PushService).deliver();

    it("the staff member's phone gets the online booking, without client contacts", async () => {
      const kasia = await joinAsStaff('kasia@example.com', kasiaId);
      const key = await ctx
        .http()
        .get('/v1/me/push-subscriptions/public-key')
        .set(kasia.auth)
        .expect(200);
      expect(key.body.publicKey).toEqual(expect.any(String));
      await subscribe(kasia, device('kasia-phone'));

      await bookOnline(kasiaId, 10);
      await deliver();

      expect(ctx.push.sent).toHaveLength(1);
      const message = ctx.push.sent[0]!;
      expect(message).toMatchObject({
        endpoint: device('kasia-phone'),
        title: 'Nowa rezerwacja online',
        url: `/pl/app/calendar?date=${day}`,
      });
      expect(message.body).toContain('10:00');
      expect(message.body).toContain('Strzyżenie');
      expect(message.body).toContain('Anna Kowalska');
      expect(JSON.stringify(message)).not.toContain('600100200');
      expect(JSON.stringify(message)).not.toContain('anna@example.com');

      // Pushed once: the next cycle sends nothing; the owner has no device for push.
      await deliver();
      expect(ctx.push.sent).toHaveLength(1);
    });

    it('a device that unsubscribed is forgotten; a temporary failure is retried', async () => {
      const kasia = await joinAsStaff('kasia@example.com', kasiaId);
      await subscribe(kasia, device('old-phone'));
      await subscribe(kasia, device('laptop'));
      ctx.push.gone.add(device('old-phone'));
      ctx.push.failing.add(device('laptop'));

      await bookOnline(kasiaId, 10);
      await deliver();
      expect(ctx.push.sent).toHaveLength(0);
      const left = await ctx.prisma.pushSubscription.findMany({ where: { userId: kasia.userId } });
      expect(left.map((s) => s.endpoint)).toEqual([device('laptop')]);

      ctx.push.failing.clear();
      await deliver();
      expect(ctx.push.sent.map((m) => m.endpoint)).toEqual([device('laptop')]);
    });

    it('gives up after 3 attempts', async () => {
      const kasia = await joinAsStaff('kasia@example.com', kasiaId);
      await subscribe(kasia, device('laptop'));
      ctx.push.failing.add(device('laptop'));
      await bookOnline(kasiaId, 10);
      for (let i = 0; i < 5; i += 1) await deliver();
      const [row] = await ctx.prisma.notification.findMany({ where: { userId: kasia.userId } });
      expect(row).toMatchObject({ pushAttempts: 3, pushedAt: null });
    });

    it('only https push addresses; a device is removed only by its owner', async () => {
      const kasia = await joinAsStaff('kasia@example.com', kasiaId);
      const bad = await ctx
        .http()
        .post('/v1/me/push-subscriptions')
        .set(kasia.auth)
        .send({ endpoint: 'http://push.example.com/x', keys: KEYS })
        .expect(400);
      expectError(bad.body, 'VALIDATION_ERROR');
      await subscribe(kasia, device('kasia-phone'));

      await ctx
        .http()
        .post('/v1/me/push-subscriptions/remove')
        .set(owner.auth)
        .send({ endpoint: device('kasia-phone') })
        .expect(204);
      expect(await ctx.prisma.pushSubscription.count()).toBe(1);

      await ctx
        .http()
        .post('/v1/me/push-subscriptions/remove')
        .set(kasia.auth)
        .send({ endpoint: device('kasia-phone') })
        .expect(204);
      expect(await ctx.prisma.pushSubscription.count()).toBe(0);
    });

    it('no push after leaving the team', async () => {
      const kasia = await joinAsStaff('kasia@example.com', kasiaId);
      await subscribe(kasia, device('kasia-phone'));
      await bookOnline(kasiaId, 10);
      await ctx.prisma.membership.deleteMany({ where: { userId: kasia.userId } });
      await deliver();
      expect(ctx.push.sent).toHaveLength(0);
    });
  });
});
