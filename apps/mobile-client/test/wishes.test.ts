import { describe, expect, it } from 'vitest';
import { asksWishes, drinkChoices, NO_WISHES, photoType, wishesToSend } from '../src/wishes';

/** Task 80e: the client's wishes in the app. */
describe('visit wishes', () => {
  const all = {
    mood: true,
    drinks: ['coffee', 'tea'] as ('coffee' | 'tea' | 'water')[],
    note: true,
  };

  it('asks only when the salon asks something', () => {
    expect(asksWishes(all)).toBe(true);
    expect(asksWishes({ mood: false, drinks: [], note: false })).toBe(false);
    expect(asksWishes(null)).toBe(false);
  });

  it('offers the salon drinks and "nothing"', () => {
    expect(drinkChoices(all)).toEqual(['coffee', 'tea', 'none']);
    expect(drinkChoices({ ...all, drinks: [] })).toEqual([]);
  });

  it('sends only the questions asked, with the note trimmed', () => {
    const wishes = { mood: 'quiet' as const, drink: 'water' as const, note: '  Wrażliwa skóra  ' };
    expect(wishesToSend(wishes, all)).toEqual({
      mood: 'quiet',
      drink: null, // water is not offered here
      note: 'Wrażliwa skóra',
    });
    expect(wishesToSend(wishes, { mood: false, drinks: [], note: false })).toEqual(NO_WISHES);
    expect(wishesToSend({ ...NO_WISHES, note: '   ' }, all).note).toBeNull();
    expect(wishesToSend({ ...NO_WISHES, note: 'x'.repeat(250) }, all).note).toHaveLength(200);
  });
});

/** Task 80f: example photos from the phone's gallery. */
describe('photoType', () => {
  it('keeps the types the API takes and sends anything else as JPEG', () => {
    expect(photoType('image/png', '')).toBe('image/png');
    expect(photoType(undefined, 'image/webp')).toBe('image/webp');
    expect(photoType('IMAGE/JPEG', '')).toBe('image/jpeg');
    expect(photoType('image/heic', 'image/heic')).toBe('image/jpeg');
    expect(photoType(null, '')).toBe('image/jpeg');
  });
});
