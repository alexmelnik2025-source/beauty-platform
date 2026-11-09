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
  /** Task 20: the visit as a calendar file (.ics) to add to the phone's calendar. */
  calendarLink?: string;
  reason?: string | null;
}

type Kind =
  | 'client_confirmation'
  | 'client_rescheduled'
  | 'client_cancelled'
  | 'client_reminder'
  | 'salon_new_booking'
  | 'salon_client_cancelled'
  | 'salon_client_rescheduled'
  /** Task 161b: booked by a client the cancellation guard marks; the salon has to accept it. */
  | 'client_awaiting_approval'
  | 'salon_approval_needed';

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
  addToCalendar: string;
  /** Task 361: the maps link in the client's emails. */
  directions: string;
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
      client_awaiting_approval: 'Rezerwacja czeka na potwierdzenie salonu',
      salon_approval_needed: 'Rezerwacja do potwierdzenia',
    },
    intro: {
      client_confirmation: 'Twoja wizyta jest potwierdzona.',
      client_rescheduled: 'Termin Twojej wizyty został zmieniony.',
      client_cancelled: 'Twoja wizyta została odwołana.',
      client_reminder: 'Przypominamy o Twojej wizycie.',
      salon_new_booking: 'Nowa rezerwacja przez internet.',
      salon_client_cancelled: 'Klient odwołał wizytę.',
      salon_client_rescheduled: 'Klient przeniósł wizytę na nowy termin.',
      client_awaiting_approval:
        'Salon potwierdzi Twoją rezerwację — termin jest dla Ciebie zarezerwowany. Napiszemy, gdy salon ją przyjmie.',
      salon_approval_needed:
        'Klient zarezerwował wizytę online. Według zasad „Ochrona przed odwołaniami” ta wizyta czeka na potwierdzenie — przyjmij ją lub odwołaj w kalendarzu.',
    },
    service: 'Usługa',
    staff: 'Specjalista',
    when: 'Termin',
    where: 'Adres',
    price: 'Cena',
    client: 'Klient',
    manage: 'Zmień lub odwołaj wizytę',
    directions: 'Jak dojechać',
    addToCalendar: 'Dodaj do kalendarza',
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
      client_awaiting_approval: 'Запис чекає на підтвердження салону',
      salon_approval_needed: 'Запис потрібно підтвердити',
    },
    intro: {
      client_confirmation: 'Ваш візит підтверджено.',
      client_rescheduled: 'Час вашого візиту змінено.',
      client_cancelled: 'Ваш візит скасовано.',
      client_reminder: 'Нагадуємо про ваш візит.',
      salon_new_booking: 'Новий запис через інтернет.',
      salon_client_cancelled: 'Клієнт скасував візит.',
      salon_client_rescheduled: 'Клієнт переніс візит на інший час.',
      client_awaiting_approval:
        'Салон підтвердить ваш запис — час уже заброньовано для вас. Ми напишемо, коли салон його прийме.',
      salon_approval_needed:
        'Клієнт записався онлайн. За правилами «Захист від скасувань» цей візит чекає на підтвердження — підтвердіть або скасуйте його в календарі.',
    },
    service: 'Послуга',
    staff: 'Майстер',
    when: 'Час',
    where: 'Адреса',
    price: 'Ціна',
    client: 'Клієнт',
    manage: 'Змінити або скасувати візит',
    directions: 'Як дістатися',
    addToCalendar: 'Додати в календар',
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
      client_awaiting_approval: 'Запись ждёт подтверждения салона',
      salon_approval_needed: 'Запись нужно подтвердить',
    },
    intro: {
      client_confirmation: 'Ваша запись подтверждена.',
      client_rescheduled: 'Время вашей записи изменено.',
      client_cancelled: 'Ваша запись отменена.',
      client_reminder: 'Напоминаем о вашем визите.',
      salon_new_booking: 'Новая запись через интернет.',
      salon_client_cancelled: 'Клиент отменил запись.',
      salon_client_rescheduled: 'Клиент перенёс запись на другое время.',
      client_awaiting_approval:
        'Салон подтвердит вашу запись — время уже забронировано для вас. Мы напишем, когда салон её примет.',
      salon_approval_needed:
        'Клиент записался онлайн. По правилам «Защита от отмен» этот визит ждёт подтверждения — подтвердите или отмените его в календаре.',
    },
    service: 'Услуга',
    staff: 'Мастер',
    when: 'Время',
    where: 'Адрес',
    price: 'Цена',
    client: 'Клиент',
    manage: 'Перенести или отменить запись',
    directions: 'Как добраться',
    addToCalendar: 'Добавить в календарь',
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
      client_awaiting_approval: 'Your booking is waiting for the salon to confirm',
      salon_approval_needed: 'Booking to confirm',
    },
    intro: {
      client_confirmation: 'Your appointment is confirmed.',
      client_rescheduled: 'Your appointment time has changed.',
      client_cancelled: 'Your appointment has been cancelled.',
      client_reminder: 'A reminder about your appointment.',
      salon_new_booking: 'A new online booking.',
      salon_client_cancelled: 'A client cancelled their appointment.',
      salon_client_rescheduled: 'A client moved their appointment.',
      client_awaiting_approval:
        'The salon will confirm your booking — the time is held for you. We will write when the salon accepts it.',
      salon_approval_needed:
        'A client booked online. Under the cancellation protection rules this visit waits for confirmation — accept or cancel it in the calendar.',
    },
    service: 'Service',
    staff: 'Specialist',
    when: 'When',
    where: 'Address',
    price: 'Price',
    client: 'Client',
    manage: 'Change or cancel the appointment',
    directions: 'Get directions',
    addToCalendar: 'Add to calendar',
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
      client_awaiting_approval: 'Rezervasyonunuz salonun onayını bekliyor',
      salon_approval_needed: 'Onaylanacak rezervasyon',
    },
    intro: {
      client_confirmation: 'Randevunuz onaylandı.',
      client_rescheduled: 'Randevunuzun saati değiştirildi.',
      client_cancelled: 'Randevunuz iptal edildi.',
      client_reminder: 'Randevunuzu hatırlatırız.',
      salon_new_booking: 'İnternetten yeni bir rezervasyon.',
      salon_client_cancelled: 'Bir müşteri randevusunu iptal etti.',
      salon_client_rescheduled: 'Bir müşteri randevusunu başka bir saate taşıdı.',
      client_awaiting_approval:
        'Salon rezervasyonunuzu onaylayacak — saat sizin için ayrıldı. Salon kabul ettiğinde size yazacağız.',
      salon_approval_needed:
        'Bir müşteri çevrimiçi randevu aldı. İptal koruması kurallarına göre bu randevu onay bekliyor — takvimde kabul edin veya iptal edin.',
    },
    service: 'Hizmet',
    staff: 'Uzman',
    when: 'Tarih ve saat',
    where: 'Adres',
    price: 'Fiyat',
    client: 'Müşteri',
    manage: 'Randevuyu değiştir veya iptal et',
    directions: 'Yol tarifi',
    addToCalendar: 'Takvime ekle',
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
      client_awaiting_approval: 'Rezervimi pret konfirmimin e sallonit',
      salon_approval_needed: "Rezervim për t'u konfirmuar",
    },
    intro: {
      client_confirmation: 'Takimi juaj është konfirmuar.',
      client_rescheduled: 'Ora e takimit tuaj ka ndryshuar.',
      client_cancelled: 'Takimi juaj është anuluar.',
      client_reminder: 'Ju kujtojmë për takimin tuaj.',
      salon_new_booking: 'Një rezervim i ri përmes internetit.',
      salon_client_cancelled: 'Një klient anuloi takimin.',
      salon_client_rescheduled: 'Një klient e zhvendosi takimin në një orë tjetër.',
      client_awaiting_approval:
        "Salloni do ta konfirmojë rezervimin tuaj — ora është mbajtur për ju. Do t'ju shkruajmë kur salloni ta pranojë.",
      salon_approval_needed:
        'Një klient rezervoi online. Sipas rregullave të mbrojtjes nga anulimet, ky takim pret konfirmim — pranojeni ose anulojeni në kalendar.',
    },
    service: 'Shërbimi',
    staff: 'Specialisti',
    when: 'Data dhe ora',
    where: 'Adresa',
    price: 'Çmimi',
    client: 'Klienti',
    manage: 'Ndryshoni ose anuloni takimin',
    directions: 'Si të arrini',
    addToCalendar: 'Shtoje në kalendar',
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

/**
 * Task 361: Google Maps directions to the salon (the maps app on a phone, the site on a computer),
 * free and without a key; the salon's name goes with the address. The same link as "Jak dojechać"
 * on the booking pages and in the client app.
 */
export function directionsLink(salonName: string, address: string): string {
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(`${salonName}, ${address}`)}`;
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
  if (d.calendarLink) lines.push('', `${w.addToCalendar}:`, d.calendarLink);
  // Task 361: the way to the salon — in the client's emails about a visit that is still on.
  if (!forSalon && kind !== 'client_cancelled') {
    lines.push('', `${w.directions}:`, directionsLink(d.salonName, d.address));
  }
  return { subject: `${w.subjects[kind]} — ${d.salonName}`, text: lines.join('\n') };
}

/** Task 20: title and notes of the visit in the client's calendar, in the client's language. */
export function renderCalendarEvent(
  locale: Locale,
  d: Pick<AppointmentDetails, 'salonName' | 'serviceName' | 'staffName' | 'manageLink'>,
): { summary: string; description: string } {
  const w = WORDS[locale];
  const lines = [`${w.service}: ${d.serviceName}`, `${w.staff}: ${d.staffName}`];
  if (d.manageLink) lines.push('', `${w.manage}:`, d.manageLink);
  return { summary: `${d.serviceName} — ${d.salonName}`, description: lines.join('\n') };
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

/** Task 10f: "your points expire soon" — sent once for each date, a week before. */
const POINTS_EXPIRING: Record<
  Locale,
  { subject: string; text: (points: number, date: string, salon: string) => string }
> = {
  pl: {
    subject: 'Twoje punkty wkrótce wygasną',
    text: (points, date, salon) =>
      `W ${salon} masz punkty, które wygasną ${date}: ${points} pkt.\n\nWymień je na nagrodę przy najbliższej wizycie — stan punktów zobaczysz w „Moje wizyty” → „Moje bonusy”.`,
  },
  uk: {
    subject: 'Ваші бали скоро згорять',
    text: (points, date, salon) =>
      `У ${salon} у вас є бали, які згорять ${date}: ${points}.\n\nОбміняйте їх на нагороду під час найближчого візиту — баланс видно в «Мої візити» → «Мої бонуси».`,
  },
  ru: {
    subject: 'Ваши баллы скоро сгорят',
    text: (points, date, salon) =>
      `В ${salon} у вас есть баллы, которые сгорят ${date}: ${points}.\n\nОбменяйте их на награду при ближайшем визите — баланс виден в «Мои визиты» → «Мои бонусы».`,
  },
  en: {
    subject: 'Your points expire soon',
    text: (points, date, salon) =>
      `At ${salon} you have points that expire on ${date}: ${points}.\n\nExchange them for a reward on your next visit — see your balance in "My visits" → "My bonuses".`,
  },
  tr: {
    subject: 'Puanlarınızın süresi yakında doluyor',
    text: (points, date, salon) =>
      `${salon} salonunda ${date} tarihinde süresi dolacak puanlarınız var: ${points}.\n\nBir sonraki ziyaretinizde bunları bir ödülle değiştirin — bakiyenizi "Randevularım" → "Bonuslarım" bölümünde görebilirsiniz.`,
  },
  sq: {
    subject: 'Pikët tuaja skadojnë së shpejti',
    text: (points, date, salon) =>
      `Në ${salon} keni pikë që skadojnë më ${date}: ${points}.\n\nKëmbejini me një shpërblim në vizitën e ardhshme — gjendjen e shihni te "Takimet e mia" → "Bonuset e mia".`,
  },
};

export function renderPointsExpiringEmail(
  locale: Locale,
  input: { salonName: string; points: number; expiresAt: Date; timeZone: string },
): { subject: string; text: string } {
  const words = POINTS_EXPIRING[locale];
  const date = new Intl.DateTimeFormat(LOCALE_TAGS[locale], {
    timeZone: input.timeZone,
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(input.expiresAt);
  return { subject: words.subject, text: words.text(input.points, date, input.salonName) };
}
