import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { OutboxService } from '../src/booking/outbox.service';
import { parseConfig } from '../src/config/config';
import { parseMailbox, senderMailbox, textToHtml } from '../src/mail/compose';
import { outgoing } from '../src/mail/mail.service';
import { addDays, localToday, zonedToInstant } from '../src/scheduling/time';
import {
  createTestApp,
  LEGAL_TEXTS,
  LOCATION,
  resetState,
  signUp,
  type TestContext,
} from './helpers';

/**
 * Launch task L2: emails ready for real clients. The client sees the salon as the sender,
 * a reply goes to the salon, every email has an HTML version next to the text, and the
 * production configuration refuses localhost links and a localhost sender.
 */

describe('sender, reply-to and HTML', () => {
  it('shows the salon’s name with the platform’s sending address', () => {
    expect(parseMailbox('GESTALT <rezerwacje@hairgestalt.pl>')).toEqual({
      name: 'GESTALT',
      address: 'rezerwacje@hairgestalt.pl',
    });
    expect(parseMailbox('no-reply@hairgestalt.pl')).toEqual({
      name: '',
      address: 'no-reply@hairgestalt.pl',
    });
    const from = 'GESTALT <rezerwacje@hairgestalt.pl>';
    expect(senderMailbox(from, 'Berber Moda')).toBe('"Berber Moda" <rezerwacje@hairgestalt.pl>');
    expect(senderMailbox(from)).toBe('"GESTALT" <rezerwacje@hairgestalt.pl>');
    // Quotes, brackets and line breaks in a salon name cannot change the header.
    expect(senderMailbox(from, 'Salon "X" <evil@x.com>\r\nBcc: a@b.c')).toBe(
      '"Salon X evil@x.com Bcc: a@b.c" <rezerwacje@hairgestalt.pl>',
    );
    expect(senderMailbox('no-reply@hairgestalt.pl', '')).toBe('no-reply@hairgestalt.pl');
  });

  it('the HTML version has the same words, clickable links and nothing executable', () => {
    const html = textToHtml(
      'Twoja wizyta jest potwierdzona.\n\nUsługa: <b>Strzyżenie</b> & broda\nZmień lub odwołaj wizytę:\nhttps://rezerwacje.example.pl/pl/m/abc_123',
      'pl',
    );
    expect(html).toContain('<html lang="pl">');
    expect(html).toContain('<p style="margin:0 0 16px">Twoja wizyta jest potwierdzona.</p>');
    expect(html).toContain('Usługa: &lt;b&gt;Strzyżenie&lt;/b&gt; &amp; broda<br>');
    expect(html).toContain(
      '<a href="https://rezerwacje.example.pl/pl/m/abc_123" style="color:#1d1d1b;font-weight:600">https://rezerwacje.example.pl/pl/m/abc_123</a>',
    );
    expect(textToHtml('<script>alert(1)</script>')).not.toContain('<script>');
    const mail = outgoing(
      { to: 'a@example.com', subject: 'S', text: 'T', senderName: 'Salon', replyTo: 's@x.pl' },
      'P <p@x.pl>',
    );
    expect(mail).toMatchObject({ from: '"Salon" <p@x.pl>', replyTo: 's@x.pl', text: 'T' });
    expect(mail.html).toContain('<p style="margin:0 0 16px">T</p>');
  });
});

describe('production configuration', () => {
  const production = {
    NODE_ENV: 'production',
    DATABASE_URL: 'postgresql://user:secret@postgres:5432/db',
    JWT_ACCESS_SECRET: 'a-test-secret-that-is-long-enough-0123',
    APP_WEB_URL: 'https://rezerwacje.hairgestalt.pl',
    MAIL_FROM: 'GESTALT <rezerwacje@hairgestalt.pl>',
  };

  it('accepts a public https address and a sender on a real domain', () => {
    expect(parseConfig(production).APP_WEB_URL).toBe('https://rezerwacje.hairgestalt.pl');
  });

  it('refuses links to localhost or plain http in emails', () => {
    for (const url of ['http://localhost:3000', 'https://localhost', 'http://rezerwacje.pl']) {
      expect(() => parseConfig({ ...production, APP_WEB_URL: url }), url).toThrow(/APP_WEB_URL/);
    }
    // Development keeps working with localhost.
    expect(
      parseConfig({ ...production, NODE_ENV: 'development', APP_WEB_URL: 'http://localhost:3000' }),
    ).toBeTruthy();
  });

  it('refuses a localhost sender', () => {
    expect(() =>
      parseConfig({ ...production, MAIL_FROM: 'Beauty Platform <no-reply@localhost>' }),
    ).toThrow(/MAIL_FROM/);
  });
});

const TZ = 'Europe/Warsaw';
const CLIENT = 'anna.l2@example.com';
let ctx: TestContext;
let outbox: OutboxService;

beforeAll(async () => {
  ctx = await createTestApp();
  outbox = ctx.app.get(OutboxService);
});

afterAll(async () => {
  await ctx.app.close();
});

beforeEach(async () => {
  await resetState(ctx);
});

describe('booking emails come from the salon', () => {
  it('code and confirmation: salon name as sender, reply to the salon, text and HTML', async () => {
    const owner = await signUp(ctx, 'owner.l2@example.com');
    const org = await ctx
      .http()
      .post('/v1/organizations')
      .set(owner.auth)
      .send({ name: 'GESTALT' })
      .expect(201);
    const location = await ctx
      .http()
      .post(`/v1/organizations/${org.body.id}/locations`)
      .set(owner.auth)
      .send({
        ...LOCATION,
        name: 'GESTALT Barbershop',
        email: 'Salon@HairGestalt.pl',
        onlineBookingEnabled: true,
        ...LEGAL_TEXTS,
      })
      .expect(201);
    const base = `/v1/organizations/${org.body.id}/locations/${location.body.id}`;
    const service = await ctx
      .http()
      .post(`${base}/services`)
      .set(owner.auth)
      .send({ name: 'Strzyżenie', durationMinutes: 45, priceGrosze: 9000 })
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
    const hold = await ctx
      .http()
      .post(`/v1/public/locations/${location.body.slug}/holds`)
      .send({
        serviceId: service.body.id,
        staffId: staff.body.id,
        start: new Date(zonedToInstant(day, 10 * 60, TZ)).toISOString(),
      })
      .expect(201);
    await ctx
      .http()
      .post(`/v1/public/holds/${hold.body.holdId}/code`)
      .send({
        holdToken: hold.body.holdToken,
        name: 'Anna Kowalska',
        phone: '+48600100200',
        email: CLIENT,
        locale: 'pl',
        acceptTerms: true,
      })
      .expect(202);
    const sendingAddress = parseMailbox(ctx.mail.mailFrom).address;
    const codeMail = ctx.mail.lastTo(CLIENT)!;
    expect(codeMail.outgoing.from).toBe(`"GESTALT Barbershop" <${sendingAddress}>`);
    expect(codeMail.outgoing.replyTo).toBe('salon@hairgestalt.pl');
    expect(codeMail.outgoing.html).toContain('<html lang="pl">');
    const code = codeMail.text.match(/\b(\d{6})\b/)![1]!;
    expect(codeMail.outgoing.html).toContain(code);
    await ctx
      .http()
      .post(`/v1/public/holds/${hold.body.holdId}/confirm`)
      .send({ holdToken: hold.body.holdToken, code })
      .expect(200);

    await outbox.drain();
    const confirmation = ctx.mail
      .allTo(CLIENT)
      .find((m) => m.subject.startsWith('Wizyta potwierdzona'))!;
    expect(confirmation.outgoing).toMatchObject({
      from: `"GESTALT Barbershop" <${sendingAddress}>`,
      replyTo: 'salon@hairgestalt.pl',
    });
    const link = /(\S+\/pl\/m\/\S+)/.exec(confirmation.text)![1]!;
    expect(confirmation.outgoing.html).toContain(`<a href="${link}"`);

    // The salon's own notification comes from the platform: replying to it reaches nobody else.
    const toOwner = ctx.mail.lastTo('owner.l2@example.com')!;
    expect(toOwner.subject).toContain('Nowa rezerwacja online');
    expect(toOwner.outgoing.replyTo).toBeUndefined();
    expect(toOwner.outgoing.from).not.toContain('GESTALT Barbershop');
  });
});
