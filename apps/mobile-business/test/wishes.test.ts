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
    expect(wishLines(null, v)).toEqual([]);
    expect(wishLines({ mood: null, drink: null, note: ' \t\n' }, v)).toEqual([]);
  });

  it.each([
    ['{}', []],
    ['{"mood":"unknown","drink":"tea","note":42}', ['🍵 Herbata']],
    ['{"mood":"quiet","drink":["coffee"],"note":{}}', ['🤫 Woli ciszę']],
    ['{"mood":"constructor","drink":"__proto__","note":"OK"}', ['✍️ OK']],
  ] as const)('keeps only valid answers from the response %s', (json, expected) => {
    expect(wishLines(JSON.parse(json), v)).toEqual(expected);
  });

  it('preserves a long multiline note exactly as entered', () => {
    const note = 'Zażółć 🪮\n'.repeat(1024) + 'koniec.';
    expect(wishLines({ mood: null, drink: 'none', note }, v)).toEqual([
      `🙅 ${v.drink.none}`,
      `✍️ ${note}`,
    ]);
  });
});
