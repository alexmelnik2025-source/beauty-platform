import { describe, expect, it } from 'vitest';
import { ApiError, type Location } from '../src/api';
import {
  formatCoordinates,
  maySeeSalon,
  parseCoordinates,
  SLOT_STEPS,
  salonChanges,
  salonForm,
  saveProblem,
  toggleDrink,
} from '../src/salon';

const salon = (over: Partial<Location> = {}) =>
  ({
    id: 'loc-1',
    organizationId: 'org-1',
    name: 'Gestalt Barbershop',
    slug: 'gestalt',
    timezone: 'Europe/Warsaw',
    currency: 'PLN',
    addressLine: 'ul. Józefa Bema 91',
    city: 'Warszawa',
    postalCode: '01-233',
    phone: '+48221234567',
    email: null,
    description: null,
    onlineBookingEnabled: false,
    minLeadMinutes: 60,
    bookingHorizonDays: 60,
    clientCancelDeadlineMinutes: 120,
    slotStepMinutes: 15,
    askMood: true,
    askDrink: true,
    drinks: ['coffee', 'water'],
    askNote: false,
    latitude: null,
    longitude: null,
    version: 3,
    ...over,
  }) as Location;

describe('salonForm', () => {
  it('starts with the salon as saved, empty texts for what is not set', () => {
    expect(salonForm(salon({ phone: null }))).toEqual({
      name: 'Gestalt Barbershop',
      addressLine: 'ul. Józefa Bema 91',
      city: 'Warszawa',
      postalCode: '01-233',
      phone: '',
      description: '',
      onlineBookingEnabled: false,
      minLeadMinutes: '60',
      bookingHorizonDays: '60',
      clientCancelDeadlineMinutes: '120',
      slotStepMinutes: 15,
      askMood: true,
      askDrink: true,
      drinks: ['coffee', 'water'],
      askNote: false,
      coordinates: '',
    });
  });
});

describe('salonChanges', () => {
  it('sends nothing when nothing changed (spaces around do not count)', () => {
    const form = { ...salonForm(salon()), name: '  Gestalt Barbershop ' };
    expect(salonChanges(salon(), form)).toEqual({ changes: {} });
  });

  it('sends only what changed', () => {
    const form = {
      ...salonForm(salon()),
      city: 'Kraków',
      description: ' Strzyżemy od 2015 roku. ',
      onlineBookingEnabled: true,
    };
    expect(salonChanges(salon(), form)).toEqual({
      changes: {
        city: 'Kraków',
        description: 'Strzyżemy od 2015 roku.',
        onlineBookingEnabled: true,
      },
    });
  });

  it("adds the salon's country code to a phone typed without one", () => {
    const form = { ...salonForm(salon()), phone: '600 100 200' };
    expect(salonChanges(salon(), form)).toEqual({ changes: { phone: '+48600100200' } });
    const istanbul = salon({ timezone: 'Europe/Istanbul', phone: null });
    expect(salonChanges(istanbul, { ...salonForm(istanbul), phone: '532 123 45 67' })).toEqual({
      changes: { phone: '+905321234567' },
    });
  });

  it('an empty phone and an empty description remove them', () => {
    const saved = salon({ description: 'Stary opis' });
    expect(salonChanges(saved, { ...salonForm(saved), phone: ' ', description: '' })).toEqual({
      changes: { phone: null, description: '' },
    });
  });

  it('names what is missing or wrong, as the server would', () => {
    const form = salonForm(salon());
    expect(salonChanges(salon(), { ...form, name: ' ' })).toEqual({ problem: 'name' });
    expect(salonChanges(salon(), { ...form, addressLine: '' })).toEqual({ problem: 'address' });
    expect(salonChanges(salon(), { ...form, city: '' })).toEqual({ problem: 'city' });
    expect(salonChanges(salon(), { ...form, postalCode: '1' })).toEqual({ problem: 'postalCode' });
    expect(salonChanges(salon(), { ...form, phone: '12' })).toEqual({ problem: 'phone' });
  });
});

describe('salonChanges — booking rules (task 319)', () => {
  it('sends only the rules that changed, as numbers', () => {
    const form = {
      ...salonForm(salon()),
      minLeadMinutes: ' 30 ',
      bookingHorizonDays: '90',
      slotStepMinutes: 30,
    };
    expect(salonChanges(salon(), form)).toEqual({
      changes: { minLeadMinutes: 30, bookingHorizonDays: 90, slotStepMinutes: 30 },
    });
  });

  it('allows 0 minutes (book and change until the last moment) and a whole week', () => {
    const form = {
      ...salonForm(salon()),
      minLeadMinutes: '0',
      clientCancelDeadlineMinutes: '10080',
    };
    expect(salonChanges(salon(), form)).toEqual({
      changes: { minLeadMinutes: 0, clientCancelDeadlineMinutes: 10080 },
    });
  });

  it('names a rule outside what the server allows', () => {
    const form = salonForm(salon());
    expect(salonChanges(salon(), { ...form, minLeadMinutes: '' })).toEqual({ problem: 'lead' });
    expect(salonChanges(salon(), { ...form, minLeadMinutes: '10081' })).toEqual({
      problem: 'lead',
    });
    expect(salonChanges(salon(), { ...form, minLeadMinutes: '1.5' })).toEqual({ problem: 'lead' });
    expect(salonChanges(salon(), { ...form, bookingHorizonDays: '0' })).toEqual({
      problem: 'horizon',
    });
    expect(salonChanges(salon(), { ...form, bookingHorizonDays: '366' })).toEqual({
      problem: 'horizon',
    });
    expect(salonChanges(salon(), { ...form, clientCancelDeadlineMinutes: '-5' })).toEqual({
      problem: 'deadline',
    });
  });

  it('offers the steps the server accepts', () => {
    expect([...SLOT_STEPS]).toEqual([5, 10, 15, 30]);
  });
});

describe('salonChanges — questions on booking (task 320)', () => {
  it('sends only the questions that changed', () => {
    const form = { ...salonForm(salon()), askMood: false, askNote: true };
    expect(salonChanges(salon(), form)).toEqual({ changes: { askMood: false, askNote: true } });
  });

  it('sends the drinks only when the set changed, not the order', () => {
    const reordered = { ...salonForm(salon()), drinks: ['water', 'coffee'] as const };
    expect(salonChanges(salon(), { ...reordered, drinks: [...reordered.drinks] })).toEqual({
      changes: {},
    });
    const withTea = { ...salonForm(salon()), drinks: toggleDrink(['coffee', 'water'], 'tea') };
    expect(salonChanges(salon(), withTea)).toEqual({
      changes: { drinks: ['coffee', 'tea', 'water'] },
    });
  });
});

describe('salonChanges — place on the map (task 321)', () => {
  it('sends both numbers as pasted from Google Maps', () => {
    const form = { ...salonForm(salon()), coordinates: ' 52.23251, 20.95634 ' };
    expect(salonChanges(salon(), form)).toEqual({
      changes: { latitude: 52.23251, longitude: 20.95634 },
    });
  });

  it('sends nothing when the place is the same, and removes it when emptied', () => {
    const placed = salon({ latitude: 52.23251, longitude: 20.95634 });
    expect(salonForm(placed).coordinates).toBe('52.23251, 20.95634');
    expect(salonChanges(placed, salonForm(placed))).toEqual({ changes: {} });
    expect(salonChanges(placed, { ...salonForm(placed), coordinates: '' })).toEqual({
      changes: { latitude: null, longitude: null },
    });
  });

  it('names a place that is not two numbers in range', () => {
    const form = salonForm(salon());
    expect(salonChanges(salon(), { ...form, coordinates: '52.2' })).toEqual({
      problem: 'coordinates',
    });
    expect(salonChanges(salon(), { ...form, coordinates: '95, 20' })).toEqual({
      problem: 'coordinates',
    });
  });
});

describe('parseCoordinates / formatCoordinates', () => {
  it('reads a comma, a semicolon or spaces between the numbers', () => {
    expect(parseCoordinates('52.1;21.0')).toEqual({ latitude: 52.1, longitude: 21 });
    expect(parseCoordinates('52.1 21.0')).toEqual({ latitude: 52.1, longitude: 21 });
    expect(parseCoordinates('  ')).toBeNull();
    expect(parseCoordinates('abc, 21')).toBe('invalid');
    expect(formatCoordinates(null, 21)).toBe('');
  });
});

describe('toggleDrink', () => {
  it('ticks a drink in the order of the list and unticks it', () => {
    expect(toggleDrink([], 'water')).toEqual(['water']);
    expect(toggleDrink(['water'], 'coffee')).toEqual(['coffee', 'water']);
    expect(toggleDrink(['coffee', 'water'], 'coffee')).toEqual(['water']);
  });
});

describe('saveProblem', () => {
  it('tells apart missing terms, a change by someone else and the rest', () => {
    expect(saveProblem(new ApiError(422, 'x', 'LEGAL_TEXTS_REQUIRED'))).toBe('legalTexts');
    expect(saveProblem(new ApiError(409, 'x', 'VERSION_CONFLICT'))).toBe('changedMeanwhile');
    expect(saveProblem(new ApiError(500, 'x'))).toBe('other');
    expect(saveProblem(new Error('offline'))).toBe('other');
  });
});

describe('maySeeSalon', () => {
  it('is for the owner and managers, not for specialists', () => {
    expect(maySeeSalon('owner')).toBe(true);
    expect(maySeeSalon('manager')).toBe(true);
    expect(maySeeSalon('staff')).toBe(false);
  });
});
