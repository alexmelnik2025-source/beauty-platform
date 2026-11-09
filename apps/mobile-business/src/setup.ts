import type { Location, ServiceList, StaffList, WorkingHours } from './api';

/**
 * "Pierwsze kroki" in the business app (task 352): what a new salon still needs before clients can
 * book it online — a service, a specialist who does it, that specialist's hours, the booking terms
 * and privacy policy, and online booking switched on. Shown to the owner and managers on the day
 * screen until everything is done; each open step has a button to the screen where it is done.
 * No React Native here — tested in Vitest (test/setup.test.ts). Only reads; the server already
 * refuses online booking without the texts.
 */

export const SETUP_STEPS = ['services', 'team', 'hours', 'legal', 'online'] as const;
export type SetupStep = (typeof SETUP_STEPS)[number];

/** Active specialists who do at least one active service — the ones clients can book. */
export function bookableStaff(services: ServiceList, staff: StaffList): StaffList {
  const active = new Set(services.filter((s) => s.active).map((s) => s.id));
  return staff.filter((s) => s.active && s.serviceIds.some((id) => active.has(id)));
}

/** Weekly hours on at least one day. Special days alone do not make a schedule. */
export function hasWeeklyHours(hours: Pick<WorkingHours, 'weekly'>): boolean {
  return hours.weekly.some((day) => day.intervals.length > 0);
}

export function setupState(input: {
  location: Pick<Location, 'bookingTerms' | 'privacyPolicy' | 'onlineBookingEnabled'>;
  services: ServiceList;
  staff: StaffList;
  /** Whether a bookable specialist has weekly hours (false when nobody is bookable). */
  hoursSet: boolean;
}): { step: SetupStep; done: boolean }[] {
  const done: Record<SetupStep, boolean> = {
    services: input.services.some((s) => s.active),
    team: bookableStaff(input.services, input.staff).length > 0,
    hours: input.hoursSet,
    legal: !!input.location.bookingTerms?.trim() && !!input.location.privacyPolicy?.trim(),
    online: input.location.onlineBookingEnabled,
  };
  return SETUP_STEPS.map((step) => ({ step, done: done[step] }));
}

/** The card is shown while a step is open. */
export function setupFinished(steps: { done: boolean }[]): boolean {
  return steps.every((s) => s.done);
}
