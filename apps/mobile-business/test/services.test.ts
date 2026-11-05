import { describe, expect, it } from 'vitest';
import type { ServiceCategoryList, ServiceList } from '../src/api';
import {
  bookingProblem,
  durationText,
  parseDuration,
  parsePrice,
  priceInput,
  priceList,
  serviceChange,
} from '../src/services';

const service = (over: Partial<ServiceList[number]> & { id: string; name: string }) =>
  ({
    categoryId: null,
    sortOrder: 0,
    priceGrosze: 9000,
    durationMinutes: 45,
    active: true,
    staffIds: ['s1'],
    version: 3,
    ...over,
  }) as ServiceList[number];

const categories = [
  { id: 'c-beard', name: 'Broda', sortOrder: 2, version: 1 },
  { id: 'c-hair', name: 'Włosy', sortOrder: 1, version: 1 },
  { id: 'c-empty', name: 'Pusta', sortOrder: 3, version: 1 },
] as ServiceCategoryList;

describe('priceList', () => {
  it('categories in the salon order, services in theirs, the rest last, empty ones left out', () => {
    const groups = priceList(
      [
        service({ id: '1', name: 'Combo', categoryId: 'c-hair', sortOrder: 2 }),
        service({ id: '2', name: 'Strzyżenie', categoryId: 'c-hair', sortOrder: 1 }),
        service({ id: '3', name: 'Broda', categoryId: 'c-beard' }),
        service({ id: '4', name: 'Konsultacja' }),
        service({ id: '5', name: 'Stara', categoryId: 'c-deleted' }),
      ],
      categories,
    );
    expect(groups.map((g) => [g.name, g.services.map((s) => s.name)])).toEqual([
      ['Włosy', ['Strzyżenie', 'Combo']],
      ['Broda', ['Broda']],
      [null, ['Konsultacja', 'Stara']],
    ]);
  });
});

describe('service helpers', () => {
  it('says why clients cannot book a service online', () => {
    expect(bookingProblem(service({ id: '1', name: 'A' }))).toBeNull();
    expect(bookingProblem(service({ id: '1', name: 'A', active: false }))).toBe('hidden');
    expect(bookingProblem(service({ id: '1', name: 'A', staffIds: [] }))).toBe('nobody');
  });

  it('writes durations like the booking page', () => {
    const units = { h: 'g', min: 'min' };
    expect(durationText(45, units)).toBe('45 min');
    expect(durationText(60, units)).toBe('1 g');
    expect(durationText(80, units)).toBe('1 g 20 min');
  });

  it('reads and writes prices with a comma or a dot', () => {
    expect(priceInput(9000)).toBe('90');
    expect(priceInput(9050)).toBe('90,50');
    expect(priceInput(905)).toBe('9,05');
    expect(parsePrice('90')).toBe(9000);
    expect(parsePrice('90,5')).toBe(9050);
    expect(parsePrice(' 1 200.99 ')).toBe(120099);
    expect(parsePrice('0')).toBe(0);
    expect(parsePrice('90,555')).toBeNull();
    expect(parsePrice('-5')).toBeNull();
    expect(parsePrice('')).toBeNull();
  });

  it('takes minutes in 5-minute steps from 5 to 480', () => {
    expect(parseDuration('45')).toBe(45);
    expect(parseDuration('480')).toBe(480);
    expect(parseDuration('47')).toBeNull();
    expect(parseDuration('0')).toBeNull();
    expect(parseDuration('485')).toBeNull();
    expect(parseDuration('abc')).toBeNull();
  });
});

describe('serviceChange', () => {
  const s = service({ id: '1', name: 'Strzyżenie' });

  it('sends only what changed, with the version that was read', () => {
    expect(serviceChange(s, { price: '95', duration: '45', active: true })).toEqual({
      ok: true,
      change: { version: 3, priceGrosze: 9500 },
    });
    expect(serviceChange(s, { price: '90', duration: '60', active: false })).toEqual({
      ok: true,
      change: { version: 3, durationMinutes: 60, active: false },
    });
  });

  it('nothing to save when nothing changed; a problem when a field is wrong', () => {
    expect(serviceChange(s, { price: '90,00', duration: '45', active: true })).toEqual({
      ok: true,
      change: null,
    });
    expect(serviceChange(s, { price: 'x', duration: '45', active: true })).toEqual({
      ok: false,
      problem: 'price',
    });
    expect(serviceChange(s, { price: '90', duration: '44', active: true })).toEqual({
      ok: false,
      problem: 'duration',
    });
  });
});
