import { describe, expect, it } from 'vitest';
import { ClientApi, type TokenStore } from '../src/api';
import { DICTIONARIES } from '../src/i18n';
import {
  appendSalonReviews,
  salonReviewLine,
  salonReviewSummary,
  staffChip,
  starText,
  type SalonReview,
} from '../src/salonReviews';

const review = (id: string, patch: Partial<SalonReview> = {}): SalonReview => ({
  id,
  rating: 5,
  text: 'Najlepszy fade.',
  staffId: 'st-1',
  staffName: 'Kasia',
  serviceName: 'Strzyżenie',
  reply: null,
  repliedAt: null,
  createdAt: '2026-11-05T10:00:00.000Z',
  ...patch,
});

describe('reviews on the salon page of the client app (task 210)', () => {
  const pl = DICTIONARIES.pl;

  it('sums up the reviews only when there are some', () => {
    expect(salonReviewSummary({ enabled: true, count: 3, average: 4.7 }, pl, 'pl')).toBe(
      '★ 4,7 · opinie: 3',
    );
    expect(
      salonReviewSummary({ enabled: true, count: 3, average: 4.7 }, DICTIONARIES.en, 'en'),
    ).toBe('★ 4.7 · reviews: 3');
    expect(salonReviewSummary({ enabled: true, count: 0, average: null }, pl, 'pl')).toBeNull();
    expect(salonReviewSummary({ enabled: false, count: 0, average: null }, pl, 'pl')).toBeNull();
  });

  it('writes the chips, the line and the stars', () => {
    expect(staffChip({ staffId: 's', displayName: 'Ilya', count: 2, average: 5 }, 'pl')).toBe(
      'Ilya ★ 5,0 (2)',
    );
    expect(salonReviewLine(review('a'), 'pl')).toBe('Kasia · Strzyżenie · 5 lis 2026');
    expect(starText(4)).toBe('★★★★☆');
    expect(starText(7)).toBe('★★★★★');
  });

  it('adds an older page below without repeating a review', () => {
    const shown = [review('c'), review('b')];
    expect(appendSalonReviews(shown, [review('b'), review('a')]).map((r) => r.id)).toEqual([
      'c',
      'b',
      'a',
    ]);
  });

  it('asks the public reviews of the salon, by specialist and page', async () => {
    const calls: string[] = [];
    const store: TokenStore = { get: async () => null, set: async () => undefined };
    const api = new ClientApi('https://api.example', store, async (url) => {
      calls.push(String(url));
      return new Response(
        JSON.stringify({
          enabled: true,
          count: 0,
          average: null,
          staff: [],
          items: [],
          nextBefore: null,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });
    await api.salonReviews('gestalt bema');
    await api.salonReviews('gestalt', { staffId: 's-1', before: 'r-9' });
    expect(calls).toEqual([
      'https://api.example/v1/public/locations/gestalt%20bema/reviews',
      'https://api.example/v1/public/locations/gestalt/reviews?staffId=s-1&before=r-9',
    ]);
  });
});
