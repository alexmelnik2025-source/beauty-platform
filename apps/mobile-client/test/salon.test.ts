import { describe, expect, it } from 'vitest';
import type { DirectorySalon, PublicLocation } from '../src/api';
import {
  addressText,
  directionsUrl,
  durationText,
  filterSalons,
  nearbyOnly,
  openingRows,
  openStatus,
  openStatusText,
  salonNow,
  serviceGroups,
  specialtyText,
} from '../src/salon';
import { formatPrice } from '../src/format';
import { pl } from '../src/locales/pl';

const salon = (name: string, city: string, addressLine = 'ul. Prosta 1'): DirectorySalon => ({
  slug: name.toLowerCase().replace(/\s+/g, '-'),
  name,
  addressLine,
  city,
  postalCode: '00-001',
  languages: ['pl'],
  latitude: null,
  longitude: null,
  currency: 'PLN',
  priceFromGrosze: 5000,
  staffSpeaking: null,
  specialties: ['barber'],
  photoUrl: null,
  distanceKm: null,
  rating: null,
  reviewCount: 0,
  timezone: 'Europe/Warsaw',
  todayHours: [],
});

const location = (patch: Partial<PublicLocation> = {}): PublicLocation => ({
  slug: 'gestalt',
  name: 'Gestalt Barbershop',
  addressLine: 'ul. Józefa Bema 91',
  city: 'Warszawa',
  postalCode: '01-233',
  phone: null,
  timezone: 'Europe/Warsaw',
  currency: 'PLN',
  defaultLocale: 'pl',
  languages: ['pl'],
  description: null,
  openingHours: [],
  todayHours: { date: '2027-03-10', intervals: [] },
  photos: [],
  wishQuestions: { mood: true, drinks: [], note: true },
  codeChannels: ['email'],
  categories: [],
  services: [],
  staff: [],
  ...patch,
});

const service = (id: string, categoryId: string | null) => ({
  id,
  categoryId,
  name: id,
  description: null,
  durationMinutes: 45,
  priceGrosze: 9000,
  priceFromGrosze: 9000,
  priceToGrosze: 9000,
  durationFromMinutes: 45,
  durationToMinutes: 45,
  wishPhotos: false,
});

describe('catalogue search', () => {
  const items = [
    salon('Gestalt Barbershop', 'Warszawa', 'ul. Józefa Bema 91'),
    salon('Studio Łódź', 'Łódź'),
    salon('Nails & Brows', 'Kraków'),
  ];

  it('finds by name, city or street; accents and case do not matter', () => {
    expect(filterSalons(items, '').map((s) => s.name)).toHaveLength(3);
    expect(filterSalons(items, 'lodz').map((s) => s.name)).toEqual(['Studio Łódź']);
    expect(filterSalons(items, 'KRAKOW').map((s) => s.name)).toEqual(['Nails & Brows']);
    expect(filterSalons(items, 'bema warszawa').map((s) => s.name)).toEqual(['Gestalt Barbershop']);
    expect(filterSalons(items, 'bema kraków')).toEqual([]);
  });

  it('writes the address in one line', () => {
    expect(addressText(items[0]!)).toBe('ul. Józefa Bema 91, 00-001 Warszawa');
  });
});

describe('salon page', () => {
  it('formats prices and durations', () => {
    expect(formatPrice(9000, 'PLN', 'pl').replace(/\s/g, ' ')).toBe('90,00 zł');
    expect(durationText(45, pl.units)).toBe('45 min');
    expect(durationText(60, pl.units)).toBe('1 godz.');
    expect(durationText(75, pl.units)).toBe('1 godz. 15 min');
  });

  it('groups the price list in the salon’s order, services without a group last', () => {
    const groups = serviceGroups(
      location({
        categories: [
          { id: 'hair', name: 'Włosy' },
          { id: 'empty', name: 'Pusta' },
          { id: 'beard', name: 'Broda' },
        ],
        services: [service('s1', 'beard'), service('s2', null), service('s3', 'hair')],
      }),
    );
    expect(groups.map((g) => [g.name, g.services.map((s) => s.id)])).toEqual([
      ['Włosy', ['s3']],
      ['Broda', ['s1']],
      [null, ['s2']],
    ]);
  });

  it('shows Monday to Sunday, closed days without hours', () => {
    const rows = openingRows(
      location({
        openingHours: [
          { weekday: 1, intervals: [{ start: '09:00', end: '18:00' }] },
          {
            weekday: 6,
            intervals: [
              { start: '09:00', end: '13:00' },
              { start: '14:00', end: '16:00' },
            ],
          },
        ],
      }),
      'pl',
    );
    expect(rows).toHaveLength(7);
    expect(rows[0]).toEqual({ weekday: 1, name: 'poniedziałek', hours: '09:00–18:00' });
    expect(rows[5]!.hours).toBe('09:00–13:00, 14:00–16:00');
    expect(rows[6]).toEqual({ weekday: 7, name: 'niedziela', hours: null });
  });

  it('names the specialist’s trades, the custom one last', () => {
    expect(
      specialtyText(
        {
          id: 'k',
          displayName: 'Kasia',
          bio: null,
          languages: [],
          specialties: ['barber', 'hairdresser'],
          customSpecialty: 'Trycholog',
          serviceIds: [],
          prices: [],
          photoUrl: null,
          rating: null,
          reviewCount: 0,
        },
        pl.specialty,
      ),
    ).toBe('Barber · Fryzjer · Trycholog');
  });
});

describe('"Jak dojechać" (task 359)', () => {
  const salon = {
    name: 'GESTALT',
    addressLine: 'ul. Józefa Bema 91',
    postalCode: '01-233',
    city: 'Warszawa',
  };

  it('opens Apple Maps on an iPhone and Google Maps elsewhere, with the name and address', () => {
    const query = encodeURIComponent('GESTALT, ul. Józefa Bema 91, 01-233 Warszawa');
    expect(directionsUrl(salon, 'ios')).toBe(`https://maps.apple.com/?daddr=${query}`);
    expect(directionsUrl(salon, 'android')).toBe(
      `https://www.google.com/maps/dir/?api=1&destination=${query}`,
    );
    expect(directionsUrl(salon, 'web')).toBe(directionsUrl(salon, 'android'));
  });

  it('keeps "&" and "#" in a name inside the address', () => {
    const url = new URL(directionsUrl({ ...salon, name: 'Barber & Co #1' }, 'web'));
    expect(url.searchParams.get('destination')).toBe(
      'Barber & Co #1, ul. Józefa Bema 91, 01-233 Warszawa',
    );
  });
});

describe('"Otwarte teraz" (task 362)', () => {
  // 2027-03-10 is a Wednesday (ISO 3).
  const weekly = [
    { weekday: 3, intervals: [{ start: '09:00', end: '17:00' }] },
    { weekday: 5, intervals: [{ start: '10:00', end: '18:00' }] },
  ];
  const wednesday = (minute: number) => ({ date: '2027-03-10', weekday: 3, minute });
  const today = (intervals: { start: string; end: string }[]) =>
    location({ openingHours: weekly, todayHours: { date: '2027-03-10', intervals } });

  it('open now, until the end of the hours without a break', () => {
    const s = openStatus(
      today([
        { start: '14:00', end: '20:00' },
        { start: '09:00', end: '14:00' },
      ]),
      wednesday(600),
    );
    expect(s).toEqual({ kind: 'open', until: '20:00' });
    expect(openStatusText(s, pl.salon, 'pl')).toBe('Otwarte · do 20:00');
    expect(openStatusText({ kind: 'open', until: '24:00' }, pl.salon, 'pl')).toBe(
      'Otwarte · do północy',
    );
  });

  it('closed now, opens later today (a break or before opening)', () => {
    const s = openStatus(
      today([
        { start: '09:00', end: '12:00' },
        { start: '13:00', end: '17:00' },
      ]),
      wednesday(12 * 60 + 30),
    );
    expect(s).toEqual({ kind: 'opensToday', at: '13:00' });
    expect(openStatusText(s, pl.salon, 'pl')).toBe('Zamknięte · otwarcie o 13:00');
  });

  it('closed for the rest of the day: the next day with hours', () => {
    // A vacation today: the API says closed, although the weekly table says 09:00–17:00.
    const s = openStatus(today([]), wednesday(600));
    expect(s).toEqual({ kind: 'opensLater', inDays: 2, weekday: 5, at: '10:00' });
    expect(openStatusText(s, pl.salon, 'pl')).toBe('Zamknięte · otwarcie: piątek, 10:00');
    expect(
      openStatusText({ kind: 'opensLater', inDays: 1, weekday: 4, at: '09:00' }, pl.salon, 'pl'),
    ).toBe('Zamknięte · otwarcie: jutro, 09:00');
    // From Friday evening the week goes round to Wednesday.
    expect(
      openStatus(location({ openingHours: weekly }), {
        date: '2027-03-12',
        weekday: 5,
        minute: 1100,
      }),
    ).toEqual({ kind: 'opensLater', inDays: 5, weekday: 3, at: '09:00' });
  });

  it('today’s hours of another date are not used (the page was opened yesterday)', () => {
    expect(
      openStatus(location({ openingHours: weekly }), {
        date: '2027-03-17',
        weekday: 3,
        minute: 600,
      }),
    ).toEqual({ kind: 'open', until: '17:00' });
  });

  it('no hours at all: closed', () => {
    const s = openStatus(location({}), wednesday(600));
    expect(s).toEqual({ kind: 'closed' });
    expect(openStatusText(s, pl.salon, 'pl')).toBe('Zamknięte');
  });

  it('reads the date and time in the salon’s time zone', () => {
    // 23:30 UTC on Tuesday is already Wednesday 00:30 in Warsaw (UTC+1 until 28 March).
    expect(salonNow(Date.UTC(2027, 2, 9, 23, 30), 'Europe/Warsaw')).toEqual({
      date: '2027-03-10',
      weekday: 3,
      minute: 30,
    });
  });
});

describe('nearbyOnly (task 401)', () => {
  it('keeps the neighbours with a place on the map within 30 km, in their order', () => {
    const salons = [
      { slug: 'a', distanceKm: 2.3 },
      { slug: 'b', distanceKm: 30 },
      { slug: 'c', distanceKm: 30.1 },
      { slug: 'd', distanceKm: null },
    ];
    expect(nearbyOnly(salons).map((s) => s.slug)).toEqual(['a', 'b']);
  });
});
