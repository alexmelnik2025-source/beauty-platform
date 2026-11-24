import { describe, expect, it } from 'vitest';
import { mapLayout, project } from '../src/map';

describe('catalogue map (task 160)', () => {
  it('projects like OpenStreetMap tiles', () => {
    // Warsaw at zoom 10 is in tile 571/337.
    const p = project({ latitude: 52.2297, longitude: 21.0122 }, 10);
    expect(Math.floor(p.x / 256)).toBe(571);
    expect(Math.floor(p.y / 256)).toBe(337);
  });

  it('fits every salon inside the view, with a margin', () => {
    const salons = [
      { name: 'Wola', latitude: 52.2325, longitude: 20.9563 },
      { name: 'Mokotów', latitude: 52.1935, longitude: 21.0346 },
    ];
    const layout = mapLayout(salons, 360, 300, 32)!;
    expect(layout.zoom).toBeGreaterThan(8);
    for (const m of layout.markers) {
      expect(m.x).toBeGreaterThanOrEqual(32);
      expect(m.x).toBeLessThanOrEqual(360 - 32);
      expect(m.y).toBeGreaterThanOrEqual(32);
      expect(m.y).toBeLessThanOrEqual(300 - 32);
    }
    expect(layout.tiles.length).toBeGreaterThan(0);
    expect(layout.tiles[0]!.url).toMatch(
      /^https:\/\/tile\.openstreetmap\.org\/\d+\/\d+\/\d+\.png$/,
    );
  });

  it('ignores corrupt coordinates when choosing both the tiles and the markers', () => {
    const good = { latitude: 0, longitude: 0 };
    const bad = [
      null,
      { latitude: 52 },
      { latitude: '52', longitude: 21 },
      { latitude: 91, longitude: 21 },
      { latitude: 52, longitude: -181 },
      { latitude: NaN, longitude: 21 },
    ] as unknown as (typeof good)[];
    expect(mapLayout([...bad, good], 320, 300)).toEqual(mapLayout([good], 320, 300));
    expect(mapLayout(bad, 320, 300)).toEqual(mapLayout([], 320, 300));
  });

  it('keeps both pins tappable for salons at the same address', () => {
    const point = { latitude: 52.2297, longitude: 21.0122 };
    const salons = [
      { ...point, name: 'Ground floor' },
      { ...point, name: 'First floor' },
    ];
    const { markers } = mapLayout(salons, 280, 300)!;
    const [first, second] = markers;
    expect(first).toMatchObject({ item: salons[0], x: 140, y: 150 });
    expect(second?.item).toEqual(salons[1]);
    const gap = Math.max(Math.abs(first!.x - second!.x), Math.abs(first!.y - second!.y));
    expect(gap).toBeGreaterThanOrEqual(44);
  });

  it('one salon: street level, in the middle; none: no map', () => {
    const layout = mapLayout([{ latitude: 50.06, longitude: 19.94 }], 300, 200)!;
    expect(layout.zoom).toBe(16);
    expect(layout.markers[0]).toMatchObject({ x: 150, y: 100 });
    expect(mapLayout([{ latitude: 50, longitude: 19 }], 0, 200)).toBeNull();
    // Task 191: no salon on the map — the country is still shown, without markers.
    const empty = mapLayout([], 300, 200)!;
    expect(empty.zoom).toBe(6);
    expect(empty.markers).toEqual([]);
    expect(empty.tiles.length).toBeGreaterThan(0);
  });
});
