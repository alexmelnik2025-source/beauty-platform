/** Polish — the base dictionary; the other languages must have exactly the same keys. */
export const pl = {
  appTitle: 'Salon',
  loading: 'Ładowanie…',
  signIn: {
    title: 'Zaloguj się',
    subtitle: 'Wpisz e-mail lub numer telefonu z zaproszenia. Wyślemy kod — bez hasła.',
    contact: 'E-mail lub telefon',
    badContact: 'Wpisz e-mail albo numer telefonu, np. +48 600 100 200.',
    sendCode: 'Wyślij kod',
    sentEmail: 'Wysłaliśmy 6-cyfrowy kod na {to}.',
    sentSms: 'Wysłaliśmy SMS z 6-cyfrowym kodem na {to}.',
    sentToInviteEmail:
      'SMS-y nie są jeszcze włączone — kod wysłaliśmy na e-mail podany w zaproszeniu.',
    code: 'Kod',
    confirm: 'Zaloguj się',
    badCode: 'Kod jest nieprawidłowy albo wygasł. Spróbuj jeszcze raz.',
    otherContact: 'Inny e-mail lub telefon',
  },
  salons: {
    title: 'Wybierz salon',
    none: 'Nie masz jeszcze dostępu do żadnego salonu. Poproś właściciela o zaproszenie.',
    role: { owner: 'Właściciel', manager: 'Menedżer', staff: 'Specjalista' },
  },
  day: {
    today: 'Dziś',
    previous: 'Poprzedni dzień',
    next: 'Następny dzień',
    empty: 'Brak wizyt tego dnia.',
    visits: 'Wizyty',
    working: 'Pracują',
    nobodyWorks: 'Nikt nie pracuje tego dnia.',
    walkIn: 'Klient bez karty',
    refresh: 'Odśwież',
    status: { confirmed: 'Potwierdzona', completed: 'Zakończona', no_show: 'Nie przyszedł' },
  },
  changeSalon: 'Zmień salon',
  signOut: 'Wyloguj się',
  language: 'Język',
  error: {
    network: 'Brak połączenia z serwerem. Sprawdź internet i spróbuj ponownie.',
    generic: 'Coś poszło nie tak. Spróbuj ponownie.',
    tooMany: 'Za dużo prób. Odczekaj chwilę.',
  },
};

export type Dictionary = typeof pl;
