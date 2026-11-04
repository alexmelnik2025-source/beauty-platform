/** Polish — the base dictionary; the other languages must have exactly the same keys. */
export const pl = {
  appTitle: 'Wizyty',
  signIn: {
    title: 'Moje wizyty',
    subtitle:
      'Wszystkie Twoje wizyty we wszystkich salonach — bez hasła i zakładania konta. Podaj e-mail, na który się umawiasz.',
    email: 'E-mail',
    badEmail: 'Wpisz adres e-mail, np. anna@example.com.',
    sendCode: 'Wyślij kod',
    sent: 'Wysłaliśmy 6-cyfrowy kod na {email}. Jest ważny 10 minut.',
    code: 'Kod z e-maila',
    confirm: 'Zaloguj się',
    badCode: 'Kod jest nieprawidłowy. Sprawdź e-mail i spróbuj ponownie.',
    newCodeNeeded: 'Ten kod już nie działa. Wyślij nowy.',
    resend: 'Wyślij kod ponownie',
    otherEmail: 'Inny e-mail',
  },
  visits: {
    title: 'Moje wizyty',
    signedInAs: 'Zalogowano jako {email}',
    upcoming: 'Nadchodzące',
    past: 'Historia',
    emptyUpcoming: 'Nie masz zaplanowanych wizyt.',
    emptyPast: 'Tu pojawią się Twoje wcześniejsze wizyty.',
    refresh: 'Odśwież',
    signOut: 'Wyloguj się',
    minutes: 'min',
    with: 'u: {staff}',
    status: {
      held: 'Rezerwacja w toku',
      confirmed: 'Potwierdzona',
      completed: 'Odbyła się',
      no_show: 'Nieobecność',
      cancelled: 'Odwołana',
      expired: 'Niedokończona',
    },
  },
  language: 'Język',
  error: {
    network: 'Brak połączenia z serwerem. Sprawdź internet i spróbuj ponownie.',
    generic: 'Coś poszło nie tak. Spróbuj ponownie.',
    tooMany: 'Za dużo prób. Odczekaj chwilę.',
  },
};

export type Dictionary = typeof pl;
