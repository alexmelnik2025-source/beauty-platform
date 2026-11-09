import type { Locale } from './api';
import { currencyForTimeZone, regionForTimeZone } from './country';

/**
 * "Załóż salon" in the business app (task 350): a person who signed in but has no salon yet (they
 * registered on the website and skipped its first step) creates the company and its salon right
 * in the app — as the cabinet's "Załóż salon" (onboarding) does. The country (time zone) of the
 * phone is suggested and suggests the currency until the person picks one. Online booking stays
 * off until the salon adds its terms and privacy policy. No React Native here — tested in Vitest
 * (test/newSalon.test.ts); the server checks everything again.
 */

export interface NewSalonForm {
  orgName: string;
  /** Empty = the company's name. */
  locationName: string;
  addressLine: string;
  city: string;
  postalCode: string;
  timezone: string;
  currency: string;
  /** False until the person picks a currency; until then the country suggests it. */
  currencyChosen: boolean;
}

export type NewSalonProblem = 'orgName' | 'locationName' | 'address' | 'city' | 'postalCode';

export interface NewLocationBody {
  name: string;
  addressLine: string;
  city: string;
  postalCode: string;
  timezone: string;
  currency: string;
  defaultLocale: Locale;
}

export function emptyNewSalon(timezone: string): NewSalonForm {
  return {
    orgName: '',
    locationName: '',
    addressLine: '',
    city: '',
    postalCode: '',
    timezone,
    currency: currencyForTimeZone(timezone),
    currencyChosen: false,
  };
}

/** Another country: its currency too, unless the person already picked one. */
export function withTimeZone(form: NewSalonForm, timezone: string): NewSalonForm {
  return {
    ...form,
    timezone,
    currency: form.currencyChosen ? form.currency : currencyForTimeZone(timezone),
  };
}

/** Polish postal codes are "00-000"; "00000" becomes "00-000". Other countries: as typed. */
export function postalCodeFor(timezone: string, typed: string): string | null {
  const code = typed.trim();
  if (regionForTimeZone(timezone) === 'PL') {
    const digits = /^(\d{2})-?(\d{3})$/.exec(code);
    return digits ? `${digits[1]}-${digits[2]}` : null;
  }
  return code.length >= 3 && code.length <= 12 ? code : null;
}

/** The two requests' bodies, checked as the server checks them; messages go in `locale`. */
export function newSalonBodies(
  form: NewSalonForm,
  locale: Locale,
): { organization: { name: string }; location: NewLocationBody } | { problem: NewSalonProblem } {
  const orgName = form.orgName.trim();
  const locationName = form.locationName.trim() || orgName;
  const addressLine = form.addressLine.trim();
  const city = form.city.trim();
  if (!orgName || orgName.length > 120) return { problem: 'orgName' };
  if (locationName.length > 100) return { problem: 'locationName' };
  if (!addressLine || addressLine.length > 200) return { problem: 'address' };
  if (!city || city.length > 100) return { problem: 'city' };
  const postalCode = postalCodeFor(form.timezone, form.postalCode);
  if (postalCode === null) return { problem: 'postalCode' };
  return {
    organization: { name: orgName },
    location: {
      name: locationName,
      addressLine,
      city,
      postalCode,
      timezone: form.timezone,
      currency: form.currency,
      defaultLocale: locale,
    },
  };
}
