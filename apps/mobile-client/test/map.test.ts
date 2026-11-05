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

  it('one salon: street level, in the middle; none: no map', () => {
    const layout = mapLayout([{ latitude: 50.06, longitude: 19.94 }], 300, 200)!;
    expect(layout.zoom).toBe(16);
    expect(layout.markers[0]).toMatchObject({ x: 150, y: 100 });
    expect(mapLayout([], 300, 200)).toBeNull();
  });
});
