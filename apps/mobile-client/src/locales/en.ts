import type { Dictionary } from './pl';

export const en: Dictionary = {
  appTitle: 'Visits',
  signIn: {
    title: 'My visits',
    subtitle:
      'All your appointments in every salon — no password, no account to create. Enter the email you book with.',
    email: 'Email',
    badEmail: 'Enter an email address, e.g. anna@example.com.',
    sendCode: 'Send code',
    sent: 'We sent a 6-digit code to {email}. It is valid for 10 minutes.',
    code: 'Code from the email',
    confirm: 'Sign in',
    badCode: 'The code is wrong. Check your email and try again.',
    newCodeNeeded: 'This code no longer works. Send a new one.',
    resend: 'Send the code again',
    otherEmail: 'Another email',
  },
  visits: {
    title: 'My visits',
    signedInAs: 'Signed in as {email}',
    upcoming: 'Upcoming',
    past: 'History',
    emptyUpcoming: 'You have no upcoming appointments.',
    emptyPast: 'Your past appointments will appear here.',
    refresh: 'Refresh',
    signOut: 'Sign out',
    minutes: 'min',
    with: 'with {staff}',
    status: {
      held: 'Booking in progress',
      confirmed: 'Confirmed',
      completed: 'Completed',
      no_show: 'Missed',
      cancelled: 'Cancelled',
      expired: 'Not finished',
    },
  },
  language: 'Language',
  error: {
    network: 'No connection to the server. Check the internet and try again.',
    generic: 'Something went wrong. Please try again.',
    tooMany: 'Too many attempts. Please wait a moment.',
  },
};
