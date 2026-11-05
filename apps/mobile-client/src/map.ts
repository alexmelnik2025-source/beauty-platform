/**
 * Task 160: the catalogue's map from OpenStreetMap tiles (free, no map provider, no extra
 * library). Web Mercator in pixels; no React Native here — tested with Vitest.
 */

export const TILE_SIZE = 256;

export interface MapPoint {
  latitude: number;
  longitude: number;
}

export interface MapTile {
  key: string;
  x: number;
  y: number;
  url: string;
}

export interface MapMarker<T> {
  item: T;
  x: number;
  y: number;
}

/** Web Mercator, the projection of OpenStreetMap tiles, in pixels at `zoom`. */
export function project(point: MapPoint, zoom: number): { x: number; y: number } {
  const scale = TILE_SIZE * 2 ** zoom;
  const lat = (Math.max(-85.0511, Math.min(85.0511, point.latitude)) * Math.PI) / 180;
  return {
    x: ((point.longitude + 180) / 360) * scale,
    y: ((1 - Math.asinh(Math.tan(lat)) / Math.PI) / 2) * scale,
  };
}

/**
 * The closest zoom (at most street level, 16) that shows every point inside `width` × `height`
 * with `margin` pixels free at the edges; its tiles and where each point lands. Null without points.
 */
export function mapLayout<T extends MapPoint>(
  points: T[],
  width: number,
  height: number,
  margin = 32,
): { zoom: number; tiles: MapTile[]; markers: MapMarker<T>[] } | null {
  if (points.length === 0 || width <= 0 || height <= 0) return null;
  let zoom = 0;
  for (let candidate = 16; candidate >= 0; candidate -= 1) {
    const projected = points.map((p) => project(p, candidate));
    const xs = projected.map((p) => p.x);
    const ys = projected.map((p) => p.y);
    if (
      Math.max(...xs) - Math.min(...xs) <= width - 2 * margin &&
      Math.max(...ys) - Math.min(...ys) <= height - 2 * margin
    ) {
      zoom = candidate;
      break;
    }
  }
  const projected = points.map((item) => ({ item, ...project(item, zoom) }));
  const xs = projected.map((p) => p.x);
  const ys = projected.map((p) => p.y);
  const left = (Math.min(...xs) + Math.max(...xs)) / 2 - width / 2;
  const top = (Math.min(...ys) + Math.max(...ys)) / 2 - height / 2;
  const world = 2 ** zoom;
  const tiles: MapTile[] = [];
  for (let x = Math.floor(left / TILE_SIZE); x <= Math.floor((left + width) / TILE_SIZE); x++) {
    for (let y = Math.floor(top / TILE_SIZE); y <= Math.floor((top + height) / TILE_SIZE); y++) {
      if (y < 0 || y >= world) continue;
      const wrapped = ((x % world) + world) % world;
      tiles.push({
        key: `${zoom}/${x}/${y}`,
        x: x * TILE_SIZE - left,
        y: y * TILE_SIZE - top,
        url: `https://tile.openstreetmap.org/${zoom}/${wrapped}/${y}.png`,
      });
    }
  }
  return {
    zoom,
    tiles,
    markers: projected.map(({ item, x, y }) => ({ item, x: x - left, y: y - top })),
  };
}

/** Flags and short codes of the languages on the map's chips ("🇺🇦 UA (12)"). */
export const LANGUAGE_CHIP: Record<'pl' | 'uk' | 'ru' | 'be' | 'en', string> = {
  pl: '🇵🇱 PL',
  uk: '🇺🇦 UA',
  ru: '🇷🇺 RU',
  be: '🇧🇾 BY',
  en: '🇬🇧 EN',
};
