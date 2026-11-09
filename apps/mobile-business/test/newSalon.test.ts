import { describe, expect, it } from 'vitest';
import { currencyForTimeZone, regionForTimeZone, salonZoneOf } from '../src/country';
import { emptyNewSalon, newSalonBodies, postalCodeFor, withTimeZone } from '../src/newSalon';

const filled = {
  ...emptyNewSalon('Europe/Warsaw'),
  orgName: ' GESTALT ',
  addressLine: 'ul. Józefa Bema 91',
  city: 'Warszawa',
  postalCode: '01233',
};

describe('"Załóż salon" (task 350)', () => {
  it('suggests the phone’s country and its currency', () => {
    expect(salonZoneOf('Europe/Prague')).toBe('Europe/Prague');
    expect(salonZoneOf('Europe/Kyiv')).toBe('Europe/Kiev');
    expect(salonZoneOf('America/New_York')).toBe('Europe/Warsaw');
    expect(salonZoneOf(undefined)).toBe('Europe/Warsaw');
    expect(regionForTimeZone('Europe/Kyiv')).toBe('UA');
    expect(currencyForTimeZone('Europe/Kiev')).toBe('UAH');
    expect(currencyForTimeZone('Europe/Berlin')).toBe('EUR');
    expect(emptyNewSalon('Europe/Prague')).toMatchObject({
      currency: 'CZK',
      currencyChosen: false,
    });
  });

  it('changes the currency with the country until the person picks one', () => {
    const czech = withTimeZone(emptyNewSalon('Europe/Warsaw'), 'Europe/Prague');
    expect(czech.currency).toBe('CZK');
    const chosen = { ...czech, currency: 'EUR', currencyChosen: true };
    expect(withTimeZone(chosen, 'Europe/Budapest')).toMatchObject({
      timezone: 'Europe/Budapest',
      currency: 'EUR',
    });
  });

  it('checks Polish postal codes and adds the dash', () => {
    expect(postalCodeFor('Europe/Warsaw', '01233')).toBe('01-233');
    expect(postalCodeFor('Europe/Warsaw', ' 01-233 ')).toBe('01-233');
    expect(postalCodeFor('Europe/Warsaw', '1-233')).toBeNull();
    expect(postalCodeFor('Europe/Prague', '110 00')).toBe('110 00');
    expect(postalCodeFor('Europe/Prague', '11')).toBeNull();
  });

  it('builds the company and the salon; an empty salon name is the company’s', () => {
    expect(newSalonBodies(filled, 'uk')).toEqual({
      organization: { name: 'GESTALT' },
      location: {
        name: 'GESTALT',
        addressLine: 'ul. Józefa Bema 91',
        city: 'Warszawa',
        postalCode: '01-233',
        timezone: 'Europe/Warsaw',
        currency: 'PLN',
        defaultLocale: 'uk',
      },
    });
    expect(newSalonBodies({ ...filled, locationName: 'Gestalt Bema' }, 'pl')).toMatchObject({
      location: { name: 'Gestalt Bema' },
    });
  });

  it('names the first missing field', () => {
    expect(newSalonBodies({ ...filled, orgName: ' ' }, 'pl')).toEqual({ problem: 'orgName' });
    expect(newSalonBodies({ ...filled, locationName: 'x'.repeat(101) }, 'pl')).toEqual({
      problem: 'locationName',
    });
    expect(newSalonBodies({ ...filled, addressLine: '' }, 'pl')).toEqual({ problem: 'address' });
    expect(newSalonBodies({ ...filled, city: '' }, 'pl')).toEqual({ problem: 'city' });
    expect(newSalonBodies({ ...filled, postalCode: 'abc' }, 'pl')).toEqual({
      problem: 'postalCode',
    });
  });
});
