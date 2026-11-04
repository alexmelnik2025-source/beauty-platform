import { describe, expect, it } from 'vitest';
import {
  BusinessApi,
  type PermissionCatalog,
  type StaffList,
  type TimeBlockList,
} from '../src/api';
import {
  blocksOfDay,
  blockTargets,
  canRemoveBlock,
  localToIso,
  nextFullHour,
  shiftTime,
} from '../src/blocks';

type Me = PermissionCatalog['me'];
const staff = [
  { id: 's1', displayName: 'Kasia', active: true },
  { id: 's2', displayName: 'Marek', active: true },
  { id: 's3', displayName: 'Old', active: false },
] as StaffList;

const block = (id: string, start: string, end: string, staffId: string | null, date: string) => ({
  id,
  locationId: 'l1',
  staffId,
  start,
  end,
  date,
  time: start.slice(11, 16),
  reason: null,
  seriesId: null,
  version: 1,
  deleted: false,
  updatedAt: start,
});

describe('blocked time', () => {
  it('turns salon-local times into ISO with the offset of that day', () => {
    expect(localToIso('2026-11-04', '14:00', 'Europe/Warsaw')).toBe('2026-11-04T14:00:00+01:00');
    expect(localToIso('2026-07-01', '09:30', 'Europe/Warsaw')).toBe('2026-07-01T09:30:00+02:00');
    expect(localToIso('2026-11-04', '24:00', 'Europe/Warsaw')).toBe('2026-11-05T00:00:00+01:00');
    // The clock goes back on 25.10.2026 at 03:00 → 02:00 in Warsaw.
    expect(localToIso('2026-10-25', '12:00', 'Europe/Warsaw')).toBe('2026-10-25T12:00:00+01:00');
    expect(localToIso('2026-03-29', '12:00', 'Europe/Warsaw')).toBe('2026-03-29T12:00:00+02:00');
    expect(localToIso('2026-11-04', '10:00', 'Europe/Istanbul')).toBe('2026-11-04T10:00:00+03:00');
  });

  it('steps 15 minutes within the day; a new block starts at the next full hour', () => {
    expect(shiftTime('10:00', 15)).toBe('10:15');
    expect(shiftTime('00:00', -15)).toBe('00:00');
    expect(shiftTime('23:45', 15)).toBe('24:00');
    expect(shiftTime('24:00', 15)).toBe('24:00');
    expect(nextFullHour('Europe/Warsaw', new Date('2026-11-04T12:20:00Z'))).toBe('14:00');
    expect(nextFullHour('Europe/Warsaw', new Date('2026-11-04T22:50:00Z'))).toBe('23:00');
  });

  it('lists the blocks of the day with names; over midnight shows 00:00 / 24:00', () => {
    const list = [
      block('b2', '2026-11-04T13:00:00.000Z', '2026-11-04T14:00:00.000Z', 's1', '2026-11-04'),
      block('b1', '2026-11-04T08:00:00.000Z', '2026-11-04T09:00:00.000Z', null, '2026-11-04'),
      block('night', '2026-11-03T22:00:00.000Z', '2026-11-04T07:00:00.000Z', 's2', '2026-11-03'),
      block('ends', '2026-11-03T20:00:00.000Z', '2026-11-03T23:00:00.000Z', 's2', '2026-11-03'),
      {
        ...block(
          'gone',
          '2026-11-04T10:00:00.000Z',
          '2026-11-04T11:00:00.000Z',
          null,
          '2026-11-04',
        ),
        deleted: true,
      },
    ] as TimeBlockList;
    expect(blocksOfDay(list, staff, '2026-11-04', 'Europe/Warsaw')).toEqual([
      { id: 'night', start: '00:00', end: '08:00', staffId: 's2', staff: 'Marek', reason: null },
      { id: 'b1', start: '09:00', end: '10:00', staffId: null, staff: null, reason: null },
      { id: 'b2', start: '14:00', end: '15:00', staffId: 's1', staff: 'Kasia', reason: null },
    ]);
    expect(
      blocksOfDay(list, staff, '2026-11-03', 'Europe/Warsaw').map((b) => [b.id, b.end]),
    ).toEqual([
      ['ends', '24:00'],
      ['night', '24:00'],
    ]);
  });

  it('owners and managers block anyone or the whole salon; a specialist only themselves, with the permission', () => {
    const owner = { role: 'owner', permissions: {} } as Me;
    expect(blockTargets(owner, staff, null).map((x) => x.name)).toEqual([null, 'Kasia', 'Marek']);
    const kasia = (blockOwnTime: boolean) =>
      ({ role: 'staff', permissions: { blockOwnTime } }) as unknown as Me;
    expect(blockTargets(kasia(true), staff, 's1')).toEqual([{ staffId: 's1', name: 'Kasia' }]);
    expect(blockTargets(kasia(false), staff, 's1')).toEqual([]);
    expect(blockTargets(kasia(true), staff, null)).toEqual([]);
    const own = blockTargets(kasia(true), staff, 's1');
    expect(canRemoveBlock({ staffId: 's1' }, own)).toBe(true);
    expect(canRemoveBlock({ staffId: null }, own)).toBe(false);
    expect(canRemoveBlock({ staffId: 's2' }, blockTargets(owner, staff, null))).toBe(true);
  });
});

describe('BusinessApi time blocks', () => {
  it('reads the day, blocks and unblocks time', async () => {
    const calls: [string, unknown][] = [];
    const fetchFn = async (url: string, init?: RequestInit) => {
      const key = `${init?.method} ${url.replace('https://api.test', '')}`;
      calls.push([key, init?.body ? JSON.parse(String(init.body)) : undefined]);
      if (key === 'DELETE /v1/organizations/o1/locations/l1/time-blocks/b1') {
        return new Response(null, { status: 204 });
      }
      const data = key.startsWith('POST /v1/auth/refresh')
        ? { accessToken: 'a1', expiresIn: 900, refreshToken: 'refresh-token-0123456789new' }
        : key.startsWith('GET')
          ? []
          : { id: 'b1' };
      return new Response(JSON.stringify(data), { status: 200 });
    };
    const store = { get: async () => 'refresh-token-0123456789abc', set: async () => undefined };
    const api = new BusinessApi('https://api.test', store, fetchFn);
    await api.restore();
    await api.timeBlocks('o1', 'l1', '2026-11-04');
    await api.addTimeBlock('o1', 'l1', {
      staffId: 's1',
      start: '2026-11-04T14:00:00+01:00',
      end: '2026-11-04T15:00:00+01:00',
      reason: 'Przerwa',
    });
    await expect(api.removeTimeBlock('o1', 'l1', 'b1')).resolves.toBeUndefined();
    const base = '/v1/organizations/o1/locations/l1/time-blocks';
    expect(calls.slice(1)).toEqual([
      [`GET ${base}?from=2026-11-04&to=2026-11-04`, undefined],
      [
        `POST ${base}`,
        {
          staffId: 's1',
          start: '2026-11-04T14:00:00+01:00',
          end: '2026-11-04T15:00:00+01:00',
          reason: 'Przerwa',
        },
      ],
      [`DELETE ${base}/b1`, undefined],
    ]);
  });
});
