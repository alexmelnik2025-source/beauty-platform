import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
const customers = () => `/v1/organizations/${orgId}/customers`;

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

const book = (staffId: string, hh: number, customer: object) =>
  ctx
    .http()
    .post(`${base}/appointments`)
    .set(owner.auth)
    .send({ serviceId, staffId, start: at(hh), ...customer });

describe('service categories and colours', () => {
  it('groups the price list; deleting a category keeps its services', async () => {
    const hair = await ctx
      .http()
      .post(`${base}/service-categories`)
      .set(owner.auth)
      .send({ name: 'Włosy', sortOrder: 1 })
      .expect(201);
    const beard = await ctx
      .http()
      .post(`${base}/service-categories`)
      .set(owner.auth)
      .send({ name: 'Broda', sortOrder: 2 })
      .expect(201);
    expectError(
      (
        await ctx
          .http()
          .post(`${base}/service-categories`)
          .set(owner.auth)
          .send({ name: 'Włosy' })
          .expect(409)
      ).body,
      'CATEGORY_NAME_TAKEN',
    );
    await ctx
      .http()
      .patch(`${base}/services/${serviceId}`)
      .set(owner.auth)
      .send({ version: 1, categoryId: hair.body.id, color: '#3366FF' })
      .expect(200);
    await ctx
      .http()
      .patch(`${base}/services/${serviceId}`)
      .set(owner.auth)
      .send({ version: 2, color: 'blue' })
      .expect(400);

    const list = await ctx.http().get(`${base}/service-categories`).set(owner.auth).expect(200);
    expect(list.body.map((c: { name: string }) => c.name)).toEqual(['Włosy', 'Broda']);

    const loc = await ctx.http().get(base).set(owner.auth).expect(200);
    await ctx
      .http()
      .patch(base)
      .set(owner.auth)
      .send({ version: loc.body.version, onlineBookingEnabled: true })
      .expect(200);
    const page = await ctx.http().get(`/v1/public/locations/${slug}`).expect(200);
    // Only categories that contain a bookable service are shown.
    expect(page.body.categories).toEqual([{ id: hair.body.id, name: 'Włosy' }]);
    expect(page.body.services[0]).toMatchObject({ id: serviceId, categoryId: hair.body.id });
    expect(page.body.services[0]).not.toHaveProperty('color');

    await ctx
      .http()
      .delete(`${base}/service-categories/${hair.body.id}`)
      .set(owner.auth)
      .expect(204);
    const service = await ctx
      .http()
      .get(`${base}/services/${serviceId}`)
      .set(owner.auth)
      .expect(200);
    expect(service.body).toMatchObject({ categoryId: null, color: '#3366FF', active: true });
    expect(beard.body.id).toBeTruthy();
  });

  it('only owners and managers change categories', async () => {
    const kasia = await signUp(ctx, 'kasia@example.com');
    await ctx.prisma.membership.create({
      data: {
        userId: kasia.userId,
        organizationId: orgId,
        role: 'staff',
        locations: { create: [{ locationId }] },
      },
    });
    await ctx.http().get(`${base}/service-categories`).set(kasia.auth).expect(200);
    await ctx
      .http()
      .post(`${base}/service-categories`)
      .set(kasia.auth)
      .send({ name: 'X' })
      .expect(403);
  });
});

describe('client card', () => {
  const add = (body: object) => ctx.http().post(customers()).set(owner.auth).send(body);

  it('adds a client, refusing duplicates by email and (unless allowed) by phone', async () => {
    const anna = await add({
      name: 'Anna Nowak',
      phone: '+48 600 100 200',
      email: 'Anna@Example.com',
      note: 'Krótko po bokach',
      tags: ['stała', 'stała', 'broda'],
    }).expect(201);
    expect(anna.body).toMatchObject({
      phone: '+48600100200',
      email: 'anna@example.com',
      tags: ['stała', 'broda'],
      visits: [],
    });

    const sameEmail = await add({
      name: 'A',
      phone: '+48600999999',
      email: 'anna@example.com',
    }).expect(409);
    expectError(sameEmail.body, 'CUSTOMER_EMAIL_EXISTS');
    expect(sameEmail.body.error.details).toEqual([{ path: 'customerId', message: anna.body.id }]);

    expectError(
      (await add({ name: 'B', phone: '+48600100200' }).expect(409)).body,
      'CUSTOMER_PHONE_EXISTS',
    );
    await add({ name: 'B', phone: '+48600100200', allowDuplicatePhone: true }).expect(201);

    const found = await ctx
      .http()
      .get(customers())
      .query({ search: 'broda' })
      .set(owner.auth)
      .expect(200);
    expect(found.body.map((c: { id: string }) => c.id)).toEqual([anna.body.id]);
  });

  it('edits with the version it read', async () => {
    const anna = await add({ name: 'Anna', phone: '+48600100200' }).expect(201);
    const url = `${customers()}/${anna.body.id}`;
    const edited = await ctx
      .http()
      .patch(url)
      .set(owner.auth)
      .send({ version: 1, note: 'Alergia na lateks', tags: ['VIP'] })
      .expect(200);
    expect(edited.body).toMatchObject({ note: 'Alergia na lateks', tags: ['VIP'], version: 2 });
    expectError(
      (await ctx.http().patch(url).set(owner.auth).send({ version: 1, name: 'X' }).expect(409))
        .body,
      'VERSION_CONFLICT',
    );
  });

  describe('as a staff member', () => {
    let kasia: SignedInUser;
    let membershipId: string;
    let annaId: string;
    let piotrId: string;

    beforeEach(async () => {
      kasia = await signUp(ctx, 'kasia@example.com');
      membershipId = (
        await ctx.prisma.membership.create({
          data: {
            userId: kasia.userId,
            organizationId: orgId,
            role: 'staff',
            locations: { create: [{ locationId }] },
          },
        })
      ).id;
      await ctx.prisma.staffMember.update({
        where: { id: kasiaId },
        data: { userId: kasia.userId },
      });
      annaId = (await add({ name: 'Anna', phone: '+48600100200', note: 'Krótko' }).expect(201)).body
        .id;
      piotrId = (await add({ name: 'Piotr', phone: '+48600100300' }).expect(201)).body.id;
      await book(kasiaId, 10, { customerId: annaId }).expect(201);
      await book(olaId, 12, { customerId: annaId }).expect(201);
      await book(olaId, 14, { customerId: piotrId }).expect(201);
    });

    const grant = (overrides: object) =>
      ctx
        .http()
        .put(`/v1/organizations/${orgId}/members/${membershipId}/permissions`)
        .set(owner.auth)
        .send({ version: 1, staffCategoryId: null, overrides })
        .expect(200);

    it('by default: name and own visits only; no contacts, notes, list or other clients', async () => {
      const card = await ctx.http().get(`${customers()}/${annaId}`).set(kasia.auth).expect(200);
      expect(card.body).toMatchObject({
        name: 'Anna',
        phone: null,
        email: null,
        note: null,
        tags: null,
        marketingConsent: null,
      });
      expect(card.body.visits).toHaveLength(1);
      await ctx.http().get(`${customers()}/${piotrId}`).set(kasia.auth).expect(404);
      await ctx.http().get(customers()).set(kasia.auth).expect(403);
      await ctx
        .http()
        .patch(`${customers()}/${annaId}`)
        .set(kasia.auth)
        .send({ version: 1, note: 'x' })
        .expect(403);
    });

    it('with permissions: contacts, full history, notes; may edit only note and tags', async () => {
      await grant({
        viewClientContacts: true,
        viewClientHistory: true,
        viewClientNotes: true,
        editClientNotes: true,
      });
      const card = await ctx.http().get(`${customers()}/${annaId}`).set(kasia.auth).expect(200);
      expect(card.body).toMatchObject({ phone: '+48600100200', note: 'Krótko' });
      expect(card.body.visits).toHaveLength(2);
      await ctx
        .http()
        .patch(`${customers()}/${annaId}`)
        .set(kasia.auth)
        .send({ version: 1, note: 'Krótko, bez maszynki', tags: ['stała'] })
        .expect(200);
      await ctx
        .http()
        .patch(`${customers()}/${annaId}`)
        .set(kasia.auth)
        .send({ version: 2, name: 'Zmieniona' })
        .expect(403);
    });
  });
});

describe('marks on appointments', () => {
  it('first visit, and whether the client chose the staff member', async () => {
    const loc = await ctx.http().get(base).set(owner.auth).expect(200);
    await ctx
      .http()
      .patch(base)
      .set(owner.auth)
      .send({ version: loc.body.version, onlineBookingEnabled: true })
      .expect(200);
    const chosen = await ctx
      .http()
      .post(`/v1/public/locations/${slug}/holds`)
      .send({ serviceId, staffId: kasiaId, start: at(10) })
      .expect(201);
    const any = await ctx
      .http()
      .post(`/v1/public/locations/${slug}/holds`)
      .send({ serviceId, start: at(12) })
      .expect(201);
    const rows = await ctx.prisma.appointment.findMany({ orderBy: { startAt: 'asc' } });
    expect(rows.map((r) => [r.id, r.staffChosenByClient])).toEqual([
      [chosen.body.holdId, true],
      [any.body.holdId, false],
    ]);

    const anna = await ctx
      .http()
      .post(customers())
      .set(owner.auth)
      .send({ name: 'Anna', phone: '+48600100200' })
      .expect(201);
    const first = await book(olaId, 15, { customerId: anna.body.id }).expect(201);
    expect(first.body).toMatchObject({ firstVisit: true, staffChosenByClient: false });

    // Anna came once in the past.
    await ctx.prisma.appointment.update({
      where: { id: first.body.id },
      data: {
        status: 'completed',
        startAt: new Date(Date.now() - 7 * 86_400_000),
        endAt: new Date(Date.now() - 7 * 86_400_000 + 45 * 60_000),
        blockedUntil: new Date(Date.now() - 7 * 86_400_000 + 45 * 60_000),
      },
    });
    const second = await book(olaId, 16, { customerId: anna.body.id }).expect(201);
    expect(second.body.firstVisit).toBe(false);
  });
});
