import { describe, expect, it } from 'vitest';
import { BusinessApi, type SalonReviews, type TokenStore } from '../src/api';
import { DICTIONARIES } from '../src/i18n';
import { appendReviews, reviewLine, reviewSummary, stars, type Review } from '../src/reviews';

const review = (id: string, patch: Partial<Review> = {}): Review => ({
  id,
  rating: 5,
  text: 'Najlepszy fade.',
  staffId: 'st-1',
  staffName: 'Kasia',
  serviceName: 'Strzyżenie',
  appointmentId: 'a-1',
  visitStartAt: '2026-11-04T23:30:00.000Z',
  customerId: 'c-1',
  customerName: 'Anna Nowak',
  createdAt: '2026-11-05T10:00:00.000Z',
  updatedAt: '2026-11-05T10:00:00.000Z',
  ...patch,
});

describe('reviews in the business app (task 201)', () => {
  const pl = DICTIONARIES.pl;

  it('draws the stars', () => {
    expect(stars(5)).toBe('★★★★★');
    expect(stars(4)).toBe('★★★★☆');
    expect(stars(0)).toBe('☆☆☆☆☆');
    expect(stars(9)).toBe('★★★★★');
  });

  it('sums up the average with one decimal, or says there are none', () => {
    expect(reviewSummary({ count: 3, average: 4.666 }, pl, 'pl')).toBe('★ 4,7 · opinie: 3');
    expect(reviewSummary({ count: 2, average: 5 }, DICTIONARIES.en, 'en')).toBe(
      '★ 5.0 · reviews: 2',
    );
    expect(reviewSummary({ count: 0, average: null }, pl, 'pl')).toBe('Brak opinii.');
  });

  it('says who, what, with whom and the visit day in the salon’s time zone', () => {
    // 23:30 UTC on the 4th is already the 5th in Warsaw.
    expect(reviewLine(review('1'), pl, 'pl', 'Europe/Warsaw')).toBe(
      'Anna Nowak · Strzyżenie u Kasia · 5 lis 2026',
    );
    expect(reviewLine(review('2', { customerName: null }), pl, 'pl', 'UTC')).toBe(
      'Klient usunięty · Strzyżenie u Kasia · 4 lis 2026',
    );
  });

  it('adds an older page below without repeating', () => {
    const shown = [review('3'), review('2')];
    expect(appendReviews(shown, [review('2'), review('1')]).map((r) => r.id)).toEqual([
      '3',
      '2',
      '1',
    ]);
  });

  it('asks the salon’s reviews page by page', async () => {
    const page: SalonReviews = {
      enabled: true,
      count: 0,
      average: null,
      items: [],
      nextBefore: null,
    };
    const calls: string[] = [];
    const fetchFn = async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method} ${url.replace('https://api.test', '')}`);
      const body = url.endsWith('/v1/auth/refresh')
        ? {
            accessToken: 'access-1',
            expiresIn: 900,
            refreshToken: 'refresh-1-0123456789abcdefghij',
            user: {
              id: 'u1',
              email: 'k@example.com',
              name: 'K',
              locale: 'pl',
              emailVerified: true,
            },
          }
        : page;
      return new Response(JSON.stringify(body), { status: 200 });
    };
    const api = new BusinessApi(
      'https://api.test',
      memoryStore('saved-refresh-0123456789'),
      fetchFn,
    );
    expect(await api.restore()).toBe(true);
    await api.reviews('org-1', 'loc 1');
    await api.reviews('org-1', 'loc 1', 'r-9');
    expect(calls.slice(1)).toEqual([
      'GET /v1/organizations/org-1/locations/loc%201/reviews',
      'GET /v1/organizations/org-1/locations/loc%201/reviews?before=r-9',
    ]);
  });
});

function memoryStore(value: string | null): TokenStore {
  let saved = value;
  return {
    get: async () => saved,
    set: async (next: string | null) => {
      saved = next;
    },
  };
}
