import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildOpenApiDocument, registeredResponseSchema } from '../src/common/openapi';
import { addDays, localToday, zonedToInstant } from '../src/scheduling/time';
import {
  codeFromEmail,
  createOrgWithLocation,
  createTestApp,
  PASSWORD,
  resetState,
  signUp,
  type TestContext,
} from './helpers';

/**
 * The OpenAPI document is saved in packages/api-client, and the typed client is generated
 * from it. When the API changes, refresh it:
 *   OPENAPI_WRITE=1 pnpm --filter @beauty/api exec vitest run test/openapi.spec.ts
 *   pnpm --filter @beauty/api-client generate
 */
const SAVED = resolve(__dirname, '../../../packages/api-client/openapi.json');
const TZ = 'Europe/Warsaw';
const ANNA = 'anna.client@example.com';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestApp();
});

afterAll(async () => {
  await ctx.app.close();
});

/** Fails when a response has a field the schema does not describe, or lacks one it does. */
function expectShape(name: string, body: unknown): void {
  const result = registeredResponseSchema(name).safeParse(body);
  expect(result.error?.issues ?? [], `response does not match ${name}`).toEqual([]);
}

function refsIn(value: unknown, found: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) refsIn(item, found);
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (key === '$ref' && typeof item === 'string') found.push(item);
      else refsIn(item, found);
    }
  }
  return found;
}

describe('OpenAPI document', () => {
  it('is the one saved in packages/api-client (the typed client is generated from it)', () => {
    const text = `${JSON.stringify(buildOpenApiDocument(ctx.app), null, 2)}\n`;
    if (process.env.OPENAPI_WRITE === '1') writeFileSync(SAVED, text);
    expect(
      readFileSync(SAVED, 'utf8') === text,
      'packages/api-client/openapi.json is out of date: see the comment at the top of this test',
    ).toBe(true);
  });

  it('every schema reference points to a described schema', () => {
    const document = buildOpenApiDocument(ctx.app);
    const names = Object.keys(document.components?.schemas ?? {});
    const refs = refsIn(document.paths);
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      expect(names).toContain(ref.replace('#/components/schemas/', ''));
    }
  });

  it('serves the same document at /v1/docs-json', async () => {
    const res = await ctx.http().get('/v1/docs-json').expect(200);
    expect(res.body).toEqual(JSON.parse(readFileSync(SAVED, 'utf8')));
  });
});

describe('client-facing responses match the documented shapes exactly', () => {
  let slug: string;
  let serviceId: string;
  let staffId: string;

  beforeEach(async () => {
    await resetState(ctx);
    const owner = await signUp(ctx, 'owner@example.com');
    const org = await createOrgWithLocation(ctx, owner, 'Barber One');
    slug = org.slug;
    const base = `/v1/organizations/${org.orgId}/locations/${org.locationId}`;
    const service = await ctx
      .http()
      .post(`${base}/services`)
      .set(owner.auth)
      .send({ name: 'Strzyżenie', durationMinutes: 45, bufferMinutes: 15, priceGrosze: 8000 })
      .expect(201);
    serviceId = service.body.id;
    const staff = await ctx
      .http()
      .post(`${base}/staff`)
      .set(owner.auth)
      .send({ displayName: 'Kasia', serviceIds: [serviceId] })
      .expect(201);
    staffId = staff.body.id;
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
    const loc = await ctx.http().get(base).set(owner.auth).expect(200);
    await ctx
      .http()
      .patch(base)
      .set(owner.auth)
      .send({ version: loc.body.version, onlineBookingEnabled: true })
      .expect(200);
  });

  function lastCode(email: string): string {
    const match = ctx.mail.lastTo(email)?.text.match(/\b(\d{6})\b/);
    if (!match?.[1]) throw new Error(`no code sent to ${email}`);
    return match[1];
  }

  it('booking page, booking steps, manage link and "My visits"', async () => {
    const page = await ctx.http().get(`/v1/public/locations/${slug}`).expect(200);
    expectShape('PublicLocation', page.body);

    const day = addDays(localToday(Date.now(), TZ), 3);
    const availability = await ctx
      .http()
      .get(`/v1/public/locations/${slug}/availability`)
      .query({ serviceId, from: day, to: day })
      .expect(200);
    expectShape('Availability', availability.body);
    expect(availability.body.slots.length).toBeGreaterThan(0);
    expectShape('Slot', availability.body.slots[0]);

    const start = new Date(zonedToInstant(day, 10 * 60, TZ)).toISOString();
    const hold = await ctx
      .http()
      .post(`/v1/public/locations/${slug}/holds`)
      .send({ serviceId, staffId, start })
      .expect(201);
    expectShape('Hold', hold.body);

    const code = await ctx
      .http()
      .post(`/v1/public/holds/${hold.body.holdId}/code`)
      .send({
        holdToken: hold.body.holdToken,
        name: 'Anna Kowalska',
        phone: '+48600100200',
        email: ANNA,
        locale: 'pl',
        acceptTerms: true,
      })
      .expect(202);
    expectShape('CodeSent', code.body);

    const confirmed = await ctx
      .http()
      .post(`/v1/public/holds/${hold.body.holdId}/confirm`)
      .send({ holdToken: hold.body.holdToken, code: lastCode(ANNA) })
      .expect(200);
    expectShape('BookingConfirmed', confirmed.body);

    const managed = await ctx
      .http()
      .get(`/v1/public/appointments/${confirmed.body.manageToken}`)
      .expect(200);
    expectShape('PublicAppointment', managed.body);

    const sent = await ctx
      .http()
      .post('/v1/client/auth/code')
      .send({ email: ANNA, locale: 'pl' })
      .expect(202);
    expectShape('ClientCodeSent', sent.body);
    const signedIn = await ctx
      .http()
      .post('/v1/client/auth/verify')
      .send({ email: ANNA, code: lastCode(ANNA), clientType: 'mobile' })
      .expect(200);
    expectShape('ClientSignIn', signedIn.body);
    const auth = { Authorization: `Bearer ${signedIn.body.token}` };

    const me = await ctx.http().get('/v1/client/me').set(auth).expect(200);
    expectShape('ClientPerson', me.body);
    const list = await ctx.http().get('/v1/client/appointments').set(auth).expect(200);
    expectShape('ClientAppointmentList', list.body);
    expect(list.body.items).toHaveLength(1);
    const one = await ctx
      .http()
      .get(`/v1/client/appointments/${confirmed.body.appointment.id}`)
      .set(auth)
      .expect(200);
    expectShape('ClientAppointment', one.body);
    expect(one.body.bookAgain).toEqual({ slug, serviceId, staffId });
  });

  it('a schema with an extra field would fail: shapes are strict', () => {
    expect(
      registeredResponseSchema('ClientPerson').safeParse({
        id: 'x',
        email: ANNA,
        locale: 'pl',
        phone: '+48600100200',
      }).success,
    ).toBe(false);
  });
});

describe('salon account and catalogue responses match the documented shapes exactly', () => {
  beforeEach(async () => {
    await resetState(ctx);
  });

  it('sign-in, me, organizations, locations, services, staff, hours, time off', async () => {
    const email = 'owner@example.com';
    const registered = await ctx
      .http()
      .post('/v1/auth/register')
      .send({ email, password: PASSWORD, name: 'Owner' })
      .expect(202);
    expectShape('Message', registered.body);
    const verified = await ctx
      .http()
      .post('/v1/auth/verify-email')
      .send({ token: codeFromEmail(ctx, email) })
      .expect(200);
    expectShape('Message', verified.body);

    const web = await ctx.http().post('/v1/auth/login').send({ email, password: PASSWORD });
    expect(web.status).toBe(200);
    expectShape('Tokens', web.body);
    expect(web.body.refreshToken).toBeUndefined();
    const mobile = await ctx
      .http()
      .post('/v1/auth/login')
      .send({ email, password: PASSWORD, clientType: 'mobile' })
      .expect(200);
    expectShape('Tokens', mobile.body);
    const refreshed = await ctx
      .http()
      .post('/v1/auth/refresh')
      .send({ refreshToken: mobile.body.refreshToken })
      .expect(200);
    expectShape('Tokens', refreshed.body);
    expect(refreshed.body.refreshToken).toEqual(expect.any(String));
    const auth = { Authorization: `Bearer ${web.body.accessToken}` };

    const org = await ctx
      .http()
      .post('/v1/organizations')
      .set(auth)
      .send({ name: 'Barber One' })
      .expect(201);
    expectShape('Organization', org.body);
    const orgs = await ctx.http().get('/v1/organizations').set(auth).expect(200);
    expectShape('OrganizationList', orgs.body);
    expectShape(
      'Organization',
      (await ctx.http().get(`/v1/organizations/${org.body.id}`).set(auth).expect(200)).body,
    );

    const me = await ctx.http().get('/v1/me').set(auth).expect(200);
    expectShape('Me', me.body);
    expect(me.body.organizations).toHaveLength(1);
    const sessions = await ctx.http().get('/v1/me/sessions').set(auth).expect(200);
    expectShape('SessionList', sessions.body);
    expect(sessions.body.length).toBeGreaterThan(0);

    const location = await ctx
      .http()
      .post(`/v1/organizations/${org.body.id}/locations`)
      .set(auth)
      .send({
        name: 'Barber One Centrum',
        addressLine: 'ul. Puławska 1',
        city: 'Warszawa',
        postalCode: '02-515',
      })
      .expect(201);
    expectShape('Location', location.body);
    const base = `/v1/organizations/${org.body.id}/locations/${location.body.id}`;
    expectShape(
      'LocationList',
      (await ctx.http().get(`/v1/organizations/${org.body.id}/locations`).set(auth).expect(200))
        .body,
    );
    const updated = await ctx
      .http()
      .patch(base)
      .set(auth)
      .send({ version: location.body.version, languages: ['pl', 'uk'], description: 'Barber' })
      .expect(200);
    expectShape('Location', updated.body);

    const category = await ctx
      .http()
      .post(`${base}/service-categories`)
      .set(auth)
      .send({ name: 'Włosy', sortOrder: 1 })
      .expect(201);
    expectShape('ServiceCategory', category.body);
    expectShape(
      'ServiceCategoryList',
      (await ctx.http().get(`${base}/service-categories`).set(auth).expect(200)).body,
    );

    const service = await ctx
      .http()
      .post(`${base}/services`)
      .set(auth)
      .send({
        name: 'Strzyżenie',
        durationMinutes: 45,
        priceGrosze: 8000,
        categoryId: category.body.id,
        color: '#AA3300',
      })
      .expect(201);
    expectShape('Service', service.body);
    expectShape('ServiceList', (await ctx.http().get(`${base}/services`).set(auth)).body);
    expectShape(
      'Service',
      (await ctx.http().get(`${base}/services/${service.body.id}`).set(auth).expect(200)).body,
    );

    const staff = await ctx
      .http()
      .post(`${base}/staff`)
      .set(auth)
      .send({ displayName: 'Kasia', serviceIds: [service.body.id] })
      .expect(201);
    expectShape('Staff', staff.body);
    const staffBase = `${base}/staff/${staff.body.id}`;
    expectShape('StaffList', (await ctx.http().get(`${base}/staff`).set(auth).expect(200)).body);
    expectShape('Staff', (await ctx.http().get(staffBase).set(auth).expect(200)).body);

    const hours = await ctx
      .http()
      .put(`${staffBase}/working-hours`)
      .set(auth)
      .send({
        days: [1, 2, 3, 4, 5].map((weekday) => ({
          weekday,
          intervals: [{ start: '09:00', end: '18:00' }],
        })),
      })
      .expect(200);
    expectShape('WorkingHours', hours.body);
    const day = addDays(localToday(Date.now(), TZ), 10);
    const special = await ctx
      .http()
      .put(`${staffBase}/working-hours/overrides/${day}`)
      .set(auth)
      .send({ intervals: [{ start: '10:00', end: '14:00' }] })
      .expect(200);
    expectShape('WorkingHours', special.body);
    expect(special.body.overrides).toHaveLength(1);

    const timeOff = await ctx
      .http()
      .post(`${staffBase}/time-off`)
      .set(auth)
      .send({ start: `${day}T10:00`, end: `${day}T11:00`, note: 'Lekarz' })
      .expect(201);
    expectShape('TimeOff', timeOff.body);
    expectShape(
      'TimeOffList',
      (await ctx.http().get(`${staffBase}/time-off`).set(auth).expect(200)).body,
    );

    const free = await ctx
      .http()
      .get(`${base}/availability`)
      .set(auth)
      .query({ serviceId: service.body.id, from: day, to: day })
      .expect(200);
    expectShape('Availability', free.body);
  });
});

describe('appointments, clients, time blocks and calendar match the documented shapes exactly', () => {
  beforeEach(async () => {
    await resetState(ctx);
  });

  it('book for a client, move, mark, cancel; client cards; blocks; calendar', async () => {
    const owner = await signUp(ctx, 'owner@example.com');
    const org = await createOrgWithLocation(ctx, owner, 'Barber One');
    const base = `/v1/organizations/${org.orgId}/locations/${org.locationId}`;
    const service = await ctx
      .http()
      .post(`${base}/services`)
      .set(owner.auth)
      .send({ name: 'Strzyżenie', durationMinutes: 45, bufferMinutes: 15, priceGrosze: 8000 })
      .expect(201);
    const staff = await ctx
      .http()
      .post(`${base}/staff`)
      .set(owner.auth)
      .send({ displayName: 'Kasia', serviceIds: [service.body.id] })
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
    const day = addDays(localToday(Date.now(), TZ), 3);
    const at = (minutes: number) => new Date(zonedToInstant(day, minutes, TZ)).toISOString();

    const customers = `/v1/organizations/${org.orgId}/customers`;
    const customer = await ctx
      .http()
      .post(customers)
      .set(owner.auth)
      .send({ name: 'Anna Kowalska', phone: '+48600100200', email: ANNA, tags: ['VIP'] })
      .expect(201);
    expectShape('CustomerDetail', customer.body);
    expectShape('CustomerList', (await ctx.http().get(customers).set(owner.auth).expect(200)).body);
    const edited = await ctx
      .http()
      .patch(`${customers}/${customer.body.id}`)
      .set(owner.auth)
      .send({ version: customer.body.version, note: 'Krótko po bokach' })
      .expect(200);
    expectShape('CustomerDetail', edited.body);

    const booked = await ctx
      .http()
      .post(`${base}/appointments`)
      .set(owner.auth)
      .send({
        serviceId: service.body.id,
        staffId: staff.body.id,
        start: at(10 * 60),
        customerId: customer.body.id,
        note: 'Telefon',
      })
      .expect(201);
    expectShape('AppointmentDetail', booked.body);
    expect(booked.body.history.length).toBeGreaterThan(0);
    const walkIn = await ctx
      .http()
      .post(`${base}/appointments`)
      .set(owner.auth)
      .send({
        serviceId: service.body.id,
        staffId: staff.body.id,
        start: at(14 * 60),
        customer: { name: 'Jan Nowak', phone: '+48600100300' },
      })
      .expect(201);
    expectShape('AppointmentDetail', walkIn.body);

    const moved = await ctx
      .http()
      .post(`${base}/appointments/${booked.body.id}/reschedule`)
      .set(owner.auth)
      .send({ version: booked.body.version, start: at(11 * 60) })
      .expect(200);
    expectShape('AppointmentDetail', moved.body);
    const cancelled = await ctx
      .http()
      .post(`${base}/appointments/${walkIn.body.id}/cancel`)
      .set(owner.auth)
      .send({ version: walkIn.body.version, reason: 'Klient zadzwonił' })
      .expect(200);
    expectShape('AppointmentDetail', cancelled.body);
    expect(cancelled.body.cancelledBy).toBe('salon');

    // "Came" can only be marked once the visit has started: move it into the past directly.
    const hourAgo = new Date(Date.now() - 60 * 60_000);
    await ctx.prisma.appointment.update({
      where: { id: booked.body.id },
      data: {
        startAt: hourAgo,
        endAt: new Date(hourAgo.getTime() + 45 * 60_000),
        blockedUntil: new Date(hourAgo.getTime() + 60 * 60_000),
      },
    });
    const came = await ctx
      .http()
      .post(`${base}/appointments/${booked.body.id}/status`)
      .set(owner.auth)
      .send({ version: moved.body.version, status: 'completed' })
      .expect(200);
    expectShape('AppointmentDetail', came.body);
    expectShape(
      'AppointmentDetail',
      (await ctx.http().get(`${base}/appointments/${booked.body.id}`).set(owner.auth).expect(200))
        .body,
    );
    expectShape(
      'CustomerDetail',
      (await ctx.http().get(`${customers}/${customer.body.id}`).set(owner.auth).expect(200)).body,
    );

    const block = await ctx
      .http()
      .post(`${base}/time-blocks`)
      .set(owner.auth)
      .send({ staffId: null, start: at(16 * 60), end: at(17 * 60), reason: 'Szkolenie' })
      .expect(201);
    expectShape('TimeBlock', block.body);
    const blockMoved = await ctx
      .http()
      .patch(`${base}/time-blocks/${block.body.id}`)
      .set(owner.auth)
      .send({ version: block.body.version, staffId: staff.body.id })
      .expect(200);
    expectShape('TimeBlock', blockMoved.body);

    const range = { from: day, to: day };
    const list = await ctx
      .http()
      .get(`${base}/appointments`)
      .set(owner.auth)
      .query(range)
      .expect(200);
    expectShape('AppointmentList', list.body);
    expect(list.body.length).toBeGreaterThan(0);
    const blocks = await ctx
      .http()
      .get(`${base}/time-blocks`)
      .set(owner.auth)
      .query(range)
      .expect(200);
    expectShape('TimeBlockList', blocks.body);
    expect(blocks.body).toHaveLength(1);
    const calendar = await ctx
      .http()
      .get(`${base}/calendar`)
      .set(owner.auth)
      .query(range)
      .expect(200);
    expectShape('Calendar', calendar.body);
    expect(calendar.body.appointments.length).toBeGreaterThan(0);
    expect(calendar.body.blocks).toHaveLength(1);
  });
});

describe('team, permissions and invitations match the documented shapes exactly', () => {
  beforeEach(async () => {
    await resetState(ctx);
  });

  it('permissions, staff categories, invitations, joining, members', async () => {
    const owner = await signUp(ctx, 'owner@example.com');
    const org = await createOrgWithLocation(ctx, owner, 'Barber One');
    const orgBase = `/v1/organizations/${org.orgId}`;

    expectShape(
      'PermissionCatalog',
      (await ctx.http().get(`${orgBase}/permissions`).set(owner.auth).expect(200)).body,
    );

    const category = await ctx
      .http()
      .post(`${orgBase}/staff-categories`)
      .set(owner.auth)
      .send({ name: 'Senior barber', permissions: { viewClientContacts: true } })
      .expect(201);
    expectShape('StaffCategory', category.body);
    expectShape(
      'StaffCategory',
      (
        await ctx
          .http()
          .patch(`${orgBase}/staff-categories/${category.body.id}`)
          .set(owner.auth)
          .send({ version: category.body.version, name: 'Senior' })
          .expect(200)
      ).body,
    );

    const invitation = await ctx
      .http()
      .post(`${orgBase}/invitations`)
      .set(owner.auth)
      .send({
        email: 'kasia@example.com',
        role: 'staff',
        locationIds: [org.locationId],
        staffCategoryId: category.body.id,
      })
      .expect(201);
    expectShape('Invitation', invitation.body);
    expectShape(
      'InvitationList',
      (await ctx.http().get(`${orgBase}/invitations`).set(owner.auth).expect(200)).body,
    );

    const token = ctx.mail.lastTo('kasia@example.com')?.text.match(/\/invite\/(\S+)/)?.[1];
    expect(token).toBeTruthy();
    expectShape(
      'InvitationPreview',
      (await ctx.http().get(`/v1/invitations/${token}`).expect(200)).body,
    );
    const kasia = await signUp(ctx, 'kasia@example.com', 'Kasia');
    const joined = await ctx
      .http()
      .post(`/v1/invitations/${token}/accept`)
      .set(kasia.auth)
      .expect(200);
    expectShape('InvitationAccepted', joined.body);

    // A staff member sees their own effective permissions (the web app hides what they may not do).
    const mine = await ctx.http().get(`${orgBase}/permissions`).set(kasia.auth).expect(200);
    expectShape('PermissionCatalog', mine.body);
    expect(mine.body.me.permissions.viewClientContacts).toBe(true);

    expectShape(
      'StaffCategoryList',
      (await ctx.http().get(`${orgBase}/staff-categories`).set(owner.auth).expect(200)).body,
    );
    const members = await ctx.http().get(`${orgBase}/members`).set(owner.auth).expect(200);
    expectShape('MemberList', members.body);
    const member = members.body.find(
      (row: { user: { email: string } }) => row.user.email === 'kasia@example.com',
    );
    const updated = await ctx
      .http()
      .put(`${orgBase}/members/${member.membershipId}/permissions`)
      .set(owner.auth)
      .send({ version: member.version, staffCategoryId: null, overrides: { blockOwnTime: true } })
      .expect(200);
    expectShape('Member', updated.body);
    expect(updated.body.overrides).toEqual({ blockOwnTime: true });
  });
});

describe('notifications, push, photos, email queue and health match the documented shapes', () => {
  beforeEach(async () => {
    await resetState(ctx);
  });

  it('the bell, the push key, salon and staff photos, failed emails, health', async () => {
    const owner = await signUp(ctx, 'owner@example.com');
    const org = await createOrgWithLocation(ctx, owner, 'Barber One');
    const base = `/v1/organizations/${org.orgId}/locations/${org.locationId}`;
    const service = await ctx
      .http()
      .post(`${base}/services`)
      .set(owner.auth)
      .send({ name: 'Strzyżenie', durationMinutes: 30, priceGrosze: 8000 })
      .expect(201);
    const staff = await ctx
      .http()
      .post(`${base}/staff`)
      .set(owner.auth)
      .send({ displayName: 'Kasia', serviceIds: [service.body.id] })
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

    // Kasia joins the team, then the salon books a client into her calendar.
    await ctx
      .http()
      .post(`/v1/organizations/${org.orgId}/invitations`)
      .set(owner.auth)
      .send({
        email: 'kasia@example.com',
        role: 'staff',
        locationIds: [org.locationId],
        staffMemberId: staff.body.id,
      })
      .expect(201);
    const token = ctx.mail.lastTo('kasia@example.com')?.text.match(/\/invite\/(\S+)/)?.[1];
    const kasia = await signUp(ctx, 'kasia@example.com', 'Kasia');
    await ctx.http().post(`/v1/invitations/${token}/accept`).set(kasia.auth).expect(200);
    const day = addDays(localToday(Date.now(), TZ), 3);
    await ctx
      .http()
      .post(`${base}/appointments`)
      .set(owner.auth)
      .send({
        serviceId: service.body.id,
        staffId: staff.body.id,
        start: new Date(zonedToInstant(day, 11 * 60, TZ)).toISOString(),
        customer: { name: 'Jan', phone: '+48600000001' },
      })
      .expect(201);

    const feed = await ctx.http().get('/v1/me/notifications').set(kasia.auth).expect(200);
    expectShape('NotificationList', feed.body);
    expect(feed.body).toHaveLength(1);
    expectShape(
      'UnreadCount',
      (await ctx.http().get('/v1/me/notifications/unread-count').set(kasia.auth).expect(200)).body,
    );
    expectShape(
      'NotificationsMarked',
      (
        await ctx
          .http()
          .post('/v1/me/notifications/read')
          .set(kasia.auth)
          .send({ all: true })
          .expect(200)
      ).body,
    );
    expectShape(
      'PushPublicKey',
      (await ctx.http().get('/v1/me/push-subscriptions/public-key').set(kasia.auth).expect(200))
        .body,
    );

    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from('png-body'),
    ]);
    const photo = await ctx
      .http()
      .post(`${base}/photos`)
      .set(owner.auth)
      .set('Content-Type', 'image/png')
      .send(png)
      .expect(201);
    expectShape('Photo', photo.body);
    expectShape(
      'PhotoList',
      (await ctx.http().get(`${base}/photos`).set(owner.auth).expect(200)).body,
    );
    expectShape(
      'Photo',
      (
        await ctx
          .http()
          .put(`${base}/staff/${staff.body.id}/photo`)
          .set(owner.auth)
          .set('Content-Type', 'image/png')
          .send(png)
          .expect(200)
      ).body,
    );

    // The email queue, as a platform administrator sees it.
    const admin = await signUp(ctx, 'admin@example.com');
    await ctx.prisma.notificationOutbox.create({
      data: {
        type: 'client_confirmation',
        payload: {},
        status: 'failed',
        attempts: 5,
        lastError: 'Mailbox ***@*** rejected the message',
        dedupeKey: 'openapi-test-failed-email',
      },
    });
    expectShape(
      'OutboxStats',
      (await ctx.http().get('/v1/admin/outbox').set(admin.auth).expect(200)).body,
    );
    const failed = await ctx.http().get('/v1/admin/outbox/failed').set(admin.auth).expect(200);
    expectShape('FailedEmailList', failed.body);
    expect(failed.body).toHaveLength(1);
    expectShape(
      'EmailsRequeued',
      (
        await ctx
          .http()
          .post('/v1/admin/outbox/retry')
          .set(admin.auth)
          .send({ all: true })
          .expect(200)
      ).body,
    );

    expectShape('Health', (await ctx.http().get('/v1/health').expect(200)).body);
  });
});
