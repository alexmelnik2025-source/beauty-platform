/**
 * Salon coordinates for the catalogue map, as Google Maps copies them
 * (right click on the place → the first line, e.g. "52.23251, 20.95634").
 */
export interface Coordinates {
  latitude: number;
  longitude: number;
}

export function formatCoordinates(latitude: number | null, longitude: number | null): string {
  return latitude === null || longitude === null ? '' : `${latitude}, ${longitude}`;
}

/** null = empty (no point on the map); 'invalid' = not two numbers in range. */
export function parseCoordinates(text: string): Coordinates | null | 'invalid' {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const parts = trimmed.split(/[\s,;]+/).filter(Boolean);
  if (parts.length !== 2) return 'invalid';
  const [latitude, longitude] = parts.map(Number) as [number, number];
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return 'invalid';
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return 'invalid';
  return { latitude, longitude };
}
