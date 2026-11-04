import { describe, expect, it } from 'vitest';
import { ApiError, type Availability, type ServiceList, type StaffList } from '../src/api';
import {
  activeServices,
  checkNewClient,
  createProblem,
  freeTimes,
  localToInstant,
  cancelReason,
  mayMoveOrCancel,
  mayAddVisits,
  maySearchClients,
  newAppointmentBody,
  parseTime,
  staffForService,
  walkInDays,
  type MyRights,
} from '../src/newVisit';

const permissions = (over: Partial<MyRights['permissions']> = {}): MyRights['permissions'] => ({
  createOwnAppointments: true,
  changeOwnAppointments: true,
  bookOutsideHours: false,
  blockOwnTime: true,
  viewClientContacts: false,
  viewClientHistory: true,
  viewClientNotes: false,
  editClientNotes: false,
  viewAllAppointments: false,
  manageAllAppointments: false,
  viewOwnEarnings: false,
  ...over,
});
const owner: MyRights = { role: 'owner', permissions: permissions() };
const manager: MyRights = { role: 'manager', permissions: permissions() };
const specialist = (over: Partial<MyRights['permissions']> = {}): MyRights => ({
  role: 'staff',
  permissions: permissions(over),
});

const member = (id: string, serviceIds: string[], sortOrder: number, active = true) =>
  ({ id, displayName: id, serviceIds, sortOrder, active }) as unknown as StaffList[number];
const team: StaffList = [
  member('ola', ['cut', 'beard'], 2),
  member('kasia', ['cut'], 1),
  member('gone', ['cut'], 0, false),
];

describe('who may add visits', () => {
  it('an owner or manager always; a specialist with the right, only as one of the specialists', () => {
    expect(mayAddVisits(owner, null)).toBe(true);
    expect(mayAddVisits(manager, null)).toBe(true);
    expect(mayAddVisits(specialist(), 'kasia')).toBe(true);
    expect(mayAddVisits(specialist(), null)).toBe(false);
    expect(mayAddVisits(specialist({ createOwnAppointments: false }), 'kasia')).toBe(false);
    expect(
      mayAddVisits(
        specialist({ createOwnAppointments: false, manageAllAppointments: true }),
        'kasia',
      ),
    ).toBe(true);
  });

  it('only the owner and managers look clients up in the base', () => {
    expect(maySearchClients(owner)).toBe(true);
    expect(maySearchClients(manager)).toBe(true);
    expect(maySearchClients(specialist({ viewClientContacts: true }))).toBe(false);
  });

  it('a specialist books only for themselves, unless they manage all visits', () => {
    expect(staffForService(team, 'cut', owner, null).map((s) => s.id)).toEqual(['kasia', 'ola']);
    expect(staffForService(team, 'beard', manager, null).map((s) => s.id)).toEqual(['ola']);
    expect(staffForService(team, 'cut', specialist(), 'kasia').map((s) => s.id)).toEqual(['kasia']);
    expect(staffForService(team, 'beard', specialist(), 'kasia')).toEqual([]);
    expect(
      staffForService(team, 'cut', specialist({ manageAllAppointments: true }), 'kasia'),
    ).toHaveLength(2);
  });
});

describe('services and times', () => {
  it('lists services still offered, in the salon order', () => {
    const service = (id: string, sortOrder: number, active: boolean, staffIds: string[]) =>
      ({ id, name: id, sortOrder, active, staffIds }) as unknown as ServiceList[number];
    const list = [
      service('beard', 2, true, ['ola']),
      service('cut', 1, true, ['kasia']),
      service('hidden', 0, false, ['kasia']),
      service('nobody', 0, true, []),
    ];
    expect(activeServices(list).map((s) => s.id)).toEqual(['cut', 'beard']);
  });

  it('free times of one specialist on one day, in order', () => {
    const availability: Availability = {
      timezone: 'Europe/Warsaw',
      serviceId: 'cut',
      durationMinutes: 30,
      slots: [
        {
          start: '2026-11-05T09:30:00Z',
          date: '2026-11-05',
          time: '10:30',
          staffIds: ['ola'],
          discountPercent: null,
        },
        {
          start: '2026-11-05T08:00:00Z',
          date: '2026-11-05',
          time: '09:00',
          staffIds: ['kasia', 'ola'],
          discountPercent: null,
        },
        {
          start: '2026-11-06T08:00:00Z',
          date: '2026-11-06',
          time: '09:00',
          staffIds: ['ola'],
          discountPercent: null,
        },
      ],
    };
    expect(freeTimes(availability, 'ola', '2026-11-05')).toEqual([
      { time: '09:00', start: '2026-11-05T08:00:00Z' },
      { time: '10:30', start: '2026-11-05T09:30:00Z' },
    ]);
    expect(freeTimes(availability, 'kasia', '2026-11-06')).toEqual([]);
  });
});

describe('a walk-in entered afterwards', () => {
  it('turns the salon-local time into an instant, in winter and in summer', () => {
    expect(localToInstant('2026-11-03', '14:35', 'Europe/Warsaw')).toBe('2026-11-03T13:35:00.000Z');
    expect(localToInstant('2026-07-03', '14:35', 'Europe/Warsaw')).toBe('2026-07-03T12:35:00.000Z');
    expect(localToInstant('2026-11-03', '09:00', 'Europe/Istanbul')).toBe(
      '2026-11-03T06:00:00.000Z',
    );
    expect(localToInstant('2026-11-03', '00:05', 'Europe/Kyiv')).toBe('2026-11-02T22:05:00.000Z');
  });

  it('reads the time as people type it, on a 5-minute mark', () => {
    expect(parseTime('14:35')).toBe('14:35');
    expect(parseTime(' 9.05 ')).toBe('09:05');
    expect(parseTime('0930')).toBe('09:30');
    expect(parseTime('14:33')).toBeNull();
    expect(parseTime('24:00')).toBeNull();
    expect(parseTime('pół do')).toBeNull();
  });

  it('may be from today or yesterday', () => {
    expect(walkInDays('2026-11-01')).toEqual(['2026-11-01', '2026-10-31']);
  });
});

describe('the client', () => {
  it('checks a new client before asking the server; the salon’s country code is added', () => {
    expect(
      checkNewClient({ name: '  Jan   Nowak ', phone: '600 100 200', email: '' }, '48'),
    ).toEqual({
      ok: true,
      customer: { name: 'Jan Nowak', phone: '+48600100200' },
    });
    expect(
      checkNewClient({ name: 'Ayşe', phone: '0532 123 45 67', email: 'Ayse@Example.com ' }, '90'),
    ).toEqual({
      ok: true,
      customer: { name: 'Ayşe', phone: '+905321234567', email: 'ayse@example.com' },
    });
    expect(checkNewClient({ name: 'J', phone: '600100200', email: '' }, '48')).toEqual({
      ok: false,
      problem: 'name',
    });
    expect(checkNewClient({ name: 'Jan', phone: '12', email: '' }, '48')).toEqual({
      ok: false,
      problem: 'phone',
    });
    expect(checkNewClient({ name: 'Jan', phone: '600100200', email: 'jan@' }, '48')).toEqual({
      ok: false,
      problem: 'email',
    });
  });

  it('sends an existing client by id, a new one with the language; a walk-in as "came"', () => {
    const base = { serviceId: 'cut', staffId: 'kasia', start: '2026-11-05T08:00:00Z' };
    expect(
      newAppointmentBody({ ...base, client: { id: 'c1' }, locale: 'uk', note: ' ', walkIn: null }),
    ).toEqual({ ...base, customerId: 'c1' });
    expect(
      newAppointmentBody({
        ...base,
        client: { name: 'Jan', phone: '+48600100200' },
        locale: 'uk',
        note: ' Broda też ',
        walkIn: { paid: true },
      }),
    ).toEqual({
      ...base,
      customer: { name: 'Jan', phone: '+48600100200', locale: 'uk' },
      note: 'Broda też',
      alreadyHappened: true,
      paid: true,
    });
    expect(
      newAppointmentBody({
        ...base,
        client: { id: 'c1' },
        locale: 'pl',
        note: '',
        walkIn: { paid: false },
      }),
    ).toEqual({ ...base, customerId: 'c1', alreadyHappened: true });
  });

  it('explains what the server said', () => {
    expect(createProblem(new ApiError(409, 'x', 'SLOT_TAKEN'))).toBe('taken');
    expect(createProblem(new ApiError(409, 'x', 'OUTSIDE_WORKING_HOURS'))).toBe('outsideHours');
    expect(createProblem(new ApiError(400, 'x', 'IN_THE_PAST'))).toBe('past');
    expect(createProblem(new ApiError(400, 'x', 'TOO_LONG_AGO'))).toBe('tooLongAgo');
    expect(createProblem(new ApiError(400, 'x', 'NOT_STARTED'))).toBe('notStarted');
    expect(createProblem(new ApiError(403, 'x', 'FORBIDDEN'))).toBe('forbidden');
    expect(createProblem(new ApiError(500, 'x'))).toBe('other');
    expect(createProblem(new TypeError('offline'))).toBe('other');
  });
});

describe('move and cancel in the visit card', () => {
  const now = Date.parse('2026-11-05T10:00:00Z');
  it('only a confirmed visit that has not started, for someone who may change it', () => {
    const future = { status: 'confirmed', start: '2026-11-05T12:00:00Z' };
    expect(mayMoveOrCancel(future, true, now)).toBe(true);
    expect(mayMoveOrCancel(future, false, now)).toBe(false);
    expect(mayMoveOrCancel({ ...future, start: '2026-11-05T09:00:00Z' }, true, now)).toBe(false);
    expect(mayMoveOrCancel({ ...future, status: 'cancelled' }, true, now)).toBe(false);
    expect(mayMoveOrCancel({ ...future, status: 'completed' }, true, now)).toBe(false);
  });

  it('a reason is needed, tidied and at most 300 characters', () => {
    expect(cancelReason('   ')).toBeNull();
    expect(cancelReason('  Mistrz   chory ')).toBe('Mistrz chory');
    expect(cancelReason('x'.repeat(400))).toHaveLength(300);
  });
});
