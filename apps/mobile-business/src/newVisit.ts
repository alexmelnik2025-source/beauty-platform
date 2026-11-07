import {
  ApiError,
  type Availability,
  type Locale,
  type NewAppointment,
  type PermissionCatalog,
  type ServiceList,
  type StaffList,
} from './api';
import { addDays } from './day';
import { normalizePhone } from './phone';
import type { NewVisitPreset } from './waitlist';

/**
 * "New visit" in the business app (task 17a): the salon books a client who phoned or came in,
 * with the same rules as the web calendar. No React Native here — tested in Vitest
 * (test/newVisit.test.ts). The server checks every right and time again.
 */

export type MyRights = PermissionCatalog['me'];

/**
 * May this person add visits at all? An owner or manager — always; a specialist with
 * "creates own visits" — only when they are one of the salon's specialists.
 */
export function mayAddVisits(me: MyRights, mineId: string | null): boolean {
  if (me.role !== 'staff') return true;
  return (
    mineId !== null &&
    (me.permissions.createOwnAppointments || me.permissions.manageAllAppointments)
  );
}

/** An owner or manager looks the client up in the salon's base; a specialist types a new one. */
export function maySearchClients(me: MyRights): boolean {
  return me.role !== 'staff';
}

/** Services the salon still offers, in the salon's order. */
export function activeServices(services: ServiceList): ServiceList {
  return services
    .filter((s) => s.active && s.staffIds.length > 0)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
}

/**
 * Who can do the service for this person: everyone active who performs it for an owner,
 * a manager or a specialist allowed to manage all visits; otherwise only themselves.
 */
export function staffForService(
  staff: StaffList,
  serviceId: string,
  me: MyRights,
  mineId: string | null,
): StaffList {
  const who = staff
    .filter((s) => s.active && s.serviceIds.includes(serviceId))
    .sort((a, b) => a.sortOrder - b.sortOrder);
  if (me.role !== 'staff' || me.permissions.manageAllAppointments) return who;
  return who.filter((s) => s.id === mineId);
}

/** The free start times of one specialist on one day: [{ time: "09:15", start: ISO }]. */
export function freeTimes(
  availability: Availability,
  staffId: string,
  date: string,
): { time: string; start: string }[] {
  return availability.slots
    .filter((s) => s.date === date && s.staffIds.includes(staffId))
    .map((s) => ({ time: s.time, start: s.start }))
    .sort((a, b) => a.time.localeCompare(b.time));
}

/**
 * A salon-local date and time ("2026-11-03", "14:35") as an ISO instant, in the salon's time
 * zone (not the phone's). Used for a walk-in entered afterwards; summer time is handled.
 */
export function localToInstant(date: string, time: string, timeZone: string): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const [hh, mm] = time.split(':').map(Number) as [number, number];
  const wanted = Date.UTC(y, m - 1, d, hh, mm);
  // The zone's offset at that moment; once more in case the first guess crossed a DST change.
  let instant = wanted - offsetMs(wanted, timeZone);
  instant = wanted - offsetMs(instant, timeZone);
  return new Date(instant).toISOString();
}

function offsetMs(instant: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(instant));
  const part = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const local = Date.UTC(
    part('year'),
    part('month') - 1,
    part('day'),
    part('hour'),
    part('minute'),
  );
  return local - Math.floor(instant / 60_000) * 60_000;
}

/** "9:5", "0935", "09.35" → "09:35"; null when it is not a time on a 5-minute mark. */
export function parseTime(input: string): string | null {
  const match = /^(\d{1,2})[:.]?(\d{2})$/.exec(input.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59 || minutes % 5 !== 0) return null;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

/** A walk-in entered afterwards may be from today or yesterday (salon time), as on the web. */
export function walkInDays(today: string): string[] {
  return [today, addDays(today, -1)];
}

export interface ClientForm {
  name: string;
  phone: string;
  email: string;
}

export type ClientProblem = 'name' | 'phone' | 'email';

/** A new client ready to send, or the first thing to fix (before asking the server). */
export function checkNewClient(
  form: ClientForm,
  /** The salon's country code, for a number typed without one. */
  dial: string,
):
  | { ok: true; customer: { name: string; phone: string; email?: string } }
  | { ok: false; problem: ClientProblem } {
  const name = form.name.trim().replace(/\s+/g, ' ');
  if (name.length < 2 || name.length > 100) return { ok: false, problem: 'name' };
  const phone = normalizePhone(form.phone, dial);
  if (!/^\+[1-9]\d{6,14}$/.test(phone)) return { ok: false, problem: 'phone' };
  const email = form.email.trim().toLowerCase();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, problem: 'email' };
  return { ok: true, customer: email ? { name, phone, email } : { name, phone } };
}

/** The request body: an existing client by id, or a new one; a walk-in afterwards as "came". */
export function newAppointmentBody(input: {
  serviceId: string;
  staffId: string;
  start: string;
  client: { id: string } | { name: string; phone: string; email?: string };
  /** Language of the client's emails (the language of the app for a new client). */
  locale: Locale;
  note: string;
  walkIn: { paid: boolean } | null;
}): NewAppointment {
  const body: NewAppointment = {
    serviceId: input.serviceId,
    staffId: input.staffId,
    start: input.start,
  };
  if ('id' in input.client) body.customerId = input.client.id;
  else body.customer = { ...input.client, locale: input.locale };
  const note = input.note.trim();
  if (note) body.note = note.slice(0, 500);
  if (input.walkIn) {
    body.alreadyHappened = true;
    if (input.walkIn.paid) body.paid = true;
  }
  return body;
}

/** Which message the screen shows when the server says no. */
export type CreateProblem =
  'taken' | 'outsideHours' | 'past' | 'tooLongAgo' | 'notStarted' | 'forbidden' | 'other';

export function createProblem(error: unknown): CreateProblem {
  if (!(error instanceof ApiError)) return 'other';
  switch (error.code) {
    case 'SLOT_TAKEN':
      return 'taken';
    case 'OUTSIDE_WORKING_HOURS':
      return 'outsideHours';
    case 'IN_THE_PAST':
      return 'past';
    case 'TOO_LONG_AGO':
      return 'tooLongAgo';
    case 'NOT_STARTED':
      return 'notStarted';
  }
  return error.status === 403 ? 'forbidden' : 'other';
}

/**
 * Move and cancel in the visit card (task 17b): a confirmed visit that has not started yet,
 * for someone who may change it (the same rule as "came / did not come").
 */
export function mayMoveOrCancel(
  visit: { status: string; start: string },
  canChange: boolean,
  now = Date.now(),
): boolean {
  return canChange && visit.status === 'confirmed' && Date.parse(visit.start) > now;
}

/** The cancel reason the client reads: 1–300 characters, or null when it is empty. */
export function cancelReason(input: string): string | null {
  const reason = input.trim().replace(/\s+/g, ' ');
  return reason ? reason.slice(0, 300) : null;
}

/**
 * "Umów ponownie" in the visit card (task 223): a new visit for the same client, service and
 * specialist, from today at the earliest (or the visit's own day, if it is later), the same
 * time suggested. Null for a visit without a client (a walk-in).
 */
export function presetFromVisit(
  visit: {
    date: string;
    time: string;
    service: { id: string };
    staff: { id: string };
    customer: { id: string; name: string; phone: string | null } | null;
  },
  today: string,
): NewVisitPreset | null {
  if (!visit.customer) return null;
  return {
    serviceId: visit.service.id,
    staffId: visit.staff.id,
    date: visit.date > today ? visit.date : today,
    client: { name: '', phone: '', email: '' },
    customer: { id: visit.customer.id, name: visit.customer.name, phone: visit.customer.phone },
    time: visit.time,
  };
}

/** May "Umów ponownie" be offered for this visit (it has a client and was really booked)? */
export function mayBookAgain(
  visit: { status: string; customer: unknown },
  canAdd: boolean,
): boolean {
  return canAdd && visit.customer !== null && visit.status !== 'held' && visit.status !== 'expired';
}
