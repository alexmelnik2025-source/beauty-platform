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
  /** Task 164: a time is held for the client for `minutes`. */
  offerSubject: string;
  offer: (what: string, day: string, time: string, minutes: number) => string;
  answer: string;
  next: string;
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
    offerSubject: 'Termin czeka na Ciebie',
    offer: (what, day, time, minutes) =>
      `Zwolnił się termin: ${what}, ${day}, godz. ${time}. Trzymamy go dla Ciebie przez ${minutes} minut.`,
    answer: 'Potwierdź lub odmów',
    next: 'Jeśli nie odpowiesz, zaproponujemy go następnej osobie z listy.',
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
    offerSubject: 'Час чекає на вас',
    offer: (what, day, time, minutes) =>
      `Звільнився час: ${what}, ${day}, о ${time}. Ми тримаємо його для вас ${minutes} хвилин.`,
    answer: 'Підтвердіть або відмовтеся',
    next: 'Якщо ви не відповісте, ми запропонуємо його наступній людині зі списку.',
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
    offerSubject: 'Время ждёт вас',
    offer: (what, day, time, minutes) =>
      `Освободилось время: ${what}, ${day}, в ${time}. Мы держим его для вас ${minutes} минут.`,
    answer: 'Подтвердите или откажитесь',
    next: 'Если вы не ответите, мы предложим его следующему человеку из списка.',
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
    offerSubject: 'A time is waiting for you',
    offer: (what, day, time, minutes) =>
      `A time has become free: ${what}, ${day}, at ${time}. We are holding it for you for ${minutes} minutes.`,
    answer: 'Take it or say no',
    next: 'If you do not answer, we will offer it to the next person on the list.',
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
    offerSubject: 'Bir saat sizi bekliyor',
    offer: (what, day, time, minutes) =>
      `Bir saat boşaldı: ${what}, ${day}, saat ${time}. Bu saati ${minutes} dakika boyunca sizin için tutuyoruz.`,
    answer: 'Onaylayın veya reddedin',
    next: 'Yanıt vermezseniz listedeki bir sonraki kişiye önereceğiz.',
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
    offerSubject: 'Një orar ju pret',
    offer: (what, day, time, minutes) =>
      `U lirua një orar: ${what}, ${day}, në orën ${time}. Ua mbajmë për ${minutes} minuta.`,
    answer: 'Konfirmoni ose refuzoni',
    next: 'Nëse nuk përgjigjeni, do t’ia ofrojmë personit tjetër në listë.',
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

/** Task 164: the earliest freed time is held for the client; the link takes it or says no. */
export function renderWaitlistOfferEmail(
  locale: Locale,
  d: WaitlistDetails,
  time: string,
  minutes: number,
  offerLink: string,
): { subject: string; text: string } {
  const words = WORDS[locale];
  return {
    subject: `${words.offerSubject}: ${d.salonName}`,
    text:
      `${words.offer(what(words, d), dayText(d.date, locale), time, minutes)}\n\n` +
      `${words.answer}: ${offerLink}\n\n${words.next}`,
  };
}
