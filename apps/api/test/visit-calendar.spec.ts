import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { renderAppointmentEmail } from '../src/booking/booking-templates';
import { buildIcs, foldLine, icsText, icsTime } from '../src/booking/ics';
import { OutboxService } from '../src/booking/outbox.service';
import { addDays, localToday, zonedToInstant } from '../src/scheduling/time';
import {
  createOrgWithLocation,
  createTestApp,
  expectError,
  LEGAL_TEXTS,
  resetState,
  signUp,
  type TestContext,
} from './helpers';

/**
 * Task 20: "Add to calendar" — the visit as an .ics file behind the manage link, and the
 * link to it in the booking emails.
 */

const TZ = 'Europe/Warsaw';
const CLIENT = {
  name: 'Anna Kowalska',
  phone: '+48 600 100 200',
  email: 'anna.client@example.com',
  locale: 'pl',
  acceptTerms: true,
};

/** Unfolds continuation lines, as a calendar does when reading the file. */
const unfold = (ics: string): string[] => ics.replace(/\r\n /g, '').split('\r\n');

describe('the .ics format', () => {
  it('writes UTC times, escapes text and folds long lines without cutting letters', () => {
    expect(icsTime(new Date('2026-11-20T09:05:00.000Z'))).toBe('20261120T090500Z');
    expect(icsText('Strzyżenie, broda; a\\b\nnowa linia')).toBe(
      'Strzyżenie\\, broda\\; a\\\\b\\nnowa linia',
    );
    const long = `DESCRIPTION:${'ż'.repeat(100)}`;
    const folded = foldLine(long);
    for (const line of folded.split('\r\n')) {
      expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
    }
    expect(folded.replace(/\r\n /g, '')).toBe(long);
    expect(folded).not.toContain('�');
  });

  it('a cancelled visit has no reminder and is marked cancelled', () => {
    const base = {
      uid: 'a@b',
      sequence: 2,
      start: new Date('2026-11-20T09:00:00Z'),
      end: new Date('2026-11-20T09:45:00Z'),
      summary: 'Strzyżenie — Barber',
      location: 'ul. Puławska 1',
      description: 'x',
      now: new Date('2026-11-04T12:00:00Z'),
      alarmMinutesBefore: 60,
    };
    const live = buildIcs({ ...base, cancelled: false });
    expect(live).toContain('STATUS:CONFIRMED\r\n');
    expect(live).toContain('TRIGGER:-PT60M\r\n');
    expect(live.endsWith('END:VCALENDAR\r\n')).toBe(true);
    const gone = buildIcs({ ...base, cancelled: true });
    expect(gone).toContain('STATUS:CANCELLED\r\n');
    expect(gone).not.toContain('VALARM');
  });

  it('the email line is in the reader’s language', () => {
    const details = {
      salonName: 'Barber',
      address: 'ul. Puławska 1',
      serviceName: 'Strzyżenie',
      staffName: 'Kasia',
      when: '…',
      price: '…',
      customerName: 'Anna',
      customerPhone: '+48600100200',
      manageLink: 'https://example.com/pl/m/abc',
      calendarLink: 'https://example.com/v1/public/appointments/abc/calendar.ics',
    };
    const expected = {
      pl: 'Dodaj do kalendarza:',
      uk: 'Додати в календар:',
      ru: 'Добавить в календарь:',
      en: 'Add to calendar:',
      tr: 'Takvime ekle:',
      sq: 'Shtoje në kalendar:',
    } as const;
    for (const [locale, words] of Object.entries(expected)) {
      const { text } = renderAppointmentEmail(
        'client_confirmation',
        locale as keyof typeof expected,
        details,
      );
      expect(text).toContain(`${words}\n${details.calendarLink}`);
    }
  });
});

let ctx: TestContext;
let outbox: OutboxService;
let slug: string;
let serviceId: string;
let staffId: string;
let day: string;

const at = (date: string, hh: number, mm = 0): string =>
  new Date(zonedToInstant(date, hh * 60 + mm, TZ)).toISOString();

const makeQueueDue = () =>
  ctx.prisma
    .$executeRaw`UPDATE notification_outbox SET next_attempt_at = now(), locked_until = NULL WHERE status = 'pending'`;

async function book(start: string): Promise<{ id: string; manageToken: string }> {
  const h = await ctx
    .http()
    .post(`/v1/public/locations/${slug}/holds`)
    .send({ serviceId, start, staffId })
    .expect(201);
  await ctx
    .http()
    .post(`/v1/public/holds/${h.body.holdId}/code`)
    .send({ holdToken: h.body.holdToken, ...CLIENT })
    .expect(202);
  const code = ctx.mail.lastTo(CLIENT.email)?.text.match(/\b(\d{6})\b/)?.[1];
  const c = await ctx
    .http()
    .post(`/v1/public/holds/${h.body.holdId}/confirm`)
    .send({ holdToken: h.body.holdToken, code })
    .expect(200);
  return { id: h.body.holdId as string, manageToken: c.body.manageToken as string };
}

const ics = (token: string) =>
  ctx.http().get(`/v1/public/appointments/${token}/calendar.ics`).buffer(true);

beforeAll(async () => {
  ctx = await createTestApp();
  outbox = ctx.app.get(OutboxService);
});

afterAll(async () => {
  await ctx.app.close();
});

beforeEach(async () => {
  await resetState(ctx);
  const owner = await signUp(ctx, 'owner@example.com');
  const org = await createOrgWithLocation(ctx, owner, 'Barber');
  slug = org.slug;
  const base = `/v1/organizations/${org.orgId}/locations/${org.locationId}`;
  serviceId = (
    await ctx
      .http()
      .post(`${base}/services`)
      .set(owner.auth)
      .send({ name: 'Strzyżenie, broda', durationMinutes: 45, priceGrosze: 8000 })
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
  const loc = await ctx.http().get(base).set(owner.auth).expect(200);
  await ctx
    .http()
    .patch(base)
    .set(owner.auth)
    .send({ version: loc.body.version, onlineBookingEnabled: true, ...LEGAL_TEXTS })
    .expect(200);
  day = addDays(localToday(Date.now(), TZ), 3);
});

describe('"Add to calendar" for a booked visit', () => {
  it('the manage link gives the visit as an .ics file without the client’s contacts', async () => {
    const { id, manageToken } = await book(at(day, 10));
    const res = await ics(manageToken).expect(200);
    expect(res.headers['content-type']).toMatch(/^text\/calendar; charset=utf-8/);
    expect(res.headers['content-disposition']).toBe(`attachment; filename="visit-${day}.ics"`);
    const lines = unfold(res.text);
    expect(lines).toContain(`UID:${id}@beauty-platform`);
    expect(lines).toContain('SEQUENCE:1');
    const start = new Date(at(day, 10));
    expect(lines).toContain(`DTSTART:${start.toISOString().replace(/[-:]|\.\d{3}/g, '')}`);
    const end = new Date(start.getTime() + 45 * 60_000);
    expect(lines).toContain(`DTEND:${end.toISOString().replace(/[-:]|\.\d{3}/g, '')}`);
    expect(lines).toContain('SUMMARY:Strzyżenie\\, broda — Barber Centrum');
    expect(lines).toContain('LOCATION:Barber Centrum\\, ul. Puławska 1\\, 02-515 Warszawa');
    expect(lines).toContain('STATUS:CONFIRMED');
    expect(lines.find((l) => l.startsWith('DESCRIPTION:'))).toContain('Specjalista: Kasia');
    expect(lines.find((l) => l.startsWith('URL:'))).toMatch(new RegExp(`/pl/m/${manageToken}$`));
    expect(res.text).not.toContain(CLIENT.email);
    expect(res.text).not.toContain('600');
  });

  it('after a move the same event is updated; after a cancellation it is marked cancelled', async () => {
    const { id, manageToken } = await book(at(day, 10));
    await ctx
      .http()
      .post(`/v1/public/appointments/${manageToken}/reschedule`)
      .send({ start: at(day, 14) })
      .expect(200);
    let lines = unfold((await ics(manageToken).expect(200)).text);
    expect(lines).toContain(`UID:${id}@beauty-platform`);
    expect(lines.find((l) => l.startsWith('SEQUENCE:'))).not.toBe('SEQUENCE:1');
    expect(lines).toContain(
      `DTSTART:${new Date(at(day, 14)).toISOString().replace(/[-:]|\.\d{3}/g, '')}`,
    );

    await ctx.http().post(`/v1/public/appointments/${manageToken}/cancel`).send({}).expect(200);
    lines = unfold((await ics(manageToken).expect(200)).text);
    expect(lines).toContain('STATUS:CANCELLED');
  });

  it('an unknown or expired link is 404', async () => {
    expectError((await ics('nope').expect(404)).body, 'NOT_FOUND');
    const { manageToken } = await book(at(day, 10));
    await ctx.prisma.appointmentAccessToken.updateMany({
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await ics(manageToken).expect(404);
  });

  it('the confirmation email links to the calendar file, and the link works', async () => {
    await book(at(day, 10));
    await makeQueueDue();
    await outbox.drain();
    const email = ctx.mail.sent.find(
      (m) => m.to === CLIENT.email && m.subject.startsWith('Wizyta potwierdzona'),
    );
    expect(email?.text).toContain('Dodaj do kalendarza:');
    const link = email?.text.match(/(\S+\/v1\/public\/appointments\/(\S+)\/calendar\.ics)/);
    expect(link?.[1]).toMatch(/^http/);
    const res = await ics(link?.[2] ?? '').expect(200);
    expect(res.text).toContain('BEGIN:VEVENT');
  });
});

describe('"Add to calendar" in the client app (task 22)', () => {
  async function signIn(email: string): Promise<{ Authorization: string }> {
    await ctx.http().post('/v1/client/auth/code').send({ email, locale: 'pl' }).expect(202);
    const code = ctx.mail.lastTo(email)?.text.match(/\b(\d{6})\b/)?.[1];
    const res = await ctx
      .http()
      .post('/v1/client/auth/verify')
      .send({ email, code, clientType: 'mobile' })
      .expect(200);
    return { Authorization: `Bearer ${res.body.token}` };
  }

  it('gives a signed-in client a link to the calendar file of their own visit only', async () => {
    const { id } = await book(at(day, 10));
    const anna = await signIn(CLIENT.email);
    const res = await ctx
      .http()
      .post(`/v1/client/appointments/${id}/calendar-link`)
      .set(anna)
      .expect(200);
    expect(res.body.url).toMatch(/^http.+\/v1\/public\/appointments\/\S+\/calendar\.ics$/);
    const token = /appointments\/(\S+)\/calendar\.ics$/.exec(res.body.url)?.[1] ?? '';
    const file = await ics(token).expect(200);
    expect(unfold(file.text)).toContain(`UID:${id}@beauty-platform`);

    // Someone else's visit looks like a missing one; without signing in — 401.
    const other = await signIn('someone.else@example.com');
    await ctx.http().post(`/v1/client/appointments/${id}/calendar-link`).set(other).expect(404);
    await ctx.http().post(`/v1/client/appointments/${id}/calendar-link`).expect(401);
  });
});
