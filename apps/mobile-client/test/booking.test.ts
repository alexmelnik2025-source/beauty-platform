import { describe, expect, it } from 'vitest';
import { ApiError, ClientApi, type Hold, type PublicLocation, type Slot } from '../src/api';
import {
  afterBookingError,
  bookingStart,
  checkContact,
  countdown,
  dayParts,
  legalUrl,
  manageUrl,
  staffFor,
} from '../src/booking';
import { dialForTimeZone, normalizePhone } from '../src/phone';
import { DICTIONARIES, fill, LOCALES } from '../src/i18n';

const form = {
  name: '  Anna   Kowalska ',
  phone: '600 100 200',
  email: ' Anna@Example.com ',
  acceptTerms: true,
  marketingConsent: false,
};

const slot = (time: string): Slot =>
  ({ start: `2026-11-10T${time}:00Z`, date: '2026-11-10', time }) as Slot;

const hold: Hold = {
  holdId: '7b0e2a8e-1f7a-4c39-9a3f-8d7e0d2b5c11',
  holdToken: 'hold-token-0123456789abcdef',
  expiresAt: '2026-11-10T10:10:00Z',
  start: '2026-11-10T10:00:00Z',
  end: '2026-11-10T10:45:00Z',
  date: '2026-11-10',
  time: '11:00',
  staffId: 's1',
  staffName: 'Kasia',
  serviceName: 'Strzyżenie męskie',
  priceGrosze: 9000,
  listPriceGrosze: null,
  happyHourPercent: null,
  currency: 'PLN',
};

describe('booking form', () => {
  it('cleans up the details: a Polish number without +48, the email in small letters', () => {
    expect(checkContact(form)).toEqual({
      ok: true,
      contact: {
        name: 'Anna Kowalska',
        phone: '+48600100200',
        email: 'anna@example.com',
        acceptTerms: true,
        marketingConsent: false,
      },
    });
  });

  it('phone numbers in the salon country, or any other with its +code (launch task L5)', () => {
    expect(normalizePhone('0048 600-100-200')).toBe('+48600100200');
    expect(normalizePhone('+380 67 123 45 67')).toBe('+380671234567');
    expect(dialForTimeZone('Europe/Warsaw')).toBe('48');
    expect(dialForTimeZone('Europe/Istanbul')).toBe('90');
    expect(dialForTimeZone('Europe/Tirane')).toBe('355');
    expect(dialForTimeZone('Europe/Kyiv')).toBe('380');
    expect(dialForTimeZone('America/New_York')).toBe('48');
    expect(normalizePhone('0532 100 20 00', '90')).toBe('+905321002000');
    expect(normalizePhone('06 1234 5678', '39')).toBe('+390612345678');
    expect(checkContact({ ...form, phone: '050 123 45 67' }, '380')).toMatchObject({
      ok: true,
      contact: { phone: '+380501234567' },
    });
  });

  it('says what to fix first, before asking the server', () => {
    expect(checkContact({ ...form, name: ' ' })).toEqual({ ok: false, problem: 'name' });
    expect(checkContact({ ...form, phone: '+48 ' })).toEqual({ ok: false, problem: 'phone' });
    expect(checkContact({ ...form, email: 'anna@' })).toEqual({ ok: false, problem: 'email' });
    // The salon's booking rules must be accepted; news from the salon stay optional.
    expect(checkContact({ ...form, acceptTerms: false })).toEqual({ ok: false, problem: 'terms' });
  });
});

describe('booking steps', () => {
  it('only specialists who do the service', () => {
    const salon = {
      staff: [
        { id: 'a', serviceIds: ['cut'] },
        { id: 'b', serviceIds: ['beard'] },
        { id: 'c', serviceIds: ['cut', 'beard'] },
      ],
    } as unknown as PublicLocation;
    expect(staffFor(salon, 'cut').map((s) => s.id)).toEqual(['a', 'c']);
  });

  it('times by part of the day, without empty parts', () => {
    const parts = dayParts([slot('09:00'), slot('11:45'), slot('17:00'), slot('18:30')]);
    expect(parts.map((p) => [p.part, p.slots.map((s) => s.time)])).toEqual([
      ['morning', ['09:00', '11:45']],
      ['evening', ['17:00', '18:30']],
    ]);
  });

  it('after an error: back to the times, fresh times or stay', () => {
    expect(afterBookingError(new ApiError(410, 'x', 'HOLD_EXPIRED'))).toBe('pickTimeAgain');
    expect(afterBookingError(new ApiError(429, 'x', 'TOO_MANY_CODES'))).toBe('pickTimeAgain');
    expect(afterBookingError(new ApiError(409, 'x', 'SLOT_TAKEN'))).toBe('reloadTimes');
    expect(afterBookingError(new ApiError(400, 'x', 'INVALID_CODE'))).toBe('stay');
    expect(afterBookingError(new TypeError('offline'))).toBe('stay');
  });

  it('the countdown of the held time, and the web page to change the visit', () => {
    expect(countdown(hold.expiresAt, Date.parse('2026-11-10T10:05:01Z'))).toBe('4:59');
    expect(countdown(hold.expiresAt, Date.parse('2026-11-10T10:11:00Z'))).toBe('0:00');
    expect(manageUrl('https://app.test/', 'uk', 'tok')).toBe('https://app.test/uk/m/tok');
    expect(legalUrl('https://app.test/', 'pl', 'gestalt', 'terms')).toBe(
      'https://app.test/pl/b/gestalt/regulamin',
    );
    expect(legalUrl('https://app.test', 'en', 'gestalt', 'privacy')).toBe(
      'https://app.test/en/b/gestalt/privacy',
    );
  });

  it('texts with placeholders are in every language', () => {
    for (const locale of LOCALES) {
      const b = DICTIONARIES[locale].book;
      expect(fill(b.heldFor, { time: '4:59' }), locale).toContain('4:59');
      expect(fill(b.codeLead, { email: 'anna@example.com' }), locale).toContain('anna@example.com');
    }
  });
});

describe('ClientApi booking', () => {
  it('holds, sends the code and confirms without a session, once per key', async () => {
    const calls: {
      method?: string;
      url: string;
      body: unknown;
      headers: Record<string, string>;
    }[] = [];
    const fetchFn = async (url: string, init?: RequestInit) => {
      calls.push({
        method: init?.method,
        url: url.replace('https://api.test', ''),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
        headers: (init?.headers ?? {}) as Record<string, string>,
      });
      if (url.includes('/holds/') && url.endsWith('/release')) {
        return new Response(null, { status: 204 });
      }
      if (url.endsWith('/holds')) return new Response(JSON.stringify(hold), { status: 201 });
      if (url.endsWith('/code')) {
        return new Response(JSON.stringify({ codeExpiresAt: hold.expiresAt }), { status: 202 });
      }
      if (url.endsWith('/confirm')) {
        return new Response(JSON.stringify({ manageToken: 'm', signedIn: false }), { status: 200 });
      }
      return new Response(JSON.stringify({ slots: [] }));
    };
    const api = new ClientApi(
      'https://api.test',
      { get: async () => null, set: async () => {} },
      fetchFn,
    );

    await api.availability('gestalt', {
      serviceId: 'cut',
      from: '2026-11-10',
      to: '2026-11-30',
    });
    expect(calls[0]!.url).toBe(
      '/v1/public/locations/gestalt/availability?serviceId=cut&from=2026-11-10&to=2026-11-30',
    );

    await api.hold('gestalt', { serviceId: 'cut', start: hold.start }, 'key-12345678');
    expect(calls[1]).toMatchObject({
      method: 'POST',
      url: '/v1/public/locations/gestalt/holds',
      body: { serviceId: 'cut', start: hold.start },
      headers: { 'idempotency-key': 'key-12345678' },
    });

    const contact = checkContact(form);
    if (!contact.ok) throw new Error('form');
    await api.sendBookingCode(hold, contact.contact, 'ru');
    expect(calls[2]).toMatchObject({
      url: `/v1/public/holds/${hold.holdId}/code`,
      body: {
        holdToken: hold.holdToken,
        email: 'anna@example.com',
        locale: 'ru',
        codeChannel: 'email',
      },
    });

    await api.confirmBooking(hold, '123456');
    expect(calls[3]).toMatchObject({
      url: `/v1/public/holds/${hold.holdId}/confirm`,
      body: { holdToken: hold.holdToken, code: '123456' },
      headers: { 'idempotency-key': `confirm-${hold.holdId}-123456` },
    });
    // No session token is ever sent with the public booking.
    expect(calls.every((c) => !c.headers.authorization)).toBe(true);

    await api.releaseHold(hold);
    expect(calls[4]).toMatchObject({
      url: `/v1/public/holds/${hold.holdId}/release`,
      body: { holdToken: hold.holdToken },
    });
  });
});

describe('"book again" starts with the same service and specialist', () => {
  const salon = {
    services: [{ id: 'cut' }, { id: 'beard' }, { id: 'nails' }],
    staff: [
      { id: 'kasia', serviceIds: ['cut', 'beard'] },
      { id: 'alex', serviceIds: ['cut'] },
      { id: 'ola', serviceIds: ['nails'] },
    ],
  } as unknown as PublicLocation;

  it('without a preset — the price list', () => {
    expect(bookingStart(salon)).toEqual({ step: 'service', serviceId: '' });
  });

  it('the same specialist still does the service — straight to free times', () => {
    expect(bookingStart(salon, { serviceId: 'cut', staffId: 'alex' })).toEqual({
      step: 'time',
      serviceId: 'cut',
      staffId: 'alex',
    });
  });

  it('"any specialist" last time — the choice of specialist', () => {
    expect(bookingStart(salon, { serviceId: 'cut', staffId: null })).toEqual({
      step: 'staff',
      serviceId: 'cut',
    });
  });

  it('the specialist no longer does it — choose another, with a note', () => {
    expect(bookingStart(salon, { serviceId: 'cut', staffId: 'ola' })).toEqual({
      step: 'staff',
      serviceId: 'cut',
      gone: 'staff',
    });
    // Only one specialist left: nothing to choose, the free times of that one.
    expect(bookingStart(salon, { serviceId: 'nails', staffId: 'kasia' })).toEqual({
      step: 'time',
      serviceId: 'nails',
      staffId: 'ola',
      gone: 'staff',
    });
  });

  it('the salon no longer takes the service online — the price list, with a note', () => {
    expect(bookingStart(salon, { serviceId: 'colour', staffId: 'kasia' })).toEqual({
      step: 'service',
      serviceId: '',
      gone: 'service',
    });
  });
});
