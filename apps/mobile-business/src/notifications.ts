import type { NotificationList } from './api';

/** The bell of the business app: what happened with visits, newest first — plain functions. */

export type Notice = NotificationList[number];

/** Only this salon's notifications (a person may work in several salons and organizations). */
export function noticesOfSalon(
  list: NotificationList,
  orgId: string,
  locationId: string,
): Notice[] {
  return list.filter((n) => n.organizationId === orgId && n.data.locationId === locationId);
}

/** "booked" | "created" | "rescheduled" | "cancelled" — the key of the text in the dictionary. */
export function noticeKind(n: Notice): 'booked' | 'created' | 'rescheduled' | 'cancelled' {
  return n.type.slice('appointment.'.length) as 'booked' | 'created' | 'rescheduled' | 'cancelled';
}

/** The visit card can be opened for everything except a cancelled visit. */
export function opensVisit(n: Notice): boolean {
  return n.appointmentId !== null && n.type !== 'appointment.cancelled';
}

/** "99+" on the bell for big numbers, nothing for 0. */
export function badge(unread: number): string {
  if (unread <= 0) return '';
  return unread > 99 ? '99+' : String(unread);
}
