import { describe, expect, it } from 'vitest';
import type { ServiceCategoryList, ServiceList } from '../src/api';
import {
  bookingProblem,
  copiedRates,
  copyForm,
  copyName,
  durationText,
  movedCategoryOrder,
  movedOrder,
  parseDuration,
  parsePrice,
  priceInput,
  priceList,
  serviceChange,
  serviceCopy,
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

  it('services with the same place keep the order the server sent (as on the booking page)', () => {
    const groups = priceList(
      [service({ id: '1', name: 'Strzyżenie męskie' }), service({ id: '2', name: 'Broda' })],
      [],
    );
    expect(groups[0]!.services.map((s) => s.name)).toEqual(['Strzyżenie męskie', 'Broda']);
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

describe('movedOrder (task 253)', () => {
  const groups = priceList(
    [
      service({ id: 'cut', name: 'Strzyżenie', categoryId: 'c-hair', sortOrder: 0 }),
      service({ id: 'combo', name: 'Combo', categoryId: 'c-hair', sortOrder: 10 }),
      service({ id: 'beard', name: 'Broda', categoryId: 'c-beard', sortOrder: 20 }),
      service({ id: 'trim', name: 'Trymer', categoryId: 'c-beard', sortOrder: 30 }),
      service({ id: 'talk', name: 'Konsultacja', sortOrder: 40 }),
    ],
    categories,
  );

  it('swaps the service with its neighbour and sends every service once', () => {
    expect(movedOrder(groups, 'combo', -1)).toEqual(['combo', 'cut', 'beard', 'trim', 'talk']);
    expect(movedOrder(groups, 'beard', 1)).toEqual(['cut', 'combo', 'trim', 'beard', 'talk']);
  });

  it('does not move past the edge of its category', () => {
    expect(movedOrder(groups, 'cut', -1)).toBeNull();
    expect(movedOrder(groups, 'combo', 1)).toBeNull();
    expect(movedOrder(groups, 'beard', -1)).toBeNull();
    expect(movedOrder(groups, 'talk', 1)).toBeNull();
    expect(movedOrder(groups, 'unknown', 1)).toBeNull();
  });
});

describe('movedCategoryOrder (task 255)', () => {
  const groups = priceList(
    [
      service({ id: 'cut', name: 'Strzyżenie', categoryId: 'c-hair' }),
      service({ id: 'beard', name: 'Broda', categoryId: 'c-beard' }),
      service({ id: 'talk', name: 'Konsultacja' }),
    ],
    categories,
  );

  it('swaps the category with its neighbour on the screen and sends every category once', () => {
    expect(groups.map((g) => g.id)).toEqual(['c-hair', 'c-beard', null]);
    expect(movedCategoryOrder(categories, groups, 'c-beard', -1)).toEqual([
      'c-beard',
      'c-hair',
      'c-empty',
    ]);
    expect(movedCategoryOrder(categories, groups, 'c-hair', 1)).toEqual([
      'c-beard',
      'c-hair',
      'c-empty',
    ]);
  });

  it('does not move past the first or the last category on the screen', () => {
    expect(movedCategoryOrder(categories, groups, 'c-hair', -1)).toBeNull();
    // The empty category is not on the screen: "Broda" is the last one there.
    expect(movedCategoryOrder(categories, groups, 'c-beard', 1)).toBeNull();
    expect(movedCategoryOrder(categories, groups, 'c-empty', -1)).toBeNull();
  });
});

describe('"Duplikuj" (task 310)', () => {
  const source = service({
    id: 'a',
    name: 'Strzyżenie męskie',
    categoryId: 'c-hair',
    priceGrosze: 9050,
    durationMinutes: 45,
    active: false,
    staffIds: ['s1', 's2'],
    description: 'Z myciem',
    bufferMinutes: 10,
    color: '#112233',
    wishPhotos: true,
  });

  it('fills the form as the source, with "(kopia)" in the name', () => {
    expect(copyForm(source, '{name} (kopia)')).toEqual({
      name: 'Strzyżenie męskie (kopia)',
      price: '90,50',
      duration: '45',
      active: false,
    });
    expect(copyName('{name} (kopia)', 'x'.repeat(100))).toHaveLength(100);
  });

  it('keeps everything else of the source', () => {
    const form = { name: ' Strzyżenie dzieci ', price: '60', duration: '30', active: true };
    expect(serviceCopy(source, form)).toEqual({
      ok: true,
      service: {
        name: 'Strzyżenie dzieci',
        description: 'Z myciem',
        durationMinutes: 30,
        bufferMinutes: 10,
        priceGrosze: 6000,
        active: true,
        categoryId: 'c-hair',
        color: '#112233',
        wishPhotos: true,
        staffIds: ['s1', 's2'],
      },
    });
  });

  it('says what is wrong in the form', () => {
    const form = { name: 'Kopia', price: '60', duration: '30', active: true };
    expect(serviceCopy(source, { ...form, name: '  ' })).toEqual({ ok: false, problem: 'name' });
    expect(serviceCopy(source, { ...form, price: 'abc' })).toEqual({ ok: false, problem: 'price' });
    expect(serviceCopy(source, { ...form, duration: '7' })).toEqual({
      ok: false,
      problem: 'duration',
    });
  });

  it('copies own prices and durations of the source for the specialists of the copy', () => {
    const rates = {
      prices: [
        { serviceId: 'a', staffId: 's1', priceGrosze: 12000 },
        { serviceId: 'a', staffId: 's9', priceGrosze: 1 },
        { serviceId: 'b', staffId: 's2', priceGrosze: 2 },
      ],
      durations: [
        { serviceId: 'a', staffId: 's2', durationMinutes: 60 },
        { serviceId: 'b', staffId: 's1', durationMinutes: 5 },
      ],
    };
    expect(copiedRates(rates, 'a', ['s1', 's2'])).toEqual({
      prices: [{ staffId: 's1', priceGrosze: 12000 }],
      durations: [{ staffId: 's2', durationMinutes: 60 }],
    });
    expect(copiedRates(rates, 'c', ['s1'])).toEqual({ prices: [], durations: [] });
  });
});
