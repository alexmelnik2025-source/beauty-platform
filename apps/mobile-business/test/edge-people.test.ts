import { describe, expect, it } from 'vitest';
import { ApiError, type Location, type StaffList } from '../src/api';
import { eraseErrorText } from '../src/clientPrivacy';
import {
  birthdayText,
  canEditNotes,
  dateIn,
  parseTags,
  splitVisits,
  suggestTags,
  visitWhen,
  type ClientVisit,
} from '../src/clients';
import { DICTIONARIES } from '../src/i18n';
import { messagesChanges, messagesForm } from '../src/messages';
import { badge, noticesOfSalon, type Notice } from '../src/notifications';
import { flags, languagesChanged, toggleLanguage, type SpokenLanguage } from '../src/profile';
import { appendReviews, reviewLine, starChips, type Review } from '../src/reviews';
import { profileChanges, profileForm } from '../src/staffProfile';
import { wishLines } from '../src/wishes';

const pl = DICTIONARIES.pl;

describe('client cards at the boundary of a day or field', () => {
  it('marks a New Year birthday starting at Warsaw midnight', () => {
    const birthday = (instant: string) =>
      birthdayText('01-01', 'pl', 'dziś', 'Europe/Warsaw', new Date(instant));

    expect(birthday('2026-12-31T22:59:59.999Z')).toBe('1 stycznia');
    expect(birthday('2026-12-31T23:00:00.000Z')).toBe('dziś');
  });

  it('shows a placeholder for a malformed birthday or an impossible day from the client card', () => {
    const now = new Date('2026-03-03T09:00:00Z');
    for (const birthday of ['bad', '02-31']) {
      expect(birthdayText(birthday, 'pl', 'dziś', 'Europe/Warsaw', now)).toBe('—');
    }
  });

  it('can display the client card when a past visit or coupon has an unreadable timestamp', () => {
    expect(visitWhen('not-a-date', 'Europe/Warsaw', 'pl')).toBe('—');
    expect(dateIn('not-a-date', 'Europe/Warsaw', 'pl')).toBe('—');
  });

  it('keeps a confirmed visit upcoming at its exact start and moves it to history one millisecond later', () => {
    const visit: ClientVisit = {
      id: 'visit',
      locationId: 'salon',
      start: '2026-12-31T23:00:00.000Z',
      status: 'confirmed',
      serviceName: 'Strzyżenie',
      staffName: 'Łucja',
    };
    const starting = new Date('2027-01-01T00:00:00.000+01:00');
    const started = new Date('2027-01-01T00:00:00.001+01:00');
    expect(splitVisits([visit], 'salon', starting)).toEqual({ upcoming: [visit], past: [] });
    expect(splitVisits([visit], 'salon', started)).toEqual({ upcoming: [], past: [visit] });
  });

  it('counts distinct tags after trimming and truncating, so repeated prefixes leave a slot free', () => {
    const prefix = 'Ł'.repeat(30);
    const rest = ['żółć', '💈', 'a', 'b', 'c', 'd', 'e', 'f', 'g'];
    const tags = [prefix + 'a', ' ', prefix + 'b', ...rest, 'extra'].join(', ');
    expect(parseTags(tags)).toEqual([prefix, ...rest]);
  });

  it('keeps a whole emoji at the tag length limit and drops it if only half fits', () => {
    const fits = 'ł'.repeat(28) + '💈';
    const prefix = 'ż'.repeat(29);
    expect(parseTags(`  ${fits}  , ${prefix}💈`)).toEqual([fits, prefix]);
  });

  it('suggests each Polish tag once and respects all ten occupied tag slots', () => {
    expect(suggestTags('', ['ŁÓDŹ', 'łódź', 'VIP'])).toEqual(['ŁÓDŹ', 'VIP']);
    const full = 'VIP, vip, a, b, c, d, e, f, g, h';
    expect(suggestTags(full, ['nowa'])).toEqual([]);
  });

  it.each([
    '{}',
    '{"role":"unknown","permissions":{"viewClientNotes":true,"editClientNotes":true}}',
    '{"role":"staff"}',
    '{"role":"staff","permissions":{"viewClientNotes":true}}',
  ])('keeps note editing unavailable for an incomplete or unknown identity: %s', (json) => {
    expect(canEditNotes(JSON.parse(json))).toBe(false);
  });

  it('explains a refused erasure when the API omits the upcoming visit count', () => {
    const error = new ApiError(409, 'Conflict', 'CUSTOMER_HAS_UPCOMING_VISITS', [
      { path: 'customerId', message: 'internal-id' },
    ]);
    expect(eraseErrorText(error, pl)).toBe(pl.clientPrivacy.upcoming);
  });
});

describe('client messages and feedback', () => {
  const saved = {
    reminderHoursBefore: 24,
    waitlistHoldMinutes: 10,
    rebookReminderDays: 30,
    rebookReminderText: 'Wróć do Łucji 💈',
  } as Location;
  const shown: Review = {
    id: 'shown',
    rating: 5,
    text: 'Świetnie 💈',
    staffId: 'staff',
    staffName: 'Łucja',
    serviceName: 'Strzyżenie',
    appointmentId: 'visit',
    visitStartAt: '2026-11-24T15:00:00Z',
    customerId: null,
    customerName: null,
    reply: null,
    repliedAt: null,
    createdAt: '2026-11-24T18:00:00Z',
    updatedAt: '2026-11-24T18:00:00Z',
  };

  it('leaves omitted rebooking settings alone when saving a different reminder time', () => {
    const partial = JSON.parse('{"reminderHoursBefore":24,"waitlistHoldMinutes":10}');
    const form = messagesForm(partial);
    expect(messagesChanges(partial, form)).toEqual({ changes: {} });
    expect(messagesChanges(partial, { ...form, reminderHoursBefore: 12 })).toEqual({
      changes: { reminderHoursBefore: 12 },
    });
  });

  it.each([7, 365])(
    'accepts the inclusive limit of %i days with surrounding whitespace',
    (days) => {
      const form = { ...messagesForm(saved), rebookDays: `\t${days}\n` };
      expect(messagesChanges(saved, form)).toEqual({ changes: { rebookReminderDays: days } });
    },
  );

  it('can turn reminders off with an unfinished day field and retain the saved Polish message', () => {
    const form = { ...messagesForm(saved), rebookOn: false, rebookDays: '3e' };
    expect(messagesChanges(saved, form)).toEqual({ changes: { rebookReminderDays: 0 } });
  });

  it('keeps the selected rating visible when the server omits the matching count', () => {
    expect(starChips([2], 5)).toEqual([
      { rating: 5, label: '★ 5 (0)' },
      { rating: 1, label: '★ 1 (2)' },
    ]);
    expect(starChips([], 5)).toEqual([{ rating: 5, label: '★ 5 (0)' }]);
  });

  it('preserves the first copy of each review when an older page repeats IDs within and across pages', () => {
    const older = { ...shown, id: 'older', text: 'Pierwsza wersja' };
    const page = [
      older,
      { ...older, text: 'Powtórzenie' },
      { ...shown, reply: 'Starsza odpowiedź' },
    ];
    expect(appendReviews([shown], page)).toEqual([shown, older]);
  });

  it('keeps the remaining review details visible for an anonymized client with an invalid visit date', () => {
    const review = { ...shown, visitStartAt: 'broken timestamp' };
    expect(reviewLine(review, pl, 'pl', 'Europe/Warsaw')).toBe(
      'Klient usunięty · Strzyżenie u Łucja',
    );
  });

  it('shows the last exact unread count before switching the bell to 99+', () => {
    expect(badge(99)).toBe('99');
    expect(badge(100)).toBe('99+');
  });

  it('lists valid notices for this salon even when another entry has no data', () => {
    const notice: Notice = {
      id: 'current',
      organizationId: 'org',
      appointmentId: null,
      type: 'appointment.cancelled',
      read: false,
      createdAt: '2026-11-26T10:00:00Z',
      data: {
        locationId: 'salon',
        start: '2026-11-26T11:00:00Z',
        date: '2026-11-26',
        time: '12:00',
        serviceName: 'Strzyżenie',
        staffName: 'Łucja',
        customerName: null,
        by: 'client',
      },
    };
    const missingData = JSON.parse('{"organizationId":"org","data":null}');
    const elsewhere = { ...notice, organizationId: 'another-org' };
    expect(noticesOfSalon([missingData, elsewhere, notice], 'org', 'salon')).toEqual([notice]);
  });

  it('displays an explicit drink refusal even when other answers are missing from the visit', () => {
    const wishes = JSON.parse('{"drink":"none"}');
    expect(wishLines(wishes, DICTIONARIES.uk.visit)).toEqual([
      `🙅 ${DICTIONARIES.uk.visit.drink.none}`,
    ]);
  });
});

describe('staff profiles', () => {
  const staff: StaffList[number] = {
    id: 'staff',
    locationId: 'salon',
    userId: null,
    displayName: 'Łucja',
    active: true,
    sortOrder: 0,
    version: 1,
    bio: null,
    customSpecialty: null,
    photoUrl: null,
    languages: [],
    specialties: ['barber'],
    serviceIds: ['cut'],
    createdAt: '2026-11-26T10:00:00Z',
    updatedAt: '2026-11-26T10:00:00Z',
  };

  it('shows duplicate saved languages once and clears all occurrences when the language is unticked', () => {
    const saved: SpokenLanguage[] = ['en', 'pl', 'en'];
    expect(flags(saved)).toBe('🇵🇱 🇬🇧');
    expect(toggleLanguage(saved, 'en')).toEqual(['pl']);
    expect(toggleLanguage(saved, 'uk')).toEqual(['pl', 'uk', 'en']);
  });

  it('can save a new language even if a duplicate in the saved list hid the change in length', () => {
    const saved: SpokenLanguage[] = ['pl', 'pl'];
    expect(languagesChanged(saved, toggleLanguage(saved, 'uk'))).toBe(true);
    expect(languagesChanged(saved, ['pl'])).toBe(false);
  });

  it('can remove the last assigned service without accidentally changing the loaded profile', () => {
    const form = profileForm(staff);
    form.serviceIds.pop();
    expect(profileChanges(staff, form)).toEqual({ change: null, serviceIds: [] });
    expect(staff.serviceIds).toEqual(['cut']);
  });

  it('sends each remaining service once when an assignment is removed from a list with duplicates', () => {
    const saved = { ...staff, serviceIds: ['cut', 'beard'] };
    const form = { ...profileForm(saved), serviceIds: ['cut', 'cut'] };
    expect(profileChanges(saved, form)).toEqual({ change: null, serviceIds: ['cut'] });
    expect(profileChanges(staff, form)).toEqual({ change: null, serviceIds: null });
  });
});
