import { describe, expect, it, vi } from 'vitest';
import { parseDeepLink } from '../src/deepLink';
import { FALLBACK_ZOOM, mapLayout } from '../src/map';
import { encodeQr } from '../src/qr';
import { addressText, directionsUrl } from '../src/salon';
import { shareMessage, shareSalon } from '../src/share';

vi.mock('../src/config', () => ({ WEB_URL: 'https://booking.example' }));

const service = '0f8fad5b-d9cb-469f-a165-70867728950e';
const staff = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

describe('booking links', () => {
  it.each([
    'https://booking.example.net/pl/b/studio',
    'http://booking.example/pl/b/studio',
    'beauty-client:///b/?service=',
    'https://booking.example/pl/b/%C5',
    'exp://localhost:8081/b/studio',
  ])('ignores a foreign or incomplete booking route (%s)', (url) => {
    expect(parseDeepLink(url)).toBeNull();
  });

  it('opens the Expo Go route after the project path', () => {
    expect(parseDeepLink('exp://localhost:8081/project/--/b/studio')).toEqual({ slug: 'studio' });
  });

  it('reads the service, ignoring a truncated specialist ID and parameters inside tracking values or fragments', () => {
    const url = new URL('https://booking.example/ru/b/studio');
    url.searchParams.set('campaign', 'flyer&staff=' + staff);
    url.searchParams.set('service', service);
    url.searchParams.set('staff', staff.slice(0, -1));
    url.hash = 'staff=' + staff;
    expect(parseDeepLink(url.href)).toEqual({ slug: 'studio', preset: { serviceId: service } });
  });
});

describe('the catalogue map and directions', () => {
  const salon = { name: 'Łódź & Co #1', addressLine: '', postalCode: '', city: '' };

  it('keeps an addressless salon with coordinates on the map, including at the latitude and longitude limits', () => {
    const located = { ...salon, latitude: -90, longitude: 180 };
    const invalid = [
      { ...located, longitude: 180.01 },
      { ...located, latitude: -90.01 },
      { ...located, latitude: NaN },
      { ...located, longitude: Infinity },
    ];
    const layout = mapLayout([located, ...invalid], 320, 260);
    expect(layout?.markers).toEqual([{ item: located, x: 160, y: 130 }]);
    expect(layout?.tiles.length).toBeGreaterThan(0);

    for (const points of [[], invalid]) {
      const empty = mapLayout(points, 320, 260);
      expect(empty).toMatchObject({ zoom: FALLBACK_ZOOM, markers: [] });
      expect(empty?.tiles.length).toBeGreaterThan(0);
    }
  });

  it.each([
    [NaN, 260],
    [320, NaN],
  ])('waits for a usable map size (%s × %s)', (width, height) => {
    expect(mapLayout([], width, height)).toBeNull();
  });

  it.each([
    ['', '', '', ''],
    ['  ', '', 'Łódź', 'Łódź'],
    ['ul. Łąkowa 8', '', '', 'ul. Łąkowa 8'],
  ])(
    'uses only the available address fields for directions',
    (addressLine, postalCode, city, address) => {
      const place = { ...salon, addressLine, postalCode, city };
      expect(addressText(place)).toBe(address);
      const expected = address ? salon.name + ', ' + address : salon.name;
      expect(new URL(directionsUrl(place, 'ios')).searchParams.get('daddr')).toBe(expected);
      expect(new URL(directionsUrl(place, 'android')).searchParams.get('destination')).toBe(
        expected,
      );
    },
  );
});

describe('sharing a booking link', () => {
  it('switches to the longer QR byte count at the version 9 limit', () => {
    const text = '💈'.repeat(45); // 180 UTF-8 bytes, the maximum for version 9 at level M.
    expect(encodeQr(text)).toMatchObject({ version: 9, size: 53 });
    expect(encodeQr(text + 'a')).toMatchObject({ version: 10, size: 57 });
  });

  it('reports a failed fallback to the clipboard and shares normally on the next attempt', async () => {
    const url = 'https://booking.example/s/studio?utm_source=qr';
    const content = shareMessage('{name} — {url}', 'Studio', url);
    const webShare = vi
      .fn()
      .mockRejectedValueOnce(new Error('Unavailable'))
      .mockResolvedValue(undefined);
    const copy = vi.fn().mockRejectedValue(new Error('Permission denied'));
    await expect(shareSalon(content, { webShare, copy })).resolves.toBe('failed');
    await expect(shareSalon(content, { webShare, copy })).resolves.toBe('shared');
    expect(copy).toHaveBeenCalledExactlyOnceWith(url);
  });
});
