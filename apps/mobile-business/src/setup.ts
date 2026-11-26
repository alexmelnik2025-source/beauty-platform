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

function hasText(value: unknown): boolean {
  return typeof value === 'string' && value.trim() !== '';
}

function isActiveService(service: ServiceList[number]): boolean {
  return service?.active === true && hasText(service.id);
}

/** Active specialists who do at least one active service — the ones clients can book. */
export function bookableStaff(services: ServiceList, staff: StaffList): StaffList {
  if (!Array.isArray(services) || !Array.isArray(staff)) return [];
  const active = new Set(services.filter(isActiveService).map((s) => s.id));
  return staff.filter(
    (s) =>
      s?.active === true &&
      hasText(s.id) &&
      Array.isArray(s.serviceIds) &&
      s.serviceIds.some((id) => active.has(id)),
  );
}

function isClock(text: unknown): text is string {
  return typeof text === 'string' && /^(?:(?:[01]\d|2[0-3]):[0-5]\d|24:00)$/.test(text);
}

/** Weekly hours on at least one day. Special days alone do not make a schedule. */
export function hasWeeklyHours(hours: Pick<WorkingHours, 'weekly'>): boolean {
  return (
    Array.isArray(hours?.weekly) &&
    hours.weekly.some(
      (day) =>
        Number.isInteger(day?.weekday) &&
        day.weekday >= 1 &&
        day.weekday <= 7 &&
        Array.isArray(day.intervals) &&
        day.intervals.some(
          (interval) =>
            isClock(interval?.start) && isClock(interval.end) && interval.start < interval.end,
        ),
    )
  );
}

export function setupState(input: {
  location: Pick<Location, 'bookingTerms' | 'privacyPolicy' | 'onlineBookingEnabled'>;
  services: ServiceList;
  staff: StaffList;
  /** Whether a bookable specialist has weekly hours (false when nobody is bookable). */
  hoursSet: boolean;
}): { step: SetupStep; done: boolean }[] {
  const done: Record<SetupStep, boolean> = {
    services: Array.isArray(input.services) && input.services.some(isActiveService),
    team: bookableStaff(input.services, input.staff).length > 0,
    hours: input.hoursSet,
    legal: hasText(input.location.bookingTerms) && hasText(input.location.privacyPolicy),
    online: input.location.onlineBookingEnabled,
  };
  return SETUP_STEPS.map((step) => ({ step, done: done[step] }));
}

/** The card is shown while a step is open. */
export function setupFinished(steps: { done: boolean; step?: string }[]): boolean {
  if (steps.length === 0 || steps.some((s) => !s.done)) return false;
  // Callers may supply completion flags alone. Named checklists must include every required step.
  if (steps.every((s) => s.step === undefined)) return true;
  return SETUP_STEPS.every((required) => steps.some((s) => s.step === required));
}
