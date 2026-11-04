import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  formatPrice,
  formatWhen,
  renderAppointmentEmail,
  renderCodeEmail,
  renderCodeSms,
} from '../src/booking/booking-templates';
import { OutboxService } from '../src/booking/outbox.service';
import { pushMessage } from '../src/push/push-texts';
import { addDays, localToday, zonedToInstant } from '../src/scheduling/time';
import { createTestApp, LEGAL_TEXTS, resetState, signUp, type TestContext } from './helpers';

/**
 * Launch task L5, part 4: Turkish (tr) and Albanian (sq) for booking, the client app and the
 * emails. The texts must still be proofread by native speakers (see docs/README.md).
 */
const TZ = 'Europe/Istanbul';
const DETAILS = {
  salonName: 'Berber Kadıköy',
  address: 'Moda Cd. 1, İstanbul',
  serviceName: 'Saç kesimi',
  staffName: 'Emre',
  when: '…',
  price: '…',
  customerName: 'Ayşe Yılmaz',
  customerPhone: '+905321002000',
  manageLink: 'https://example.com/tr/m/abc',
};

describe('booking texts in Turkish and Albanian', () => {
  it('emails, SMS and push are translated, not English', () => {
    const tr = renderAppointmentEmail('client_confirmation', 'tr', DETAILS);
    expect(tr.subject).toBe('Randevunuz onaylandı — Berber Kadıköy');
    expect(tr.text).toContain('Hizmet: Saç kesimi');
    expect(tr.text).toContain('Randevuyu değiştir veya iptal et:');
    const sq = renderAppointmentEmail('client_confirmation', 'sq', DETAILS);
    expect(sq.subject).toBe('Takimi u konfirmua — Berber Kadıköy');
    expect(sq.text).toContain('Shërbimi: Saç kesimi');

    for (const locale of ['tr', 'sq'] as const) {
      const en = renderAppointmentEmail('salon_new_booking', 'en', DETAILS);
      expect(renderAppointmentEmail('salon_new_booking', locale, DETAILS).subject).not.toBe(
        en.subject,
      );
      const code = renderCodeEmail(locale, '123456', 'Berber');
      expect(code.text).toContain('123456');
      expect(code.subject).not.toBe(renderCodeEmail('en', '1', 'B').subject);
      const sms = renderCodeSms(locale, '123456', 'Berber Kadıköy');
      expect(sms).toContain('123456');
      expect(sms.length).toBeLessThanOrEqual(70);
      const push = pushMessage(locale, {
        type: 'appointment.booked',
        appointmentId: null,
        data: { date: '2026-11-20', time: '10:00' },
      });
      expect(push.title).not.toBe('GESTALT');
      expect(push.url).toBe(`/${locale}/app/calendar?date=2026-11-20`);
    }
  });

  it('dates and prices follow the reader’s language', () => {
    // Friday, 20 November 2026, 10:00 in Istanbul.
    const date = new Date(zonedToInstant('2026-11-20', 10 * 60, TZ));
    expect(formatWhen(date, TZ, 'tr')).toMatch(/Cuma/);
    expect(formatWhen(date, TZ, 'tr')).toMatch(/Kasım/);
    expect(formatWhen(date, TZ, 'sq')).toMatch(/[Ee] premte/);
    expect(formatWhen(date, TZ, 'sq')).toMatch(/nëntor/);
    expect(formatPrice(50000, 'TRY', 'tr')).toMatch(/₺\s?500/);
    expect(formatPrice(150000, 'ALL', 'sq')).toMatch(/1\D?500/);
  });
});

let ctx: TestContext;
let outbox: OutboxService;
let slug: string;
let serviceId: string;
let staffId: string;
let day: string;

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
  const org = await ctx
    .http()
    .post('/v1/organizations')
    .set(owner.auth)
    .send({ name: 'Berber Kadıköy' })
    .expect(201);
  const location = await ctx
    .http()
    .post(`/v1/organizations/${org.body.id}/locations`)
    .set(owner.auth)
    .send({
      name: 'Berber Kadıköy',
      addressLine: 'Moda Cd. 1',
      city: 'İstanbul',
      postalCode: '34710',
      timezone: TZ,
      currency: 'TRY',
      defaultLocale: 'tr',
      onlineBookingEnabled: true,
      ...LEGAL_TEXTS,
    })
    .expect(201);
  expect(location.body.defaultLocale).toBe('tr');
  slug = location.body.slug;
  const base = `/v1/organizations/${org.body.id}/locations/${location.body.id}`;
  const service = await ctx
    .http()
    .post(`${base}/services`)
    .set(owner.auth)
    .send({ name: 'Saç kesimi', durationMinutes: 60, priceGrosze: 50000 })
    .expect(201);
  serviceId = service.body.id;
  const staff = await ctx
    .http()
    .post(`${base}/staff`)
    .set(owner.auth)
    .send({ displayName: 'Emre', serviceIds: [serviceId] })
    .expect(201);
  staffId = staff.body.id;
  await ctx
    .http()
    .put(`${base}/staff/${staffId}/working-hours`)
    .set(owner.auth)
    .send({
      days: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
        weekday,
        intervals: [{ start: '10:00', end: '12:00' }],
      })),
    })
    .expect(200);
  day = addDays(localToday(Date.now(), TZ), 3);
});

async function bookIn(locale: 'tr' | 'sq', email: string, hour: number) {
  const hold = await ctx
    .http()
    .post(`/v1/public/locations/${slug}/holds`)
    .send({ serviceId, staffId, start: new Date(zonedToInstant(day, hour * 60, TZ)).toISOString() })
    .expect(201);
  await ctx
    .http()
    .post(`/v1/public/holds/${hold.body.holdId}/code`)
    .send({
      holdToken: hold.body.holdToken,
      name: 'Ayşe Yılmaz',
      phone: '+905321002000',
      email,
      locale,
      acceptTerms: true,
    })
    .expect(202);
  const codeEmail = ctx.mail.lastTo(email)!;
  const code = codeEmail.text.match(/\b(\d{6})\b/)![1];
  await ctx
    .http()
    .post(`/v1/public/holds/${hold.body.holdId}/confirm`)
    .send({ holdToken: hold.body.holdToken, code })
    .expect(200);
  return codeEmail;
}

describe('booking online in Turkish and Albanian', () => {
  it('the code and the confirmation come in the client’s language, the link opens in it', async () => {
    const trCode = await bookIn('tr', 'ayse@example.com', 10);
    expect(trCode.subject).toBe('Rezervasyon onay kodunuz');
    const sqCode = await bookIn('sq', 'arta@example.com', 11);
    expect(sqCode.subject).toBe('Kodi i konfirmimit të rezervimit');

    await outbox.drain();
    const tr = ctx.mail.allTo('ayse@example.com').find((m) => m.subject.startsWith('Randevunuz'));
    expect(tr, 'Turkish confirmation').toBeDefined();
    expect(tr!.text).toContain('₺');
    expect(tr!.text).toMatch(/\/tr\/m\/\S+/);
    const sq = ctx.mail.allTo('arta@example.com').find((m) => m.subject.startsWith('Takimi'));
    expect(sq, 'Albanian confirmation').toBeDefined();
    expect(sq!.text).toMatch(/\/sq\/m\/\S+/);

    const customer = await ctx.prisma.customer.findFirstOrThrow({
      where: { email: 'arta@example.com' },
    });
    expect(customer.locale).toBe('sq');
  });

  it('the client app sends its sign-in code in Turkish and keeps Albanian as the language', async () => {
    await ctx
      .http()
      .post('/v1/client/auth/code')
      .send({ email: 'ayse@example.com', locale: 'tr' })
      .expect(202);
    const email = ctx.mail.lastTo('ayse@example.com')!;
    expect(email.subject).toBe('Ziyaretlerim için giriş kodu');
    const code = email.text.match(/\b(\d{6})\b/)![1];
    const signedIn = await ctx
      .http()
      .post('/v1/client/auth/verify')
      .send({ email: 'ayse@example.com', code, clientType: 'mobile' })
      .expect(200);
    const auth = { Authorization: `Bearer ${signedIn.body.token}` };
    const me = await ctx.http().patch('/v1/client/me').set(auth).send({ locale: 'sq' }).expect(200);
    expect(me.body.locale).toBe('sq');
  });
});
