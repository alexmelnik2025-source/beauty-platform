import type { Locale } from '../generated/prisma/client';
import type { PushMessage } from './push.sender';

const TITLES: Record<Locale, Record<string, string>> = {
  pl: {
    'appointment.booked': 'Nowa rezerwacja online',
    'appointment.created': 'Nowa wizyta',
    'appointment.rescheduled': 'Wizyta przeniesiona',
    'appointment.cancelled': 'Wizyta odwołana',
  },
  uk: {
    'appointment.booked': 'Новий онлайн-запис',
    'appointment.created': 'Новий запис',
    'appointment.rescheduled': 'Запис перенесено',
    'appointment.cancelled': 'Запис скасовано',
  },
  ru: {
    'appointment.booked': 'Новая онлайн-запись',
    'appointment.created': 'Новая запись',
    'appointment.rescheduled': 'Запись перенесена',
    'appointment.cancelled': 'Запись отменена',
  },
  en: {
    'appointment.booked': 'New online booking',
    'appointment.created': 'New appointment',
    'appointment.rescheduled': 'Appointment moved',
    'appointment.cancelled': 'Appointment cancelled',
  },
};

/** What the notification feed stores in `data` (see NotificationsService). */
interface FeedData {
  date?: string;
  time?: string;
  serviceName?: string;
  staffName?: string;
  customerName?: string | null;
}

/**
 * The push text for a feed notification, in the user's language. It shows on a lock
 * screen, so it carries what the feed shows and nothing more: no phone, no email.
 */
export function pushMessage(
  locale: Locale,
  notification: { type: string; appointmentId: string | null; data: unknown },
): PushMessage {
  const data = (notification.data ?? {}) as FeedData;
  const title = TITLES[locale][notification.type] ?? 'GESTALT';
  // 2026-10-31 → 31.10
  const day = data.date ? `${data.date.slice(8, 10)}.${data.date.slice(5, 7)}` : '';
  const when = [day, data.time].filter(Boolean).join(' ');
  const body = [when, data.customerName, data.serviceName, data.staffName]
    .filter(Boolean)
    .join(' · ');
  const query = data.date ? `?date=${data.date}` : '';
  return {
    title,
    body,
    url: `/${locale}/app/calendar${query}`,
    tag: notification.appointmentId ?? undefined,
  };
}
