import type { Locale } from '../generated/prisma/client';
import { formatMoney } from '../common/currency';

/**
 * Booking emails in the interface languages (pl, uk, ru, en, tr, sq). Polish is the reference text;
 * the other versions must be proofread by native speakers before the beta.
 */

export interface AppointmentDetails {
  salonName: string;
  address: string;
  serviceName: string;
  staffName: string;
  /** Already formatted in the salon's time zone and the reader's language. */
  when: string;
  price: string;
  customerName: string;
  customerPhone: string;
  manageLink?: string;
  reason?: string | null;
}

type Kind =
  | 'client_confirmation'
  | 'client_rescheduled'
  | 'client_cancelled'
  | 'client_reminder'
  | 'salon_new_booking'
  | 'salon_client_cancelled'
  | 'salon_client_rescheduled';

interface Words {
  subjects: Record<Kind, string>;
  intro: Record<Kind, string>;
  service: string;
  staff: string;
  when: string;
  where: string;
  price: string;
  client: string;
  manage: string;
  reason: string;
  codeSubject: string;
  codeText: (code: string, salon: string) => string;
  /** Short: an SMS with Polish or Cyrillic letters holds 70 characters. */
  codeSms: (code: string, salon: string) => string;
}

const WORDS: Record<Locale, Words> = {
  pl: {
    subjects: {
      client_confirmation: 'Wizyta potwierdzona',
      client_rescheduled: 'Termin wizyty zmieniony',
      client_cancelled: 'Wizyta odwołana',
      client_reminder: 'Przypomnienie o jutrzejszej wizycie',
      salon_new_booking: 'Nowa rezerwacja online',
      salon_client_cancelled: 'Klient odwołał wizytę',
      salon_client_rescheduled: 'Klient zmienił termin wizyty',
    },
    intro: {
      client_confirmation: 'Twoja wizyta jest potwierdzona.',
      client_rescheduled: 'Termin Twojej wizyty został zmieniony.',
      client_cancelled: 'Twoja wizyta została odwołana.',
      client_reminder: 'Przypominamy o Twojej wizycie.',
      salon_new_booking: 'Nowa rezerwacja przez internet.',
      salon_client_cancelled: 'Klient odwołał wizytę.',
      salon_client_rescheduled: 'Klient przeniósł wizytę na nowy termin.',
    },
    service: 'Usługa',
    staff: 'Specjalista',
    when: 'Termin',
    where: 'Adres',
    price: 'Cena',
    client: 'Klient',
    manage: 'Zmień lub odwołaj wizytę',
    reason: 'Powód',
    codeSubject: 'Kod potwierdzenia rezerwacji',
    codeText: (code, salon) =>
      `Twój kod potwierdzenia rezerwacji w ${salon}: ${code}\n\nKod jest ważny 10 minut. Jeśli to nie Ty rezerwowałeś, zignoruj tę wiadomość.`,
    codeSms: (code, salon) => `${code} — kod rezerwacji w ${salon}. Ważny 10 min.`,
  },
  uk: {
    subjects: {
      client_confirmation: 'Візит підтверджено',
      client_rescheduled: 'Час візиту змінено',
      client_cancelled: 'Візит скасовано',
      client_reminder: 'Нагадування про завтрашній візит',
      salon_new_booking: 'Новий онлайн-запис',
      salon_client_cancelled: 'Клієнт скасував візит',
      salon_client_rescheduled: 'Клієнт переніс візит',
    },
    intro: {
      client_confirmation: 'Ваш візит підтверджено.',
      client_rescheduled: 'Час вашого візиту змінено.',
      client_cancelled: 'Ваш візит скасовано.',
      client_reminder: 'Нагадуємо про ваш візит.',
      salon_new_booking: 'Новий запис через інтернет.',
      salon_client_cancelled: 'Клієнт скасував візит.',
      salon_client_rescheduled: 'Клієнт переніс візит на інший час.',
    },
    service: 'Послуга',
    staff: 'Майстер',
    when: 'Час',
    where: 'Адреса',
    price: 'Ціна',
    client: 'Клієнт',
    manage: 'Змінити або скасувати візит',
    reason: 'Причина',
    codeSubject: 'Код підтвердження запису',
    codeText: (code, salon) =>
      `Ваш код підтвердження запису в ${salon}: ${code}\n\nКод дійсний 10 хвилин. Якщо ви не записувалися, проігноруйте цей лист.`,
    codeSms: (code, salon) => `${code} — код запису в ${salon}. Дійсний 10 хв.`,
  },
  ru: {
    subjects: {
      client_confirmation: 'Запись подтверждена',
      client_rescheduled: 'Время записи изменено',
      client_cancelled: 'Запись отменена',
      client_reminder: 'Напоминание о завтрашнем визите',
      salon_new_booking: 'Новая онлайн-запись',
      salon_client_cancelled: 'Клиент отменил запись',
      salon_client_rescheduled: 'Клиент перенёс запись',
    },
    intro: {
      client_confirmation: 'Ваша запись подтверждена.',
      client_rescheduled: 'Время вашей записи изменено.',
      client_cancelled: 'Ваша запись отменена.',
      client_reminder: 'Напоминаем о вашем визите.',
      salon_new_booking: 'Новая запись через интернет.',
      salon_client_cancelled: 'Клиент отменил запись.',
      salon_client_rescheduled: 'Клиент перенёс запись на другое время.',
    },
    service: 'Услуга',
    staff: 'Мастер',
    when: 'Время',
    where: 'Адрес',
    price: 'Цена',
    client: 'Клиент',
    manage: 'Перенести или отменить запись',
    reason: 'Причина',
    codeSubject: 'Код подтверждения записи',
    codeText: (code, salon) =>
      `Ваш код подтверждения записи в ${salon}: ${code}\n\nКод действует 10 минут. Если вы не записывались, проигнорируйте это письмо.`,
    codeSms: (code, salon) => `${code} — код записи в ${salon}. Действует 10 мин.`,
  },
  en: {
    subjects: {
      client_confirmation: 'Appointment confirmed',
      client_rescheduled: 'Appointment time changed',
      client_cancelled: 'Appointment cancelled',
      client_reminder: 'Reminder: your appointment tomorrow',
      salon_new_booking: 'New online booking',
      salon_client_cancelled: 'Client cancelled an appointment',
      salon_client_rescheduled: 'Client moved an appointment',
    },
    intro: {
      client_confirmation: 'Your appointment is confirmed.',
      client_rescheduled: 'Your appointment time has changed.',
      client_cancelled: 'Your appointment has been cancelled.',
      client_reminder: 'A reminder about your appointment.',
      salon_new_booking: 'A new online booking.',
      salon_client_cancelled: 'A client cancelled their appointment.',
      salon_client_rescheduled: 'A client moved their appointment.',
    },
    service: 'Service',
    staff: 'Specialist',
    when: 'When',
    where: 'Address',
    price: 'Price',
    client: 'Client',
    manage: 'Change or cancel the appointment',
    reason: 'Reason',
    codeSubject: 'Your booking confirmation code',
    codeText: (code, salon) =>
      `Your confirmation code for ${salon}: ${code}\n\nThe code is valid for 10 minutes. If you did not make a booking, ignore this email.`,
    codeSms: (code, salon) => `${code} is your booking code for ${salon}. Valid 10 min.`,
  },
  tr: {
    subjects: {
      client_confirmation: 'Randevunuz onaylandı',
      client_rescheduled: 'Randevu saati değişti',
      client_cancelled: 'Randevu iptal edildi',
      client_reminder: 'Hatırlatma: yarınki randevunuz',
      salon_new_booking: 'Yeni online rezervasyon',
      salon_client_cancelled: 'Müşteri randevuyu iptal etti',
      salon_client_rescheduled: 'Müşteri randevuyu taşıdı',
    },
    intro: {
      client_confirmation: 'Randevunuz onaylandı.',
      client_rescheduled: 'Randevunuzun saati değiştirildi.',
      client_cancelled: 'Randevunuz iptal edildi.',
      client_reminder: 'Randevunuzu hatırlatırız.',
      salon_new_booking: 'İnternetten yeni bir rezervasyon.',
      salon_client_cancelled: 'Bir müşteri randevusunu iptal etti.',
      salon_client_rescheduled: 'Bir müşteri randevusunu başka bir saate taşıdı.',
    },
    service: 'Hizmet',
    staff: 'Uzman',
    when: 'Tarih ve saat',
    where: 'Adres',
    price: 'Fiyat',
    client: 'Müşteri',
    manage: 'Randevuyu değiştir veya iptal et',
    reason: 'Neden',
    codeSubject: 'Rezervasyon onay kodunuz',
    codeText: (code, salon) =>
      `${salon} için rezervasyon onay kodunuz: ${code}\n\nKod 10 dakika geçerlidir. Rezervasyon yapmadıysanız bu e-postayı dikkate almayın.`,
    codeSms: (code, salon) => `${code} — ${salon} rezervasyon kodunuz. 10 dk geçerli.`,
  },
  sq: {
    subjects: {
      client_confirmation: 'Takimi u konfirmua',
      client_rescheduled: 'Ora e takimit ndryshoi',
      client_cancelled: 'Takimi u anulua',
      client_reminder: 'Kujtesë: takimi juaj nesër',
      salon_new_booking: 'Rezervim i ri online',
      salon_client_cancelled: 'Klienti anuloi takimin',
      salon_client_rescheduled: 'Klienti e zhvendosi takimin',
    },
    intro: {
      client_confirmation: 'Takimi juaj është konfirmuar.',
      client_rescheduled: 'Ora e takimit tuaj ka ndryshuar.',
      client_cancelled: 'Takimi juaj është anuluar.',
      client_reminder: 'Ju kujtojmë për takimin tuaj.',
      salon_new_booking: 'Një rezervim i ri përmes internetit.',
      salon_client_cancelled: 'Një klient anuloi takimin.',
      salon_client_rescheduled: 'Një klient e zhvendosi takimin në një orë tjetër.',
    },
    service: 'Shërbimi',
    staff: 'Specialisti',
    when: 'Data dhe ora',
    where: 'Adresa',
    price: 'Çmimi',
    client: 'Klienti',
    manage: 'Ndryshoni ose anuloni takimin',
    reason: 'Arsyeja',
    codeSubject: 'Kodi i konfirmimit të rezervimit',
    codeText: (code, salon) =>
      `Kodi juaj i konfirmimit për ${salon}: ${code}\n\nKodi është i vlefshëm 10 minuta. Nëse nuk keni bërë rezervim, injorojeni këtë email.`,
    codeSms: (code, salon) => `${code} — kodi i rezervimit në ${salon}. I vlefshëm 10 min.`,
  },
};

export const LOCALE_TAGS: Record<Locale, string> = {
  pl: 'pl-PL',
  uk: 'uk-UA',
  ru: 'ru-RU',
  en: 'en-GB',
  tr: 'tr-TR',
  sq: 'sq-AL',
};

export function formatWhen(date: Date, timeZone: string, locale: Locale): string {
  return new Intl.DateTimeFormat(LOCALE_TAGS[locale], {
    timeZone,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

/** An amount in hundredths of the salon's currency, in the reader's language. */
export function formatPrice(hundredths: number, currency: string, locale: Locale): string {
  return formatMoney(hundredths, currency, LOCALE_TAGS[locale]);
}

export function renderAppointmentEmail(
  kind: Kind,
  locale: Locale,
  d: AppointmentDetails,
): { subject: string; text: string } {
  const w = WORDS[locale];
  const forSalon = kind.startsWith('salon_');
  const lines = [
    w.intro[kind],
    '',
    `${w.service}: ${d.serviceName}`,
    `${w.staff}: ${d.staffName}`,
    `${w.when}: ${d.when}`,
    `${w.price}: ${d.price}`,
    forSalon
      ? `${w.client}: ${d.customerName}, ${d.customerPhone}`
      : `${w.where}: ${d.salonName}, ${d.address}`,
  ];
  if (d.reason) lines.push(`${w.reason}: ${d.reason}`);
  if (d.manageLink) lines.push('', `${w.manage}:`, d.manageLink);
  return { subject: `${w.subjects[kind]} — ${d.salonName}`, text: lines.join('\n') };
}

export function renderCodeEmail(
  locale: Locale,
  code: string,
  salonName: string,
): { subject: string; text: string } {
  const w = WORDS[locale];
  return { subject: w.codeSubject, text: w.codeText(code, salonName) };
}

/** The booking code by SMS (no subject, kept short). */
export function renderCodeSms(locale: Locale, code: string, salonName: string): string {
  return WORDS[locale].codeSms(code, salonName.slice(0, 30));
}

export type NotificationKind = Kind;
