import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { csvCell } from '../src/booking/customers-export';
import { addDays, localToday, zonedToInstant } from '../src/scheduling/time';
import {
  createOrgWithLocation,
  createTestApp,
  resetState,
  signUp,
  type SignedInUser,
  type TestContext,
} from './helpers';

/** Task 21: the owner downloads all clients as a CSV file. */

const TZ = 'Europe/Warsaw';

let ctx: TestContext;
let owner: SignedInUser;
let orgId: string;
let base: string;

beforeAll(async () => {
  ctx = await createTestApp();
});

afterAll(async () => {
  await ctx.app.close();
});

beforeEach(async () => {
  await resetState(ctx);
  owner = await signUp(ctx, 'owner@example.com');
  const created = await createOrgWithLocation(ctx, owner, 'Barber');
  orgId = created.orgId;
  base = `/v1/organizations/${orgId}/locations/${created.locationId}`;
});

const exportUrl = () => `/v1/organizations/${orgId}/customers/export.csv`;

/** Splits the file into rows of cells (cells never contain ";" or new lines in these tests). */
function rows(text: string): string[][] {
  return text
    .replace(/^\uFEFF/, '')
    .trimEnd()
    .split('\r\n')
    .map((line) => line.split(';').map((c) => c.slice(1, -1).replace(/""/g, '"')));
}

async function addMember(email: string, role: 'manager' | 'staff'): Promise<SignedInUser> {
  const user = await signUp(ctx, email);
  const location = await ctx.prisma.location.findFirstOrThrow({ where: { organizationId: orgId } });
  await ctx.prisma.membership.create({
    data: {
      userId: user.userId,
      organizationId: orgId,
      role,
      locations: { create: [{ locationId: location.id }] },
    },
  });
  return user;
}

describe('clients CSV export', () => {
  it('quotes every cell and never lets a spreadsheet run a formula', () => {
    expect(csvCell('Anna "Ania" Nowak')).toBe('"Anna ""Ania"" Nowak"');
    expect(csvCell('=HYPERLINK("x")')).toBe('"\'=HYPERLINK(""x"")"');
    expect(csvCell('-2+3')).toBe('"\'-2+3"');
    expect(csvCell('@SUM(A1)')).toBe('"\'@SUM(A1)"');
    expect(csvCell('+48600100200')).toBe('"+48600100200"');
    expect(csvCell('+48600100200+1')).toBe('"\'+48600100200+1"');
  });

  it('all clients with contacts, consent, completed visits and the last one', async () => {
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

    // Booked online-like by the salon: a completed visit two days ago.
    const start = new Date(zonedToInstant(addDays(localToday(Date.now(), TZ), 2), 10 * 60, TZ));
    const booked = await ctx
      .http()
      .post(`${base}/appointments`)
      .set(owner.auth)
      .send({
        serviceId: service.body.id,
        staffId: staff.body.id,
        start: start.toISOString(),
        allowOutsideHours: true,
        customer: { name: 'Żaneta Łącka', phone: '+48600000002', email: 'zaneta@example.com' },
      })
      .expect(201);
    const lastDay = addDays(localToday(Date.now(), TZ), -2);
    const past = new Date(zonedToInstant(lastDay, 10 * 60, TZ));
    await ctx.prisma.appointment.update({
      where: { id: booked.body.id },
      data: {
        startAt: past,
        endAt: new Date(past.getTime() + 30 * 60_000),
        blockedUntil: new Date(past.getTime() + 30 * 60_000),
      },
    });
    await ctx
      .http()
      .post(`${base}/appointments/${booked.body.id}/status`)
      .set(owner.auth)
      .send({ version: booked.body.version, status: 'completed' })
      .expect(200);
    const zaneta = await ctx.prisma.customer.findFirstOrThrow({
      where: { email: 'zaneta@example.com' },
    });
    await ctx.prisma.consentRecord.create({
      data: { customerId: zaneta.id, type: 'marketing', version: '1', granted: true },
    });

    await ctx
      .http()
      .post(`/v1/organizations/${orgId}/customers`)
      .set(owner.auth)
      .send({
        name: 'Anna "Ania" Nowak',
        phone: '+48 600 100 200',
        locale: 'uk',
        note: '=1+1',
        tags: ['stała', 'broda'],
        birthday: '03-05',
      })
      .expect(201);

    // Another salon's client never appears.
    const other = await signUp(ctx, 'other@example.com');
    const otherOrg = await createOrgWithLocation(ctx, other, 'Inny');
    await ctx
      .http()
      .post(`/v1/organizations/${otherOrg.orgId}/customers`)
      .set(other.auth)
      .send({ name: 'Obcy Klient', phone: '+48600999999' })
      .expect(201);

    const res = await ctx.http().get(exportUrl()).set(owner.auth).expect(200);
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(res.headers['content-disposition']).toMatch(
      /^attachment; filename="klienci-\d{4}-\d{2}-\d{2}\.csv"$/,
    );
    expect(res.text.startsWith('\uFEFF')).toBe(true);
    const today = localToday(Date.now(), TZ);
    expect(rows(res.text)).toEqual([
      [
        'Imię i nazwisko',
        'Telefon',
        'E-mail',
        'Język',
        'Tagi',
        'Zgoda na marketing',
        'Odbyte wizyty',
        'Ostatnia wizyta',
        'Klient od',
        'Urodziny',
        'Notatka',
      ],
      [
        'Anna "Ania" Nowak',
        '+48600100200',
        '',
        'uk',
        'stała, broda',
        'nie',
        '0',
        '',
        today,
        '05.03',
        "'=1+1",
      ],
      [
        'Żaneta Łącka',
        '+48600000002',
        'zaneta@example.com',
        'pl',
        '',
        'tak',
        '1',
        lastDay,
        today,
        '',
        '',
      ],
    ]);

    const english = await ctx.http().get(`${exportUrl()}?lang=en`).set(owner.auth).expect(200);
    expect(rows(english.text)[0]![0]).toBe('Name');
    expect(rows(english.text)[2]![5]).toBe('yes');
    await ctx.http().get(`${exportUrl()}?lang=xx`).set(owner.auth).expect(400);

    const audit = await ctx.prisma.auditLog.findMany({
      where: { organizationId: orgId, action: 'customers.exported' },
    });
    expect(audit).toHaveLength(2);
  });

  it('only the owner: managers and staff members cannot take the client list', async () => {
    const manager = await addMember('manager@example.com', 'manager');
    const staff = await addMember('staff@example.com', 'staff');
    await ctx.http().get(exportUrl()).set(manager.auth).expect(403);
    await ctx.http().get(exportUrl()).set(staff.auth).expect(403);
    await ctx.http().get(exportUrl()).expect(401);
  });
});
