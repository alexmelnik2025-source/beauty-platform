import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Locale } from '../generated/prisma/client';
import type { MailMessage } from '../mail/mail.service';
import type { PrismaService } from '../prisma/prisma.service';
import { LOCALE_TAGS } from './booking-templates';

/**
 * Task 165c: "time for your next visit". The salon switches it on in its settings
 * (Location.rebookReminderDays > 0) and may write its own words; the client gets one email
 * that many days after their last visit in the salon — only with an email, the salon's
 * marketing consent, no later visit and nothing booked ahead. Checked when the email is
 * queued and again when it is sent. Every email has a one-click "unsubscribe" link that
 * withdraws the marketing consent.
 */

export const REBOOK_REMINDER = 'rebook_reminder';
export const DAY_MS = 86_400_000;
/** A visit is reminded about only within a week after its date (not long-past visits). */
export const REBOOK_WINDOW_DAYS = 7;

export interface RebookReminderNotification {
  appointmentId: string;
}

type Db = Pick<PrismaService, 'appointment' | 'consentRecord'>;

const WORDS: Record<
  Locale,
  {
    subject: (salon: string) => string;
    body: (salon: string, date: string, service: string, staff: string) => string;
    book: string;
    unsubscribe: string;
  }
> = {
  pl: {
    subject: (salon) => `${salon}: pora na kolejną wizytę?`,
    body: (salon, date, service, staff) =>
      `Twoja ostatnia wizyta w ${salon} była ${date} (${service}, ${staff}). Pora na kolejną?`,
    book: 'Umów się online',
    unsubscribe: 'Nie chcesz takich wiadomości od salonu? Wypisz się',
  },
  uk: {
    subject: (salon) => `${salon}: час на наступний візит?`,
    body: (salon, date, service, staff) =>
      `Ваш останній візит у ${salon} був ${date} (${service}, ${staff}). Час на наступний?`,
    book: 'Записатися онлайн',
    unsubscribe: 'Не хочете таких повідомлень від салону? Відписатися',
  },
  ru: {
    subject: (salon) => `${salon}: пора на следующий визит?`,
    body: (salon, date, service, staff) =>
      `Ваш последний визит в ${salon} был ${date} (${service}, ${staff}). Пора на следующий?`,
    book: 'Записаться онлайн',
    unsubscribe: 'Не хотите таких сообщений от салона? Отписаться',
  },
  en: {
    subject: (salon) => `${salon}: time for your next visit?`,
    body: (salon, date, service, staff) =>
      `Your last visit to ${salon} was on ${date} (${service}, ${staff}). Time for the next one?`,
    book: 'Book online',
    unsubscribe: 'Don’t want messages like this from the salon? Unsubscribe',
  },
  tr: {
    subject: (salon) => `${salon}: bir sonraki randevu zamanı?`,
    body: (salon, date, service, staff) =>
      `${salon} salonundaki son randevunuz ${date} tarihindeydi (${service}, ${staff}). Bir sonrakinin zamanı geldi mi?`,
    book: 'Online randevu al',
    unsubscribe: 'Salondan bu tür mesajlar istemiyor musunuz? Abonelikten çıkın',
  },
  sq: {
    subject: (salon) => `${salon}: koha për vizitën e radhës?`,
    body: (salon, date, service, staff) =>
      `Vizita juaj e fundit në ${salon} ishte më ${date} (${service}, ${staff}). Koha për tjetrën?`,
    book: 'Rezervo online',
    unsubscribe: 'Nuk dëshironi mesazhe të tilla nga salloni? Çregjistrohuni',
  },
};

/** The email text: the salon's own words (or the platform's), the booking link and "unsubscribe". */
export function renderRebookEmail(
  locale: Locale,
  input: {
    salonName: string;
    salonText: string | null;
    lastVisit: Date;
    timeZone: string;
    serviceName: string;
    staffName: string;
    bookLink: string;
    unsubscribeLink: string;
  },
): { subject: string; text: string } {
  const w = WORDS[locale];
  const date = new Intl.DateTimeFormat(LOCALE_TAGS[locale], {
    timeZone: input.timeZone,
    day: 'numeric',
    month: 'long',
  }).format(input.lastVisit);
  const body = input.salonText ?? w.body(input.salonName, date, input.serviceName, input.staffName);
  return {
    subject: w.subject(input.salonName),
    text: `${body}\n\n${w.book}: ${input.bookLink}\n\n—\n${w.unsubscribe}: ${input.unsubscribeLink}`,
  };
}

// ── The one-click unsubscribe link ─────────────────────

function signature(secret: string, customerId: string): Buffer {
  return createHmac('sha256', secret).update(`unsubscribe:${customerId}`).digest().subarray(0, 18);
}

/** `<customerId>.<signature>`: withdraws the client's marketing consent in that salon. */
export function unsubscribeToken(secret: string, customerId: string): string {
  return `${customerId}.${signature(secret, customerId).toString('base64url')}`;
}

/** The client the token was made for; null for a changed or made-up token. */
export function customerFromToken(secret: string, token: string): string | null {
  const [customerId, sig] = String(token ?? '').split('.');
  if (!customerId || !sig || !/^[0-9a-f-]{36}$/.test(customerId)) return null;
  const given = Buffer.from(sig);
  const expected = Buffer.from(signature(secret, customerId).toString('base64url'));
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  return customerId;
}

// ── Who gets it ────────────────────────────────────────

const VISITED = ['completed', 'confirmed'] as const;

/**
 * The visit, its salon and client when the email may (still) go: the salon has it on, the
 * visit took place, the client has an email and the salon's marketing consent, and no later
 * visit or booking exists in that salon. null otherwise.
 */
export async function rebookCandidate(db: Db, appointmentId: string, now: Date) {
  const visit = await db.appointment.findUnique({
    where: { id: appointmentId },
    include: { location: true, service: true, staff: true, customer: true },
  });
  if (!visit?.customer || !visit.customerId) return null;
  const { location, customer } = visit;
  if (location.rebookReminderDays <= 0) return null;
  if (!(VISITED as readonly string[]).includes(visit.status)) return null;
  if (visit.endAt.getTime() > now.getTime()) return null;
  if (!customer.email || customer.anonymizedAt) return null;
  const consent = await db.consentRecord.findFirst({
    where: { customerId: customer.id, type: 'marketing' },
    orderBy: { createdAt: 'desc' },
  });
  if (!consent?.granted) return null;
  const later = await db.appointment.count({
    where: {
      customerId: customer.id,
      locationId: location.id,
      id: { not: visit.id },
      startAt: { gt: visit.startAt },
      status: { in: ['held', 'confirmed', 'completed', 'no_show'] },
    },
  });
  if (later > 0) return null;
  return visit;
}

/** The email for a queued reminder, or null when it should no longer go. */
export async function rebookMail(
  db: Db,
  config: { APP_WEB_URL: string; JWT_ACCESS_SECRET: string },
  payload: RebookReminderNotification,
  now = new Date(),
): Promise<MailMessage[] | null> {
  const visit = await rebookCandidate(db, payload.appointmentId, now);
  if (!visit?.customer?.email) return null;
  const locale = visit.customer.locale;
  const web = config.APP_WEB_URL;
  const query = new URLSearchParams({ service: visit.serviceId, staff: visit.staffId });
  const token = unsubscribeToken(config.JWT_ACCESS_SECRET, visit.customer.id);
  const { subject, text } = renderRebookEmail(locale, {
    salonName: visit.location.name,
    salonText: visit.location.rebookReminderText,
    lastVisit: visit.startAt,
    timeZone: visit.location.timezone,
    serviceName: visit.service.name,
    staffName: visit.staff.displayName,
    bookLink: `${web}/${locale}/b/${visit.location.slug}?${query}`,
    unsubscribeLink: `${web}/${locale}/u/${encodeURIComponent(token)}`,
  });
  return [
    {
      to: visit.customer.email,
      subject,
      text,
      lang: locale,
      senderName: visit.location.name,
      ...(visit.location.email ? { replyTo: visit.location.email } : {}),
    },
  ];
}
