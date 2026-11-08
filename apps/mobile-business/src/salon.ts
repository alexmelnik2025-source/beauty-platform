import { ApiError, type Location } from './api';
import { dialForTimeZone, normalizePhone } from './phone';
import { OFFERED_DRINKS, type OfferedDrink } from './wishes';

/**
 * "Salon" in the business app (task 131): the owner or a manager changes the salon's name,
 * address, phone, description and switches online booking on or off; task 319 adds the booking
 * rules (how early and how far ahead clients book, until when they change a visit, the step of
 * the times offered), task 320 the questions on the last booking step (mood, drink, a note),
 * task 321 the salon's place on the catalogue map.
 * No React Native here — tested in Vitest (test/salon.test.ts). The server checks the right again (owner, or the
 * salon's manager) and refuses online booking without terms and a privacy policy.
 */

export interface SalonForm {
  name: string;
  addressLine: string;
  city: string;
  postalCode: string;
  phone: string;
  description: string;
  onlineBookingEnabled: boolean;
  /** Task 319, "Zasady rezerwacji" — typed by the person, checked on save. */
  minLeadMinutes: string;
  bookingHorizonDays: string;
  clientCancelDeadlineMinutes: string;
  slotStepMinutes: number;
  /** Task 320, "Pytania przy rezerwacji" — the questions on the last booking step. */
  askMood: boolean;
  askDrink: boolean;
  drinks: OfferedDrink[];
  askNote: boolean;
  /** Task 321, "Miejsce na mapie katalogu": "52.23251, 20.95634" as Google Maps gives it. */
  coordinates: string;
}

/** Task 319: the steps the booking page offers times in — the server allows only these. */
export const SLOT_STEPS = [5, 10, 15, 30] as const;
/** A week in minutes: the most the server allows for the lead time and the change deadline. */
const WEEK_MINUTES = 7 * 24 * 60;

/** What the form starts with: the salon as the server has it. */
export function salonForm(location: Location): SalonForm {
  return {
    name: location.name,
    addressLine: location.addressLine,
    city: location.city,
    postalCode: location.postalCode,
    phone: location.phone ?? '',
    description: location.description ?? '',
    onlineBookingEnabled: location.onlineBookingEnabled,
    minLeadMinutes: String(location.minLeadMinutes),
    bookingHorizonDays: String(location.bookingHorizonDays),
    clientCancelDeadlineMinutes: String(location.clientCancelDeadlineMinutes),
    slotStepMinutes: location.slotStepMinutes,
    askMood: location.askMood,
    askDrink: location.askDrink,
    drinks: [...location.drinks],
    askNote: location.askNote,
    coordinates: formatCoordinates(location.latitude, location.longitude),
  };
}

export type SalonProblem =
  | 'name'
  | 'address'
  | 'city'
  | 'postalCode'
  | 'phone'
  | 'lead'
  | 'horizon'
  | 'deadline'
  | 'coordinates';

export interface SalonChanges {
  name?: string;
  addressLine?: string;
  city?: string;
  postalCode?: string;
  phone?: string | null;
  description?: string;
  onlineBookingEnabled?: boolean;
  minLeadMinutes?: number;
  bookingHorizonDays?: number;
  clientCancelDeadlineMinutes?: number;
  slotStepMinutes?: number;
  askMood?: boolean;
  askDrink?: boolean;
  drinks?: OfferedDrink[];
  askNote?: boolean;
  latitude?: number | null;
  longitude?: number | null;
}

/** Task 321: the salon's place as one line of text; empty when it has none. */
export function formatCoordinates(latitude: number | null, longitude: number | null): string {
  return latitude === null || longitude === null ? '' : `${latitude}, ${longitude}`;
}

/** Task 321: null = empty (not on the map); 'invalid' = not two numbers in range. */
export function parseCoordinates(
  text: string,
): { latitude: number; longitude: number } | null | 'invalid' {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const parts = trimmed.split(/[\s,;]+/).filter(Boolean);
  if (parts.length !== 2) return 'invalid';
  const [latitude, longitude] = parts.map(Number) as [number, number];
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return 'invalid';
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return 'invalid';
  return { latitude, longitude };
}

/** Task 320: a drink ticked or unticked; the list keeps the order the salon sees it in. */
export function toggleDrink(drinks: OfferedDrink[], drink: OfferedDrink): OfferedDrink[] {
  return drinks.includes(drink)
    ? drinks.filter((d) => d !== drink)
    : OFFERED_DRINKS.filter((d) => d === drink || drinks.includes(d));
}

/** A whole number typed by the person within [min, max], or null. */
function whole(typed: string, min: number, max: number): number | null {
  const text = typed.trim();
  if (!/^\d{1,6}$/.test(text)) return null;
  const value = Number(text);
  return value >= min && value <= max ? value : null;
}

/**
 * Only what changed, checked as the server checks it. A phone typed without a country code
 * gets the salon's (by its time zone); an empty phone removes it, an empty description too.
 */
export function salonChanges(
  location: Location,
  form: SalonForm,
): { changes: SalonChanges } | { problem: SalonProblem } {
  const name = form.name.trim();
  const addressLine = form.addressLine.trim();
  const city = form.city.trim();
  const postalCode = form.postalCode.trim();
  if (!name || name.length > 100) return { problem: 'name' };
  if (!addressLine || addressLine.length > 200) return { problem: 'address' };
  if (!city || city.length > 100) return { problem: 'city' };
  if (postalCode.length < 3 || postalCode.length > 12) return { problem: 'postalCode' };
  const typed = form.phone.trim();
  const phone = typed ? normalizePhone(typed, dialForTimeZone(location.timezone)) : null;
  if (phone !== null && !/^\+[1-9]\d{6,14}$/.test(phone)) return { problem: 'phone' };
  const description = form.description.trim().slice(0, 1000);
  const minLeadMinutes = whole(form.minLeadMinutes, 0, WEEK_MINUTES);
  if (minLeadMinutes === null) return { problem: 'lead' };
  const bookingHorizonDays = whole(form.bookingHorizonDays, 1, 365);
  if (bookingHorizonDays === null) return { problem: 'horizon' };
  const clientCancelDeadlineMinutes = whole(form.clientCancelDeadlineMinutes, 0, WEEK_MINUTES);
  if (clientCancelDeadlineMinutes === null) return { problem: 'deadline' };
  const point = parseCoordinates(form.coordinates);
  if (point === 'invalid') return { problem: 'coordinates' };

  const changes: SalonChanges = {};
  if (name !== location.name) changes.name = name;
  if (addressLine !== location.addressLine) changes.addressLine = addressLine;
  if (city !== location.city) changes.city = city;
  if (postalCode !== location.postalCode) changes.postalCode = postalCode;
  if (phone !== location.phone) changes.phone = phone;
  if (description !== (location.description ?? '')) changes.description = description;
  if (form.onlineBookingEnabled !== location.onlineBookingEnabled) {
    changes.onlineBookingEnabled = form.onlineBookingEnabled;
  }
  if (minLeadMinutes !== location.minLeadMinutes) changes.minLeadMinutes = minLeadMinutes;
  if (bookingHorizonDays !== location.bookingHorizonDays) {
    changes.bookingHorizonDays = bookingHorizonDays;
  }
  if (clientCancelDeadlineMinutes !== location.clientCancelDeadlineMinutes) {
    changes.clientCancelDeadlineMinutes = clientCancelDeadlineMinutes;
  }
  if (form.slotStepMinutes !== location.slotStepMinutes) {
    changes.slotStepMinutes = form.slotStepMinutes;
  }
  if (form.askMood !== location.askMood) changes.askMood = form.askMood;
  if (form.askDrink !== location.askDrink) changes.askDrink = form.askDrink;
  if (form.askNote !== location.askNote) changes.askNote = form.askNote;
  const same = (a: readonly string[], b: readonly string[]) =>
    a.length === b.length && a.every((d) => b.includes(d));
  if (!same(form.drinks, location.drinks)) changes.drinks = form.drinks;
  const latitude = point?.latitude ?? null;
  const longitude = point?.longitude ?? null;
  if (latitude !== location.latitude || longitude !== location.longitude) {
    changes.latitude = latitude;
    changes.longitude = longitude;
  }
  return { changes };
}

export type SaveProblem = 'legalTexts' | 'changedMeanwhile' | 'other';

/** Why the server refused to save, when the person can do something about it. */
export function saveProblem(error: unknown): SaveProblem {
  if (error instanceof ApiError) {
    if (error.code === 'LEGAL_TEXTS_REQUIRED') return 'legalTexts';
    if (error.code === 'VERSION_CONFLICT') return 'changedMeanwhile';
  }
  return 'other';
}

/** Only the owner and managers see the salon's settings; specialists do not. */
export function maySeeSalon(role: string): boolean {
  return role === 'owner' || role === 'manager';
}
