import { describe, expect, it } from 'vitest';
import { DICTIONARIES } from '../src/i18n';
import { wishLines } from '../src/wishes';

describe('visit wishes in the card (task 80)', () => {
  const v = DICTIONARIES.pl.visit;

  it('one line per answer, in the order mood, drink, note', () => {
    expect(wishLines({ mood: 'quiet', drink: 'coffee', note: 'Wrażliwa skóra głowy' }, v)).toEqual([
      '🤫 Woli ciszę',
      '☕ Kawa',
      '✍️ Wrażliwa skóra głowy',
    ]);
  });

  it('nothing answered or no wishes at all: no lines', () => {
    expect(wishLines({ mood: null, drink: null, note: null }, v)).toEqual([]);
    expect(wishLines(undefined, v)).toEqual([]);
  });
});
