import type { Locale } from '../generated/prisma/client';
import { LOCALE_TAGS } from './booking-templates';

/** Task 24: "a time freed up" — one email per waiting-list entry. */
const WORDS: Record<
  Locale,
  {
    subject: (salon: string) => string;
    text: (v: { salon: string; day: string; service: string; staff: string | null }) => string;
    times: string;
    book: string;
    once: string;
  }
> = {
  pl: {
    subject: (salon) => `Zwolnił się termin — ${salon}`,
    text: (v) =>
      `Dobra wiadomość! W ${v.salon} zwolnił się termin ${v.day} na usługę „${v.service}”${v.staff ? ` u ${v.staff}` : ''}.`,
    times: 'Wolne godziny',
    book: 'Kto pierwszy, ten lepszy — umów się tutaj',
    once: 'To jedno powiadomienie z listy oczekujących. Jeśli ten czas się zajmie, zapisz się na listę ponownie.',
  },
  uk: {
    subject: (salon) => `Звільнився час — ${salon}`,
    text: (v) =>
      `Гарна новина! У ${v.salon} звільнився час ${v.day} на послугу «${v.service}»${v.staff ? ` у ${v.staff}` : ''}.`,
    times: 'Вільні години',
    book: 'Хто перший, той і записався — запис тут',
    once: 'Це одне повідомлення зі списку очікування. Якщо час займуть, запишіться в список ще раз.',
  },
  ru: {
    subject: (salon) => `Освободилось время — ${salon}`,
    text: (v) =>
      `Хорошая новость! В ${v.salon} освободилось время ${v.day} на услугу «${v.service}»${v.staff ? ` у ${v.staff}` : ''}.`,
    times: 'Свободные часы',
    book: 'Кто первый, тот и записался — запись здесь',
    once: 'Это одно уведомление из листа ожидания. Если время займут, запишитесь в лист ещё раз.',
  },
  en: {
    subject: (salon) => `A time has freed up — ${salon}`,
    text: (v) =>
      `Good news! At ${v.salon} a time has freed up on ${v.day} for “${v.service}”${v.staff ? ` with ${v.staff}` : ''}.`,
    times: 'Free times',
    book: 'First come, first served — book here',
    once: 'This is a single notice from the waiting list. If the time is taken, join the list again.',
  },
  tr: {
    subject: (salon) => `Boş bir saat açıldı — ${salon}`,
    text: (v) =>
      `İyi haber! ${v.salon} salonunda ${v.day} günü “${v.service}” için bir saat boşaldı${v.staff ? ` (${v.staff})` : ''}.`,
    times: 'Boş saatler',
    book: 'İlk gelen alır — buradan randevu alın',
    once: 'Bu, bekleme listesinden tek bir bildirimdir. Saat dolarsa listeye yeniden katılın.',
  },
  sq: {
    subject: (salon) => `U lirua një orar — ${salon}`,
    text: (v) =>
      `Lajm i mirë! Në ${v.salon} u lirua një orar më ${v.day} për “${v.service}”${v.staff ? ` me ${v.staff}` : ''}.`,
    times: 'Oraret e lira',
    book: 'Kush vjen i pari — rezervoni këtu',
    once: 'Ky është një njoftim i vetëm nga lista e pritjes. Nëse orari zihet, regjistrohuni përsëri në listë.',
  },
};

/** The salon's local day YYYY-MM-DD as "środa, 5 listopada". */
export function formatWaitlistDay(date: string, locale: Locale): string {
  return new Intl.DateTimeFormat(LOCALE_TAGS[locale], {
    timeZone: 'UTC',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(new Date(`${date}T12:00:00Z`));
}

export function renderWaitlistEmail(
  locale: Locale,
  input: {
    salonName: string;
    date: string;
    serviceName: string;
    staffName: string | null;
    /** Local times "HH:MM", soonest first. */
    times: string[];
    link: string;
  },
): { subject: string; text: string } {
  const w = WORDS[locale];
  const intro = w.text({
    salon: input.salonName,
    day: formatWaitlistDay(input.date, locale),
    service: input.serviceName,
    staff: input.staffName,
  });
  return {
    subject: w.subject(input.salonName),
    text: `${intro}\n\n${w.times}: ${input.times.join(', ')}\n\n${w.book}: ${input.link}\n\n${w.once}`,
  };
}
