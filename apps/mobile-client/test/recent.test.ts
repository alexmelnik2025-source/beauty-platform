import { describe, expect, it } from 'vitest';
import { parseRecent, RECENT_MAX, rememberViewed } from '../src/recent';

describe('"Ostatnio oglądane" (task 402)', () => {
  it('puts the salon first, moves it up when it was there, keeps at most five', () => {
    let list = rememberViewed([], { slug: 'a', name: 'A' });
    list = rememberViewed(list, { slug: 'b', name: 'B' });
    expect(list.map((s) => s.slug)).toEqual(['b', 'a']);
    list = rememberViewed(list, { slug: 'a', name: 'A (new name)' });
    expect(list).toEqual([
      { slug: 'a', name: 'A (new name)' },
      { slug: 'b', name: 'B' },
    ]);
    for (const slug of ['c', 'd', 'e', 'f']) list = rememberViewed(list, { slug, name: slug });
    expect(list.map((s) => s.slug)).toEqual(['f', 'e', 'd', 'c', 'a']);
    expect(list).toHaveLength(RECENT_MAX);
  });

  it('reads only well-formed entries from storage', () => {
    expect(parseRecent(null)).toEqual([]);
    expect(parseRecent('not json')).toEqual([]);
    expect(parseRecent('{"slug":"a"}')).toEqual([]);
    expect(
      parseRecent(
        JSON.stringify([
          { slug: 'a', name: 'A', extra: 1 },
          { slug: '', name: 'empty' },
          { slug: 'b' },
          'c',
          null,
        ]),
      ),
    ).toEqual([{ slug: 'a', name: 'A' }]);
  });
});
