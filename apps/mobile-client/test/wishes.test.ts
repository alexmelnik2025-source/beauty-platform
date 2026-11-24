import { describe, expect, it } from 'vitest';
import { MAX_WISH_PHOTOS } from '../src/api';
import { DICTIONARIES } from '../src/i18n';
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
  it('gives the same three-photo limit before selection and when the limit is reached', () => {
    expect(MAX_WISH_PHOTOS).toBe(3);
    const limit = new RegExp(`\\b${MAX_WISH_PHOTOS}\\b`);
    for (const { wishStep } of Object.values(DICTIONARIES)) {
      expect(wishStep.photosLead).toMatch(limit);
      expect(wishStep.photosTooMany).toMatch(limit);
    }
  });

  it('uses the uploaded blob format when the picker reports an unsupported type', () => {
    expect(photoType('image/heic', 'image/png')).toBe('image/png');
  });

  it('keeps the types the API takes and sends anything else as JPEG', () => {
    expect(photoType('image/png', '')).toBe('image/png');
    expect(photoType(undefined, 'image/webp')).toBe('image/webp');
    expect(photoType('IMAGE/JPEG', '')).toBe('image/jpeg');
    expect(photoType('image/heic', 'image/heic')).toBe('image/jpeg');
    expect(photoType(null, '')).toBe('image/jpeg');
  });
});
