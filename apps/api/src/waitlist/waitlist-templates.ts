import { LOCALE_TAGS } from '../booking/booking-templates';
import type { Locale } from '../generated/prisma/client';

/** What the waiting-list emails say: the salon, the service, the day, the specialist (if chosen). */
export interface WaitlistDetails {
  salonName: string;
  serviceName: string;
  /** null = any specialist. */
  staffName: string | null;
  /** YYYY-MM-DD in the salon's time zone. */
  date: string;
}

interface Words {
  joinedSubject: string;
  joined: (what: string, day: string) => string;
  freeSubject: string;
  free: (what: string, day: string, times: string) => string;
  at: (name: string) => string;
  book: string;
  leave: string;
  /** Said once, at the end of every waiting-list email. */
  once: string;
}

const WORDS: Record<Locale, Words> = {
  pl: {
    joinedSubject: 'Jesteś na liście oczekujących',
    joined: (what, day) =>
      `Zapisaliśmy Cię na listę oczekujących: ${what}, ${day}. Gdy zwolni się termin, napiszemy do Ciebie.`,
    freeSubject: 'Zwolnił się termin',
    free: (what, day, times) =>
      `Zwolnił się termin: ${what}, ${day}. Wolne godziny: ${times}. Kto pierwszy, ten lepszy.`,
    at: (name) => `u ${name}`,
    book: 'Zarezerwuj',
    leave: 'Nie chcesz już czekać? Wypisz się z listy',
    once: 'Napiszemy tylko raz.',
  },
  uk: {
    joinedSubject: 'Ви в листі очікування',
    joined: (what, day) =>
      `Ми записали вас у лист очікування: ${what}, ${day}. Щойно звільниться час, ми вам напишемо.`,
    freeSubject: 'Звільнився час',
    free: (what, day, times) =>
      `Звільнився час: ${what}, ${day}. Вільні години: ${times}. Хто перший — того й час.`,
    at: (name) => `у ${name}`,
    book: 'Записатися',
    leave: 'Більше не хочете чекати? Вийти зі списку',
    once: 'Ми напишемо лише один раз.',
  },
  ru: {
    joinedSubject: 'Вы в листе ожидания',
    joined: (what, day) =>
      `Мы записали вас в лист ожидания: ${what}, ${day}. Как только освободится время, мы вам напишем.`,
    freeSubject: 'Освободилось время',
    free: (what, day, times) =>
      `Освободилось время: ${what}, ${day}. Свободные часы: ${times}. Кто первый — того и время.`,
    at: (name) => `у ${name}`,
    book: 'Записаться',
    leave: 'Больше не хотите ждать? Выйти из списка',
    once: 'Мы напишем только один раз.',
  },
  en: {
    joinedSubject: 'You are on the waiting list',
    joined: (what, day) =>
      `You are on the waiting list: ${what}, ${day}. We will write to you when a time becomes free.`,
    freeSubject: 'A time has become free',
    free: (what, day, times) =>
      `A time has become free: ${what}, ${day}. Free times: ${times}. First come, first served.`,
    at: (name) => `with ${name}`,
    book: 'Book',
    leave: 'No longer want to wait? Leave the list',
    once: 'We write only once.',
  },
  tr: {
    joinedSubject: 'Bekleme listesindesiniz',
    joined: (what, day) =>
      `Sizi bekleme listesine ekledik: ${what}, ${day}. Bir saat boşaldığında size yazacağız.`,
    freeSubject: 'Bir saat boşaldı',
    free: (what, day, times) =>
      `Bir saat boşaldı: ${what}, ${day}. Boş saatler: ${times}. İlk gelen alır.`,
    at: (name) => `${name} ile`,
    book: 'Randevu al',
    leave: 'Artık beklemek istemiyor musunuz? Listeden çıkın',
    once: 'Yalnızca bir kez yazarız.',
  },
  sq: {
    joinedSubject: 'Jeni në listën e pritjes',
    joined: (what, day) =>
      `Ju shtuam në listën e pritjes: ${what}, ${day}. Kur të lirohet një orar, do t’ju shkruajmë.`,
    freeSubject: 'U lirua një orar',
    free: (what, day, times) =>
      `U lirua një orar: ${what}, ${day}. Oraret e lira: ${times}. Kush vjen i pari, e merr.`,
    at: (name) => `te ${name}`,
    book: 'Rezervo',
    leave: 'Nuk doni më të prisni? Dilni nga lista',
    once: 'Shkruajmë vetëm një herë.',
  },
};

function dayText(date: string, locale: Locale): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Intl.DateTimeFormat(LOCALE_TAGS[locale], {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(y, m - 1, d)));
}

function what(words: Words, d: WaitlistDetails): string {
  return `${d.serviceName}${d.staffName ? ` ${words.at(d.staffName)}` : ''} (${d.salonName})`;
}

export function renderWaitlistJoinedEmail(
  locale: Locale,
  d: WaitlistDetails,
  leaveLink: string,
): { subject: string; text: string } {
  const words = WORDS[locale];
  return {
    subject: words.joinedSubject,
    text: `${words.joined(what(words, d), dayText(d.date, locale))}\n\n${words.leave}: ${leaveLink}`,
  };
}

/** `times`: the free start times, "14:30" in the salon's time zone (the first few). */
export function renderWaitlistFreeEmail(
  locale: Locale,
  d: WaitlistDetails,
  times: string[],
  bookLink: string,
): { subject: string; text: string } {
  const words = WORDS[locale];
  return {
    subject: `${words.freeSubject}: ${d.salonName}`,
    text:
      `${words.free(what(words, d), dayText(d.date, locale), times.join(', '))}\n\n` +
      `${words.book}: ${bookLink}\n\n${words.once}`,
  };
}
