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
    // Task 266: Żaneta did not come twice this year and once more than a year ago.
    for (const [i, daysAgo] of [10, 100, 400].entries()) {
      const missed = await ctx
        .http()
        .post(`${base}/appointments`)
        .set(owner.auth)
        .send({
          serviceId: service.body.id,
          staffId: staff.body.id,
          start: new Date(start.getTime() + (i + 1) * 60 * 60_000).toISOString(),
          allowOutsideHours: true,
          customerId: zaneta.id,
        })
        .expect(201);
      const at = new Date(past.getTime() - daysAgo * 86_400_000);
      await ctx.prisma.appointment.update({
        where: { id: missed.body.id },
        data: {
          status: 'no_show',
          startAt: at,
          endAt: new Date(at.getTime() + 30 * 60_000),
          blockedUntil: new Date(at.getTime() + 30 * 60_000),
        },
      });
    }
    // Task 268: the completed visit was paid (80 zł, 5 zł off); a cancelled paid one never counts.
    await ctx.prisma.appointment.update({
      where: { id: booked.body.id },
      data: { paidAt: past, discountGrosze: 500, tipGrosze: 1250 },
    });
    // Task 267: Żaneta is booked again in two days.
    await ctx
      .http()
      .post(`${base}/appointments`)
      .set(owner.auth)
      .send({
        serviceId: service.body.id,
        staffId: staff.body.id,
        start: start.toISOString(),
        allowOutsideHours: true,
        customerId: zaneta.id,
      })
      .expect(201);
    const later = await ctx
      .http()
      .post(`${base}/appointments`)
      .set(owner.auth)
      .send({
        serviceId: service.body.id,
        staffId: staff.body.id,
        start: new Date(start.getTime() + 5 * 86_400_000).toISOString(),
        allowOutsideHours: true,
        customerId: zaneta.id,
      })
      .expect(201);
    await ctx.prisma.appointment.update({
      where: { id: later.body.id },
      // Task 289: a tip on a cancelled visit never counts either.
      data: { status: 'cancelled', paidAt: new Date(), tipGrosze: 9900 },
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
        'Nieobecności (12 mies.)',
        'Następna wizyta',
        'Zapłacono łącznie',
        'Napiwki łącznie',
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
        '0',
        '',
        '0,00',
        '0,00',
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
        '2',
        addDays(today, 2),
        '75,00',
        '12,50',
        '',
      ],
    ]);

    const english = await ctx.http().get(`${exportUrl()}?lang=en`).set(owner.auth).expect(200);
    expect(rows(english.text)[0]![0]).toBe('Name');
    expect(rows(english.text)[2]![5]).toBe('yes');
    expect(rows(english.text)[0]!.slice(11, 14)).toEqual([
      'Next visit',
      'Paid in total',
      'Tips in total',
    ]);
    expect(rows(english.text)[2]![12]).toBe('75.00');
    expect(rows(english.text)[2]![13]).toBe('12.50');
    await ctx.http().get(`${exportUrl()}?lang=xx`).set(owner.auth).expect(400);

    const audit = await ctx.prisma.auditLog.findMany({
      where: { organizationId: orgId, action: 'customers.exported' },
    });
    expect(audit).toHaveLength(2);
  });

  it('"Zapłacono łącznie" per currency when the salons use different ones (task 268)', async () => {
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
    const client = await ctx
      .http()
      .post(`/v1/organizations/${orgId}/customers`)
      .set(owner.auth)
      .send({ name: 'Petr Novák', phone: '+420600100200' })
      .expect(201);
    const home = await ctx.prisma.location.findFirstOrThrow({ where: { organizationId: orgId } });
    const praha = await ctx.prisma.location.create({
      data: {
        organizationId: orgId,
        name: 'Barber Praha',
        slug: 'barber-praha',
        addressLine: 'Václavské nám. 1',
        city: 'Praha',
        postalCode: '110 00',
        currency: 'CZK',
      },
    });
    const visit = (locationId: string, priceGrosze: number, daysAgo: number) => {
      const startAt = new Date(Date.now() - daysAgo * 86_400_000);
      const endAt = new Date(startAt.getTime() + 30 * 60_000);
      return ctx.prisma.appointment.create({
        data: {
          locationId,
          staffId: staff.body.id,
          serviceId: service.body.id,
          customerId: client.body.id,
          status: 'completed',
          source: 'manual',
          startAt,
          endAt,
          blockedUntil: endAt,
          priceGrosze,
          durationMinutes: 30,
          bufferMinutes: 0,
          paidAt: endAt,
        },
      });
    };
    await visit(home.id, 8000, 3);
    await visit(praha.id, 50000, 5);
    const tipped = await visit(praha.id, 25050, 7);
    // Task 289: a 20 crown tip in Prague.
    await ctx.prisma.appointment.update({ where: { id: tipped.id }, data: { tipGrosze: 2000 } });

    const res = await ctx.http().get(exportUrl()).set(owner.auth).expect(200);
    const [header, petr] = rows(res.text);
    expect(petr![header!.indexOf('Zapłacono łącznie')]).toBe('750,50 CZK + 80,00 PLN');
    expect(petr![header!.indexOf('Następna wizyta')]).toBe('');
    expect(petr![header!.indexOf('Napiwki łącznie')]).toBe('20,00 CZK');
  });

  it('only the clients the filtered list shows, in its order (task 275)', async () => {
    const add = (name: string, phone: string, tags: string[] = []) =>
      ctx
        .http()
        .post(`/v1/organizations/${orgId}/customers`)
        .set(owner.auth)
        .send({ name, phone, tags })
        .expect(201);
    const adam = await add('Adam Stały', '+48600000011', ['stała']);
    await add('Bartek Nowy', '+48600000012');
    await add('Cezary Stały', '+48600000013', ['stała']);
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
    const location = await ctx.prisma.location.findFirstOrThrow({
      where: { organizationId: orgId },
    });
    const startAt = new Date(Date.now() - 3 * 86_400_000);
    const endAt = new Date(startAt.getTime() + 30 * 60_000);
    await ctx.prisma.appointment.create({
      data: {
        locationId: location.id,
        staffId: staff.body.id,
        serviceId: service.body.id,
        customerId: adam.body.id,
        status: 'no_show',
        source: 'manual',
        startAt,
        endAt,
        blockedUntil: endAt,
        priceGrosze: 8000,
        durationMinutes: 30,
        bufferMinutes: 0,
      },
    });
    const names = async (query: string) => {
      const res = await ctx.http().get(`${exportUrl()}?${query}`).set(owner.auth).expect(200);
      return rows(res.text)
        .slice(1)
        .map((row) => row[0]);
    };

    expect(await names('tag=sta%C5%82a')).toEqual(['Adam Stały', 'Cezary Stały']);
    expect(await names('noShows=yes')).toEqual(['Adam Stały']);
    expect(await names('search=Bartek')).toEqual(['Bartek Nowy']);
    expect(await names('once=yes')).toEqual([]);
    expect(await names('lang=en')).toEqual(['Adam Stały', 'Bartek Nowy', 'Cezary Stały']);
    // The same limits as the list's filters.
    await ctx.http().get(`${exportUrl()}?inactiveDays=5`).set(owner.auth).expect(400);
    await ctx.http().get(`${exportUrl()}?overdue=no`).set(owner.auth).expect(400);

    const audit = await ctx.prisma.auditLog.findMany({
      where: { organizationId: orgId, action: 'customers.exported' },
      orderBy: { createdAt: 'asc' },
    });
    expect(audit.map((a) => a.metadata)).toEqual([
      { count: 2, filters: { tag: 'stała' } },
      { count: 1, filters: { noShows: 'yes' } },
      { count: 1, filters: { search: 'Bartek' } },
      { count: 0, filters: { once: 'yes' } },
      { count: 3 },
    ]);
  });

  it('only the owner: managers and staff members cannot take the client list', async () => {
    const manager = await addMember('manager@example.com', 'manager');
    const staff = await addMember('staff@example.com', 'staff');
    await ctx.http().get(exportUrl()).set(manager.auth).expect(403);
    await ctx.http().get(exportUrl()).set(staff.auth).expect(403);
    await ctx.http().get(exportUrl()).expect(401);
  });
});
