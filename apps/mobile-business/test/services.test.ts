import { describe, expect, it } from 'vitest';
import type { ServiceCategoryList, ServiceList, StaffList } from '../src/api';
import {
  bookingProblem,
  categoryChoices,
  categoryName,
  copiedRates,
  copyForm,
  copyName,
  durationText,
  movedCategoryOrder,
  movedOrder,
  newService,
  newServiceForm,
  parseBuffer,
  parseDuration,
  parsePrice,
  priceInput,
  priceList,
  serviceChange,
  serviceCopy,
  staffChange,
  staffChoices,
  toggled,
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
      categoryId: 'c-hair',
    });
    expect(copyName('{name} (kopia)', 'x'.repeat(100))).toHaveLength(100);
  });

  it('keeps everything else of the source', () => {
    const form = {
      name: ' Strzyżenie dzieci ',
      price: '60',
      duration: '30',
      active: true,
      categoryId: 'c-beard',
    };
    expect(serviceCopy(source, form)).toEqual({
      ok: true,
      service: {
        name: 'Strzyżenie dzieci',
        description: 'Z myciem',
        durationMinutes: 30,
        bufferMinutes: 10,
        priceGrosze: 6000,
        active: true,
        categoryId: 'c-beard',
        color: '#112233',
        wishPhotos: true,
        staffIds: ['s1', 's2'],
      },
    });
  });

  it('says what is wrong in the form', () => {
    const form = { name: 'Kopia', price: '60', duration: '30', active: true, categoryId: null };
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

describe('categories in the app (task 311)', () => {
  it('offers every category in the salon order, also the empty ones', () => {
    expect(categoryChoices(categories).map((c) => c.name)).toEqual(['Włosy', 'Broda', 'Pusta']);
  });

  it('checks the name of a new category', () => {
    expect(categoryName('  Koloryzacja ')).toBe('Koloryzacja');
    expect(categoryName('   ')).toBeNull();
    expect(categoryName('x'.repeat(61))).toBeNull();
  });

  it('moves a service to another category, or out of every one', () => {
    const cut = service({ id: 'a', name: 'Strzyżenie', categoryId: 'c-hair' });
    const form = { price: '90', duration: '45', active: true };
    expect(serviceChange(cut, { ...form, categoryId: 'c-beard' })).toEqual({
      ok: true,
      change: { version: 3, categoryId: 'c-beard' },
    });
    expect(serviceChange(cut, { ...form, categoryId: null })).toEqual({
      ok: true,
      change: { version: 3, categoryId: null },
    });
    expect(serviceChange(cut, { ...form, categoryId: 'c-hair' })).toEqual({
      ok: true,
      change: null,
    });
  });
});

describe('who performs a service (task 312)', () => {
  const staff = [
    { id: 's1', displayName: 'Kasia', active: true, sortOrder: 2 },
    { id: 's2', displayName: 'Ania', active: true, sortOrder: 1 },
    { id: 's3', displayName: 'Ola', active: false, sortOrder: 0 },
    { id: 's4', displayName: 'Ewa', active: false, sortOrder: 3 },
  ] as StaffList;

  it('offers who takes visits, and an inactive one only while still ticked', () => {
    expect(staffChoices(staff, ['s4']).map((m) => m.id)).toEqual(['s2', 's1', 's4']);
    expect(staffChoices(staff, []).map((m) => m.id)).toEqual(['s2', 's1']);
  });

  it('saves only a different list', () => {
    const cut = service({ id: 'a', name: 'Strzyżenie', staffIds: ['s1', 's2'] });
    expect(staffChange(cut, ['s2', 's1'])).toBeNull();
    expect(staffChange(cut, ['s1'])).toEqual(['s1']);
    expect(staffChange(cut, [])).toEqual([]);
  });

  it('ticks and unticks one specialist', () => {
    expect(toggled(['s1'], 's2')).toEqual(['s1', 's2']);
    expect(toggled(['s1', 's2'], 's1')).toEqual(['s2']);
  });
});

describe('"Nowa usługa" (task 313)', () => {
  const staff = [
    { id: 's1', displayName: 'Kasia', active: true, sortOrder: 2 },
    { id: 's2', displayName: 'Ania', active: true, sortOrder: 1 },
    { id: 's3', displayName: 'Ola', active: false, sortOrder: 0 },
  ] as StaffList;

  it('starts online, 30 minutes, in the first category, done by everyone who takes visits', () => {
    expect(newServiceForm(categories, staff)).toEqual({
      name: '',
      description: '',
      price: '',
      duration: '30',
      active: true,
      categoryId: 'c-hair',
      staffIds: ['s2', 's1'],
      buffer: '0',
      wishPhotos: false,
    });
    expect(newServiceForm([], []).categoryId).toBeNull();
  });

  it('makes the service as the server takes it', () => {
    const form = { ...newServiceForm(categories, staff), name: ' Golenie ', price: '50,5' };
    expect(newService({ ...form, description: '  Brzytwą  ' })).toEqual({
      ok: true,
      service: {
        name: 'Golenie',
        description: 'Brzytwą',
        durationMinutes: 30,
        bufferMinutes: 0,
        priceGrosze: 5050,
        active: true,
        categoryId: 'c-hair',
        color: null,
        wishPhotos: false,
        staffIds: ['s2', 's1'],
      },
    });
    expect(newService(form)).toMatchObject({ ok: true, service: { description: null } });
  });

  it('says what is wrong in the form', () => {
    const form = { ...newServiceForm(categories, staff), name: 'Golenie', price: '50' };
    expect(newService({ ...form, name: ' ' })).toEqual({ ok: false, problem: 'name' });
    expect(newService({ ...form, description: 'x'.repeat(501) })).toEqual({
      ok: false,
      problem: 'description',
    });
    expect(newService({ ...form, price: '' })).toEqual({ ok: false, problem: 'price' });
    expect(newService({ ...form, duration: '0' })).toEqual({ ok: false, problem: 'duration' });
  });
});

describe('name and description in "Zmień" (task 314)', () => {
  const cut = service({ id: 'a', name: 'Strzyżenie', description: null });
  const form = { price: '90', duration: '45', active: true, name: 'Strzyżenie', description: '' };

  it('sends only a new name or description', () => {
    expect(serviceChange(cut, form)).toEqual({ ok: true, change: null });
    expect(serviceChange(cut, { ...form, name: ' Strzyżenie klasyczne ' })).toEqual({
      ok: true,
      change: { version: 3, name: 'Strzyżenie klasyczne' },
    });
    expect(serviceChange(cut, { ...form, description: 'Z myciem' })).toEqual({
      ok: true,
      change: { version: 3, description: 'Z myciem' },
    });
  });

  it('clears the description, and checks both', () => {
    const described = service({ id: 'b', name: 'Broda', description: 'Z olejkiem' });
    expect(serviceChange(described, { ...form, name: 'Broda', description: '  ' })).toEqual({
      ok: true,
      change: { version: 3, description: null },
    });
    expect(serviceChange(cut, { ...form, name: '' })).toEqual({ ok: false, problem: 'name' });
    expect(serviceChange(cut, { ...form, description: 'x'.repeat(501) })).toEqual({
      ok: false,
      problem: 'description',
    });
  });
});

describe('break and example photos (task 317)', () => {
  const cut = service({ id: 'a', name: 'Strzyżenie', bufferMinutes: 0, wishPhotos: false });
  const form = { price: '90', duration: '45', active: true };

  it('reads the break: empty is none, 0–120 in 5-minute steps', () => {
    expect(parseBuffer('')).toBe(0);
    expect(parseBuffer(' 15 ')).toBe(15);
    expect(parseBuffer('120')).toBe(120);
    expect(parseBuffer('7')).toBeNull();
    expect(parseBuffer('125')).toBeNull();
    expect(parseBuffer('-5')).toBeNull();
  });

  it('sends only a new break or a new photos choice', () => {
    expect(serviceChange(cut, { ...form, buffer: '0', wishPhotos: false })).toEqual({
      ok: true,
      change: null,
    });
    expect(serviceChange(cut, { ...form, buffer: '10', wishPhotos: true })).toEqual({
      ok: true,
      change: { version: 3, bufferMinutes: 10, wishPhotos: true },
    });
    expect(serviceChange(cut, { ...form, buffer: '3' })).toEqual({ ok: false, problem: 'buffer' });
  });

  it('gives a new service its break and photos choice', () => {
    const fresh = { ...newServiceForm([], []), name: 'Koloryzacja', price: '200' };
    expect(newService({ ...fresh, buffer: '15', wishPhotos: true })).toMatchObject({
      ok: true,
      service: { bufferMinutes: 15, wishPhotos: true },
    });
    expect(newService({ ...fresh, buffer: 'x' })).toEqual({ ok: false, problem: 'buffer' });
  });
});
