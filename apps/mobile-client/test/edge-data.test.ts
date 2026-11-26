import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, type ClientAppointment } from '../src/api';
import { formatDate as bonusDate } from '../src/bonus';
import { formFailure } from '../src/errors';
import { favoriteSpecialists } from '../src/favorite';
import { DICTIONARIES } from '../src/i18n';
import { saveMyData } from '../src/myData';
import { paymentNoticeAmount } from '../src/paymentNotice';
import { normalizePhone } from '../src/phone';
import { parseRecent } from '../src/recent';
import { openStatus, salonNow } from '../src/salon';
import { appendSalonReviews, salonReviewLine, type SalonReview } from '../src/salonReviews';
import { nextVisitAt } from '../src/shop';
import { waitlistDays } from '../src/waitlist';
import { wishesToSend } from '../src/wishes';
import { withNetworkTimeout } from '../src/withNetworkTimeout';

const { platform } = vi.hoisted(() => ({ platform: { OS: 'web' } }));
vi.mock('react-native', () => ({ Platform: platform }));
const secureRead = vi.hoisted(() => vi.fn<(key: string) => Promise<string | null>>());
vi.mock('expo-secure-store', () => ({ getItemAsync: secureRead }));

describe('bonus history and public reviews', () => {
  it('can still show a coupon when its expiry timestamp is damaged', () => {
    expect(bonusDate('truncated', 'pl')).toBe('—');
  });

  it.each(['truncated', '2028-02-31T10:00Z'])(
    'keeps a review with a damaged timestamp (%s) below dated reviews when another page arrives',
    (createdAt) => {
      const review: SalonReview = {
        id: 'review',
        staffId: 's1',
        staffName: 'Anna',
        serviceName: 'Cut',
        rating: 4,
        text: null,
        createdAt,
        reply: null,
        repliedAt: null,
      };
      expect(salonReviewLine(review, 'en')).toBe('Anna · Cut · —');
      const oldest = { ...review, id: 'a', createdAt: '2026-10-25T02:15:00+02:00' };
      const newest = { ...review, id: 'b', createdAt: '2026-10-25T02:15:00+01:00' };
      expect(appendSalonReviews([oldest, review], [newest])).toEqual([newest, oldest, review]);
    },
  );
});

describe('salon hours and booking windows', () => {
  it('uses the Sunday opening interval for both occurrences of 02:30 in Warsaw', () => {
    const salon = {
      openingHours: [],
      todayHours: { date: '2026-10-25', intervals: [{ start: '02:00', end: '02:31' }] },
    };
    const statusAt = (instant: string) =>
      openStatus(salon, salonNow(Date.parse(instant), 'Europe/Warsaw'));
    expect(statusAt('2026-10-25T00:30:00Z')).toEqual({ kind: 'open', until: '02:31' });
    expect(statusAt('2026-10-25T01:30:00Z')).toEqual({ kind: 'open', until: '02:31' });
    expect(statusAt('2026-10-25T01:31:00Z')).toEqual({ kind: 'closed' });
  });

  it('keeps leap day available for the waitlist and ignores free dates outside the window', () => {
    const freeDates = new Set(['2024-02-27', '2024-02-28', '2024-03-01', '2024-03-03']);
    expect(waitlistDays('2024-02-28', freeDates, 4)).toEqual(['2024-02-29', '2024-03-02']);
  });
});

describe('visits in the shop and favorite specialists', () => {
  function visit(start: string, end: string, slug: string): ClientAppointment {
    return {
      status: 'confirmed',
      start,
      end,
      salon: { slug, name: slug },
      staff: { id: 'anna', displayName: 'Anna' },
      service: { id: 'cut', name: 'Cut' },
      bookAgain: { slug, staffId: 'anna', serviceId: 'cut' },
    } as ClientAppointment;
  }

  it('keeps the second 02:30 available for pickup after the first 02:30 has started', () => {
    const first = visit('2026-10-25T02:30:00+02:00', '2026-10-25T02:50:00+02:00', 'north');
    const second = visit('2026-10-25T02:30:00+01:00', '2026-10-25T02:50:00+01:00', 'north');
    expect(nextVisitAt([first, second], 'north', Date.parse(first.start))).toBe(second);
    expect(nextVisitAt([first, second], 'north', Date.parse(second.start))).toBeNull();
  });

  it('counts the same specialist separately at two branches', () => {
    const visits = [
      visit('2026-11-02T10:00Z', '2026-11-02T11:00Z', 'north'),
      visit('2026-10-28T10:00Z', '2026-10-28T11:00Z', 'south'),
      visit('2026-11-01T10:00Z', '2026-11-01T11:00Z', 'south'),
    ];
    const favorites = favoriteSpecialists(visits, 3, Date.parse('2026-11-03T00:00Z'));
    expect(favorites.map(({ slug, visits }) => [slug, visits])).toEqual([
      ['north', 1],
      ['south', 2],
    ]);
  });
});

describe('client forms and saved salons', () => {
  it.each(['pl', 'en', 'uk', 'ru'] as const)(
    'keeps retry with the localized timeout (%s)',
    (locale) => {
      const t = DICTIONARIES[locale];
      const retry = vi.fn();
      expect(formFailure(new ApiError(408, ''), t, retry)).toEqual({
        message: t.error.network,
        retry,
      });
      expect(formFailure(new ApiError(409, '', 'SLOT_TAKEN'), t, retry)).toEqual({
        message: t.visit.slotTaken,
      });
    },
  );

  it('keeps an explicitly international number intact when normalized again for another salon', () => {
    const number = normalizePhone('00 39 (06) 1234 5678', '48');
    expect(number).toBe('+390612345678');
    expect(normalizePhone(number, '380')).toBe(number);
  });

  it('drops a stale drink after the question is removed but allows an explicit refusal otherwise', () => {
    const wishes = { mood: null, drink: 'none', note: '  Без цукру  ' } as const;
    const questions = { mood: false, note: true, drinks: ['tea'] as 'tea'[] };
    expect(wishesToSend(wishes, questions)).toEqual({
      mood: null,
      drink: 'none',
      note: 'Без цукру',
    });
    expect(wishesToSend(wishes, { ...questions, drinks: [] })).toEqual({
      mood: null,
      drink: null,
      note: 'Без цукру',
    });
  });

  it('recovers the named recent salon when an earlier duplicate has a blank label', () => {
    const saved = [
      { slug: 'salon', name: ' \t ' },
      { slug: 'salon', name: 'Łódź' },
    ];
    expect(parseRecent(JSON.stringify(saved))).toEqual([saved[1]]);
  });

  it('accepts the largest exactly representable amount and rejects the next integer', () => {
    const details = (amount: string) => [
      { path: 'currency', message: 'PLN' },
      { path: 'amountGrosze', message: amount },
    ];
    expect(paymentNoticeAmount(details('9007199254740991'))).toEqual({
      value: Number.MAX_SAFE_INTEGER,
      currency: 'PLN',
    });
    expect(paymentNoticeAmount(details('9007199254740992'))).toBeNull();
  });
});

describe('downloading personal data', () => {
  it('releases the browser download link and URL when the click fails', async () => {
    platform.OS = 'web';
    vi.useFakeTimers();
    const error = new Error('Download unavailable');
    const link = {
      href: '',
      download: '',
      click: vi.fn(() => {
        throw error;
      }),
      remove: vi.fn(),
    };
    vi.stubGlobal('document', { createElement: () => link, body: { append: vi.fn() } });
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:export');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    try {
      await expect(saveMyData('[]', 'visits.json', 'My visits')).rejects.toBe(error);
      expect(link.remove).toHaveBeenCalledOnce();
      vi.runAllTimers();
      expect(revoke).toHaveBeenCalledWith('blob:export');
    } finally {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });
});

describe('restoring saved client data', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    secureRead.mockReset();
    platform.OS = 'web';
  });

  it.each(['web', 'android'])(
    'ignores a blank session but accepts a plain-text token on %s',
    async (os) => {
      platform.OS = os;
      let saved = ' \t\n ';
      const read = (key: string) => (key === 'beauty.client.session' ? saved : null);
      vi.stubGlobal('localStorage', os === 'web' ? { getItem: read } : undefined);
      secureRead.mockImplementation(async (key) => read(key));
      vi.resetModules();
      const { tokenStore } = await import('../src/storage');

      await expect(tokenStore.get()).resolves.toBeNull();
      saved = 'plain-text-session';
      await expect(tokenStore.get()).resolves.toBe(saved);
    },
  );

  it('recovers the saved session independently of damaged catalog data after the keychain unlocks', async () => {
    platform.OS = 'ios';
    vi.resetModules();
    const { tokenStore, recentSalonsStore, catalogLanguagesStore } = await import('../src/storage');
    const locked = new Error('Keychain unavailable');
    secureRead.mockRejectedValue(locked);
    await expect(tokenStore.get()).rejects.toBe(locked);
    await expect(recentSalonsStore.get()).resolves.toEqual([]);
    await expect(catalogLanguagesStore.get()).resolves.toEqual([]);

    const values = new Map([
      ['beauty.client.session', 'existing-session'],
      ['beauty.catalog.recent', '[{"slug":"old"'],
      ['beauty.catalog.languages', '"pl"'],
    ]);
    secureRead.mockImplementation(async (key) => values.get(key) ?? null);
    await expect(recentSalonsStore.get()).resolves.toEqual([]);
    await expect(catalogLanguagesStore.get()).resolves.toEqual([]);
    await expect(tokenStore.get()).resolves.toBe('existing-session');
  });
});

describe('cancellation and retry near the network deadline', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('returns the original cancellation and clears the deadline when a read is aborted', async () => {
    const controller = new AbortController();
    const request = new Promise<never>((_, reject) => {
      controller.signal.addEventListener('abort', () => reject(controller.signal.reason), {
        once: true,
      });
    });
    const reason = new DOMException('Read cancelled', 'AbortError');
    const cancelled = expect(withNetworkTimeout(request)).rejects.toBe(reason);

    await vi.advanceTimersByTimeAsync(29_999);
    controller.abort(reason);
    await cancelled;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('gives a retry its own deadline even if the expired request fails late', async () => {
    const first = Promise.withResolvers<string>();
    const expired = expect(withNetworkTimeout(first.promise)).rejects.toThrow(
      'Network request timed out',
    );
    await vi.advanceTimersByTimeAsync(30_000);
    await expired;

    const retry = Promise.withResolvers<string>();
    const result = withNetworkTimeout(retry.promise);
    first.reject(new TypeError('Connection lost'));
    await vi.advanceTimersByTimeAsync(29_999);
    expect(vi.getTimerCount()).toBe(1);
    retry.resolve('fresh response');
    await expect(result).resolves.toBe('fresh response');
    expect(vi.getTimerCount()).toBe(0);
  });
});
