import { describe, expect, it } from 'vitest';
import { parseDeepLink } from '../src/deepLink';

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
    expect(parseDeepLink(`beauty-client://b/gestalt-barbershop?staff=${STAFF}`)).toEqual({
      slug: 'gestalt-barbershop',
    });
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
