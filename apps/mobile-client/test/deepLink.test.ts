import { describe, expect, it, vi } from 'vitest';
import { parseDeepLink } from '../src/deepLink';

vi.mock('../src/config', () => ({ WEB_URL: 'https://app.example.com' }));

const SERVICE = '0f8fad5b-d9cb-469f-a165-70867728950e';
const STAFF = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

describe('links that open the app at a salon (task Q2)', () => {
  it('reads the app’s own scheme with the service and specialist', () => {
    expect(
      parseDeepLink(`beauty-client://b/gestalt-barbershop?service=${SERVICE}&staff=${STAFF}`),
    ).toEqual({ slug: 'gestalt-barbershop', preset: { serviceId: SERVICE, staffId: STAFF } });
  });

  it('opens the salon’s page when there is no service', () => {
    expect(parseDeepLink('beauty-client://b/gestalt-barbershop')).toEqual({
      slug: 'gestalt-barbershop',
    });
  });

  it('a specialist’s QR code (only who) starts the booking with that specialist (task Q2)', () => {
    expect(parseDeepLink(`beauty-client://b/gestalt-barbershop?staff=${STAFF}`)).toEqual({
      slug: 'gestalt-barbershop',
      preset: { staffId: STAFF },
    });
    expect(
      parseDeepLink(`https://app.example.com/s/gestalt-barbershop?utm_source=qr&staff=${STAFF}`),
    ).toEqual({ slug: 'gestalt-barbershop', preset: { staffId: STAFF } });
  });

  it('reads the booking page and the short link of the web app', () => {
    expect(
      parseDeepLink(`https://app.example.com/pl/b/gestalt-barbershop?service=${SERVICE}`),
    ).toEqual({
      slug: 'gestalt-barbershop',
      preset: { serviceId: SERVICE },
    });
    expect(parseDeepLink('https://app.example.com/uk/b/kyiv-barber')).toEqual({
      slug: 'kyiv-barber',
    });
    expect(parseDeepLink('https://app.example.com/s/Gestalt-Barbershop?utm_source=qr')).toEqual({
      slug: 'gestalt-barbershop',
    });
  });

  it('decodes the slug and preset once and ignores unrelated query parameters and the fragment', () => {
    expect(
      parseDeepLink(
        `https://app.example.com/pl/b/%4C%6Fdz%2Dbarber?from=qr&service=${SERVICE.replaceAll('-', '%2D')}&campaign=salon#visits`,
      ),
    ).toEqual({
      slug: 'lodz-barber',
      preset: { serviceId: SERVICE },
    });
  });

  it.each([
    'https://app.example.com/pl/b/Łódź',
    'https://app.example.com/pl/b/%C5%81%C3%B3d%C5%BA',
    'https://app.example.com/pl/b/lodz%2Fbarber',
    'https://app.example.com/pl/b/lodz%252Dbarber',
    'https://app.example.com/zz/b/lodz',
  ])('ignores a link outside the supported booking routes: %s', (url) => {
    expect(parseDeepLink(url)).toBeNull();
  });

  it('reads Expo Go links while developing', () => {
    expect(
      parseDeepLink(`exp://192.168.0.5:8081/--/b/gestalt-barbershop?service=${SERVICE}`),
    ).toEqual({
      slug: 'gestalt-barbershop',
      preset: { serviceId: SERVICE },
    });
  });

  it('ignores anything else', () => {
    for (const url of [
      null,
      undefined,
      '',
      'beauty-client://',
      'beauty-client://visits',
      'https://app.example.com/pl/salons',
      'https://app.example.com/pl/b/',
      'https://app.example.com/pl/b/salon/extra',
      'beauty-client://b/not%20a%20slug',
      `beauty-client://b/${'x'.repeat(81)}`,
      'not a link',
    ]) {
      expect(parseDeepLink(url), String(url)).toBeNull();
    }
  });

  it.each([
    'other-app://b/gestalt',
    'https://other.example/pl/b/gestalt',
    'https://app.example.com:8443/s/gestalt',
    'https:///pl/b/gestalt',
    'https://app.example.com/pl/b/%E0%A4',
    'https://app.example.com/archive/--/b/gestalt',
    'beauty-client://b//gestalt',
  ])('ignores a foreign or malformed salon link: %s', (url) => {
    expect(parseDeepLink(url)).toBeNull();
  });

  it('accepts a booking link opened directly on the web preview', () => {
    vi.stubGlobal('window', { location: new URL('http://localhost:8081/') });
    try {
      expect(parseDeepLink('http://localhost:8081/pl/b/gestalt')).toEqual({ slug: 'gestalt' });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('drops a malformed service ID while keeping a valid specialist', () => {
    const badId = 'a'.repeat(36);
    expect(parseDeepLink(`beauty-client://b/gestalt?service=${badId}&staff=${STAFF}`)).toEqual({
      slug: 'gestalt',
      preset: { staffId: STAFF },
    });
  });

  it('drops a service or specialist that is not an id', () => {
    expect(parseDeepLink('beauty-client://b/gestalt?service=<script>&staff=1')).toEqual({
      slug: 'gestalt',
    });
    expect(parseDeepLink(`beauty-client://b/gestalt?service=${SERVICE}&staff=nope`)).toEqual({
      slug: 'gestalt',
      preset: { serviceId: SERVICE },
    });
  });
});
