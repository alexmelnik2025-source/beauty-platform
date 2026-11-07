import type { SalonWaitlist, ServiceList, StaffList } from './api';
import { timeIn } from './day';

/**
 * Task 94: "Lista oczekujących" in the business app — clients waiting for a free time on the
 * day the calendar shows (owners and managers; the server checks it too). No React Native here,
 * so it is tested in Vitest (test/waitlist.test.ts).
 */

export type WaitlistEntry = SalonWaitlist['items'][number];

/** What "+ Nowa wizyta" fills in for a waiting client: service, specialist, day and contacts. */
export interface NewVisitPreset {
  serviceId: string;
  /** null = the client takes any specialist. */
  staffId: string | null;
  date: string;
  client: { name: string; phone: string; email: string };
  /** Task 223 ("Umów ponownie"): a client already in the salon's base, booked by id. */
  customer?: { id: string; name: string; phone: string | null };
  /** Task 223: the time to suggest first ("10:30"), when it is free. */
  time?: string;
}

/** Clients waiting for this day, who asked first on top. */
export function waitlistOfDay(list: SalonWaitlist, date: string): WaitlistEntry[] {
  return list.items
    .filter((e) => e.date === date && (e.status === 'waiting' || e.status === 'notified'))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** "Czeka" or "Powiadomiony(-a) 14:05" (salon time) and "Zapisał(a) się 09:12". */
export function waitlistStatus(
  entry: Pick<WaitlistEntry, 'status' | 'notifiedAt' | 'createdAt'>,
  timeZone: string,
  w: { waiting: string; notified: string; askedAt: string },
): string {
  const asked = w.askedAt.replace('{time}', timeIn(entry.createdAt, timeZone));
  const state =
    entry.status === 'notified' && entry.notifiedAt
      ? w.notified.replace('{time}', timeIn(entry.notifiedAt, timeZone))
      : w.waiting;
  return `${state} · ${asked}`;
}

/** The waiting client's details for the "New visit" form. */
export function presetFromEntry(entry: WaitlistEntry): NewVisitPreset {
  return {
    serviceId: entry.serviceId,
    staffId: entry.staffId,
    date: entry.date,
    client: { name: entry.name, phone: entry.phone ?? '', email: entry.email },
  };
}

/**
 * The service and specialist the form starts with: the service only if the salon still
 * offers it; the specialist the client asked for if they can do it, otherwise the only one.
 */
export function presetChoice(
  preset: Pick<NewVisitPreset, 'serviceId' | 'staffId'>,
  services: ServiceList,
  who: (serviceId: string) => StaffList,
): { serviceId: string; staffId: string } {
  if (!services.some((s) => s.id === preset.serviceId)) return { serviceId: '', staffId: '' };
  const options = who(preset.serviceId);
  const asked = preset.staffId ? options.find((s) => s.id === preset.staffId) : undefined;
  const staffId = asked?.id ?? (options.length === 1 ? options[0]!.id : '');
  return { serviceId: preset.serviceId, staffId };
}
