import { generateToken, hashToken } from '../common/crypto';
import type { Locale } from '../generated/prisma/client';
import type { MailMessage } from '../mail/mail.service';
import type { PrismaService } from '../prisma/prisma.service';

/**
 * Task 165b, part 2: "How was your visit?". When the salon collects reviews, the client gets
 * one email `requestHours` after a visit that took place — only with an email address and the
 * salon's marketing consent, and only while the visit has no review yet. Checked when the
 * email is queued and again when it is sent. The link opens the visit page with the review form.
 */

export const REVIEW_REQUEST = 'review_request';
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
/** A visit is asked about only within two days after its time to ask (not long-past visits). */
export const REQUEST_WINDOW_HOURS = 48;
/** The link in the email works as long as the review can be written. */
const LINK_DAYS = 30;

export interface ReviewRequestNotification {
  appointmentId: string;
}

type Db = Pick<
  PrismaService,
  'appointment' | 'consentRecord' | 'reviewSettings' | 'appointmentAccessToken'
>;

const WORDS: Record<
  Locale,
  {
    subject: (salon: string) => string;
    body: (salon: string, service: string, staff: string) => string;
    rate: string;
  }
> = {
  pl: {
    subject: (salon) => `${salon}: jak było?`,
    body: (salon, service, staff) =>
      `Dziękujemy za wizytę w ${salon} (${service}, ${staff}). Jak było? Twoja opinia pomoże innym klientom i specjaliście.`,
    rate: 'Oceń wizytę',
  },
  uk: {
    subject: (salon) => `${salon}: як усе пройшло?`,
    body: (salon, service, staff) =>
      `Дякуємо за візит у ${salon} (${service}, ${staff}). Як усе пройшло? Ваш відгук допоможе іншим клієнтам і майстру.`,
    rate: 'Оцінити візит',
  },
  ru: {
    subject: (salon) => `${salon}: как всё прошло?`,
    body: (salon, service, staff) =>
      `Спасибо за визит в ${salon} (${service}, ${staff}). Как всё прошло? Ваш отзыв поможет другим клиентам и мастеру.`,
    rate: 'Оценить визит',
  },
  en: {
    subject: (salon) => `${salon}: how was it?`,
    body: (salon, service, staff) =>
      `Thank you for visiting ${salon} (${service}, ${staff}). How was it? Your review helps other clients and the specialist.`,
    rate: 'Rate your visit',
  },
  tr: {
    subject: (salon) => `${salon}: nasıldı?`,
    body: (salon, service, staff) =>
      `${salon} ziyaretiniz için teşekkürler (${service}, ${staff}). Nasıldı? Yorumunuz diğer müşterilere ve uzmana yardımcı olur.`,
    rate: 'Ziyareti değerlendir',
  },
  sq: {
    subject: (salon) => `${salon}: si ishte?`,
    body: (salon, service, staff) =>
      `Faleminderit për vizitën në ${salon} (${service}, ${staff}). Si ishte? Mendimi juaj ndihmon klientët e tjerë dhe specialistin.`,
    rate: 'Vlerësoni vizitën',
  },
};

export function renderReviewRequestEmail(
  locale: Locale,
  input: { salonName: string; serviceName: string; staffName: string; link: string },
): { subject: string; text: string } {
  const w = WORDS[locale] ?? WORDS.pl;
  return {
    subject: w.subject(input.salonName),
    text: `${w.body(input.salonName, input.serviceName, input.staffName)}\n\n${w.rate}: ${input.link}`,
  };
}

/** The visit with its salon, service, specialist and client when the email may (still) go. */
export async function reviewRequestCandidate(db: Db, appointmentId: string, now: Date) {
  const visit = await db.appointment.findUnique({
    where: { id: appointmentId },
    include: { location: true, service: true, staff: true, customer: true, review: true },
  });
  if (!visit?.customer || visit.review) return null;
  const tookPlace =
    visit.status === 'completed' ||
    (visit.status === 'confirmed' && visit.endAt.getTime() <= now.getTime());
  if (!tookPlace) return null;
  const settings = await db.reviewSettings.findUnique({ where: { locationId: visit.locationId } });
  if (!settings?.enabled) return null;
  if (visit.endAt.getTime() + settings.requestHours * HOUR_MS > now.getTime()) return null;
  const { customer } = visit;
  if (!customer.email || customer.anonymizedAt) return null;
  const consent = await db.consentRecord.findFirst({
    where: { customerId: customer.id, type: 'marketing' },
    orderBy: { createdAt: 'desc' },
  });
  if (!consent?.granted) return null;
  return visit;
}

/** The email for a queued request, or null when it should no longer go. */
export async function reviewRequestMail(
  db: Db,
  config: { APP_WEB_URL: string },
  payload: ReviewRequestNotification,
  now = new Date(),
): Promise<MailMessage[] | null> {
  const visit = await reviewRequestCandidate(db, payload.appointmentId, now);
  if (!visit?.customer?.email) return null;
  const locale = visit.customer.locale;
  // Only token hashes are stored, so the email gets a fresh "manage" link.
  const token = generateToken();
  await db.appointmentAccessToken.create({
    data: {
      appointmentId: visit.id,
      tokenHash: hashToken(token),
      expiresAt: new Date(visit.endAt.getTime() + LINK_DAYS * DAY_MS),
    },
  });
  const { subject, text } = renderReviewRequestEmail(locale, {
    salonName: visit.location.name,
    serviceName: visit.service.name,
    staffName: visit.staff.displayName,
    link: `${config.APP_WEB_URL}/${locale}/m/${token}#review`,
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
