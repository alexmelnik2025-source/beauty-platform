import { describe, expect, it } from 'vitest';
import type { ServiceList, StaffList } from '../src/api';
import { bookableStaff, hasWeeklyHours, setupFinished, setupState } from '../src/setup';

const service = (id: string, active = true) => ({ id, active }) as ServiceList[number];
const person = (id: string, serviceIds: string[], active = true) =>
  ({ id, active, serviceIds }) as StaffList[number];
const ready = {
  bookingTerms: '# Regulamin',
  privacyPolicy: '# Prywatność',
  onlineBookingEnabled: true,
};

describe('"Pierwsze kroki" (task 352)', () => {
  it('a new salon has every step open', () => {
    const steps = setupState({
      location: { bookingTerms: null, privacyPolicy: null, onlineBookingEnabled: false },
      services: [],
      staff: [],
      hoursSet: false,
    });
    expect(steps).toEqual([
      { step: 'services', done: false },
      { step: 'team', done: false },
      { step: 'hours', done: false },
      { step: 'legal', done: false },
      { step: 'online', done: false },
    ]);
    expect(setupFinished(steps)).toBe(false);
  });

  it('counts only active specialists with an active service', () => {
    const services = [service('s1'), service('s2', false)];
    expect(
      bookableStaff(services, [
        person('a', ['s1']),
        person('b', ['s2']),
        person('c', ['s1'], false),
        person('d', []),
      ]).map((s) => s.id),
    ).toEqual(['a']);
  });

  it('needs both texts, not just one or blanks', () => {
    const state = (location: typeof ready) =>
      setupState({
        location,
        services: [service('s1')],
        staff: [person('a', ['s1'])],
        hoursSet: true,
      });
    expect(state({ ...ready, privacyPolicy: '  ' })[3]).toEqual({ step: 'legal', done: false });
    expect(setupFinished(state(ready))).toBe(true);
    expect(state({ ...ready, onlineBookingEnabled: false })[4]).toEqual({
      step: 'online',
      done: false,
    });
  });

  it('weekly hours count, special days alone do not', () => {
    expect(hasWeeklyHours({ weekly: [{ weekday: 1, intervals: [] }] })).toBe(false);
    expect(
      hasWeeklyHours({ weekly: [{ weekday: 2, intervals: [{ start: '09:00', end: '17:00' }] }] }),
    ).toBe(true);
  });
});
