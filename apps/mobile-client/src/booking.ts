import { ApiError, parseEmail, type BookingContact, type PublicLocation, type Slot } from './api';
import { normalizePhone } from './phone';

/**
 * Booking in the app (service → specialist → time → details → code), the same steps and rules
 * as the web booking page. No React Native here — tested in Vitest (test/booking.test.ts).
 */

export type BookingStep = 'service' | 'staff' | 'time' | 'details' | 'code' | 'done';

/** The booking shows free times this many days ahead (as on the web). */
export const BOOKING_DAYS = 21;

/** The form as the client typed it. */
export interface ContactForm {
  name: string;
  phone: string;
  email: string;
  acceptTerms: boolean;
  marketingConsent: boolean;
}

export type ContactProblem = 'name' | 'phone' | 'email' | 'terms';

/** The details ready to send, or the first thing to fix (checked before asking the server). */
export function checkContact(
  form: ContactForm,
  /** The salon's country code, for a number typed without one. */
  dial = '48',
): { ok: true; contact: BookingContact } | { ok: false; problem: ContactProblem } {
  const name = form.name.trim().replace(/\s+/g, ' ');
  if (name.length < 2) return { ok: false, problem: 'name' };
  const phone = normalizePhone(form.phone, dial);
  if (!/^\+\d{8,15}$/.test(phone)) return { ok: false, problem: 'phone' };
  const email = parseEmail(form.email);
  if (!email) return { ok: false, problem: 'email' };
  if (!form.acceptTerms) return { ok: false, problem: 'terms' };
  return {
    ok: true,
    contact: { name, phone, email, acceptTerms: true, marketingConsent: form.marketingConsent },
  };
}

/** Specialists who do this service (the "any specialist" choice comes first on the screen). */
export function staffFor(salon: PublicLocation, serviceId: string): PublicLocation['staff'] {
  return salon.staff.filter((s) => s.serviceIds.includes(serviceId));
}

/** "Book again" / "Book" from a loyalty card: start with this service and specialist. */
export interface BookingPreset {
  serviceId: string;
  staffId?: string | null;
}

/**
 * Where the booking starts. With a preset: the free times of the same specialist, or the
 * choice of specialist when that one no longer does the service (`staffGone`), or the price
 * list when the salon no longer takes the service online (`serviceGone`).
 */
export function bookingStart(
  salon: PublicLocation,
  preset?: BookingPreset,
): {
  step: BookingStep;
  serviceId: string;
  staffId?: string;
  gone?: 'service' | 'staff';
} {
  if (!preset) return { step: 'service', serviceId: '' };
  if (!salon.services.some((s) => s.id === preset.serviceId)) {
    return { step: 'service', serviceId: '', gone: 'service' };
  }
  const who = staffFor(salon, preset.serviceId);
  if (preset.staffId && who.some((s) => s.id === preset.staffId)) {
    return { step: 'time', serviceId: preset.serviceId, staffId: preset.staffId };
  }
  // With one specialist there is nothing to choose (as when the client taps the service).
  const gone = preset.staffId ? ('staff' as const) : undefined;
  if (who.length === 1) {
    return {
      step: 'time',
      serviceId: preset.serviceId,
      staffId: who[0]!.id,
      ...(gone && { gone }),
    };
  }
  return { step: 'staff', serviceId: preset.serviceId, ...(gone && { gone }) };
}

/** Morning (before 12), afternoon (12–17) and evening, without empty parts. */
export function dayParts(
  slots: Slot[],
): { part: 'morning' | 'afternoon' | 'evening'; slots: Slot[] }[] {
  const minutes = (s: Slot) => {
    const [h, m] = s.time.split(':').map(Number) as [number, number];
    return h * 60 + m;
  };
  return [
    { part: 'morning' as const, slots: slots.filter((s) => minutes(s) < 12 * 60) },
    {
      part: 'afternoon' as const,
      slots: slots.filter((s) => minutes(s) >= 12 * 60 && minutes(s) < 17 * 60),
    },
    { part: 'evening' as const, slots: slots.filter((s) => minutes(s) >= 17 * 60) },
  ].filter((p) => p.slots.length > 0);
}

/**
 * What the screen does after an error: back to the times (the held time is gone or no more
 * codes can be sent), fresh times (the time was taken), or stay and show the message.
 */
export function afterBookingError(error: unknown): 'pickTimeAgain' | 'reloadTimes' | 'stay' {
  if (!(error instanceof ApiError)) return 'stay';
  if (error.code === 'SLOT_TAKEN') return 'reloadTimes';
  if (
    error.code &&
    ['HOLD_EXPIRED', 'TOO_MANY_ATTEMPTS', 'TOO_MANY_CODES', 'NOT_FOUND'].includes(error.code)
  ) {
    return 'pickTimeAgain';
  }
  return 'stay';
}

/** "4:59" left of the 10 minutes a time is held. */
export function countdown(expiresAt: string, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.floor((Date.parse(expiresAt) - now) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/** The web page to change or cancel the visit (the link from the confirmation email). */
export function manageUrl(webUrl: string, locale: string, manageToken: string): string {
  return `${webUrl.replace(/\/+$/, '')}/${locale}/m/${encodeURIComponent(manageToken)}`;
}

/** The salon's booking terms or privacy policy on the web (linked from the consent checkbox). */
export function legalUrl(
  webUrl: string,
  locale: string,
  slug: string,
  doc: 'terms' | 'privacy',
): string {
  const page = doc === 'terms' ? 'regulamin' : 'privacy';
  return `${webUrl.replace(/\/+$/, '')}/${locale}/b/${encodeURIComponent(slug)}/${page}`;
}
