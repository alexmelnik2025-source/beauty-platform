import { describe, expect, it } from 'vitest';
import { formatKm, ratingText } from '../src/format';
import { locate } from '../src/location';

describe('near me (task 180b)', () => {
  it('gives the place, or null without geolocation, on refusal or an error', async () => {
    const ok = {
      getCurrentPosition: (
        done: (p: { coords: { latitude: number; longitude: number } }) => void,
      ) => done({ coords: { latitude: 52.23, longitude: 21.01 } }),
    };
    expect(await locate(ok)).toEqual({ latitude: 52.23, longitude: 21.01 });
    expect(await locate(undefined)).toBeNull();
    const refused = {
      getCurrentPosition: (_ok: unknown, fail: (e: unknown) => void) => fail({ code: 1 }),
    };
    expect(await locate(refused)).toBeNull();
    const broken = {
      getCurrentPosition: () => {
        throw new Error('no permission API');
      },
    };
    expect(await locate(broken)).toBeNull();
  });

  it('writes kilometres and stars the way the language does', () => {
    expect(formatKm(1.2, 'pl')).toBe('1,2');
    expect(formatKm(0, 'en')).toBe('0.0');
    expect(formatKm(253.4, 'pl')).toBe('253');
    expect(ratingText({ rating: 4.5, reviewCount: 2 }, '★ {rating} · opinie: {n}', 'pl')).toBe(
      '★ 4,5 · opinie: 2',
    );
    expect(ratingText({ rating: 5, reviewCount: 1 }, '★ {rating} · reviews: {n}', 'en')).toBe(
      '★ 5.0 · reviews: 1',
    );
    expect(ratingText({ rating: null, reviewCount: 0 }, '★ {rating}', 'pl')).toBeNull();
  });
});
