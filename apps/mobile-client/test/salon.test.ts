import { describe, expect, it } from 'vitest';
import type { DirectorySalon, PublicLocation } from '../src/api';
import {
  addressText,
  directionsUrl,
  durationText,
  filterSalons,
  openingRows,
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
