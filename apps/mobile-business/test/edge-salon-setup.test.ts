import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BaseIntegration, Location, ServiceList, StaffList } from '../src/api';
import { agoText, lastSyncLine } from '../src/baseStatus';
import { DICTIONARIES } from '../src/i18n';
import { emptyNewSalon, newSalonBodies, withTimeZone } from '../src/newSalon';
import { EMPTY_REWARD_FULL, rewardToSave, toggledService } from '../src/rewardEdit';
import { parseCoordinates, salonChanges, salonForm } from '../src/salon';
import { photoType } from '../src/salonPhotos';
import { csvTools } from '../src/screens/csvTools';
import { bookableStaff, hasWeeklyHours, setupFinished, setupState } from '../src/setup';
import { bookingLink, shareCsv, shareLink, staffQrLink } from '../src/share';

const { platform, share } = vi.hoisted(() => ({ platform: { OS: 'ios' }, share: vi.fn() }));
vi.mock('react-native', () => ({ Platform: platform, Share: { share } }));

const salon: Location = {
  id: 'centrum',
  organizationId: 'salony',
  slug: 'centrum',
  name: 'Łucja',
  addressLine: 'ul. Krótka 1',
  city: 'Łódź',
  postalCode: '90-001',
  timezone: 'Europe/Warsaw',
  currency: 'PLN',
  phone: null,
  email: null,
  latitude: null,
  longitude: null,
  defaultLocale: 'pl',
  slotStepMinutes: 15,
  minLeadMinutes: 30,
  bookingHorizonDays: 60,
  clientCancelDeadlineMinutes: 60,
  reminderHoursBefore: 0,
  waitlistHoldMinutes: 0,
  rebookReminderDays: 0,
  rebookReminderText: null,
  onlineBookingEnabled: false,
  shopFulfillment: ['pickup_at_salon'],
  shopReservationDays: 1,
  askMood: false,
  askDrink: false,
  drinks: [],
  askNote: false,
  languages: ['pl'],
  description: null,
  bookingTerms: null,
  privacyPolicy: null,
  version: 1,
  createdAt: '2026-11-25T14:30:00Z',
  updatedAt: '2026-11-25T14:30:00Z',
};

afterEach(() => {
  share.mockReset();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('salon settings and setup', () => {
  it('builds a name-only update when the stored email is malformed and lists are missing', () => {
    const incomplete: Location = {
      ...salon,
      email: 'recepcja@',
      // @ts-expect-error The API omitted the drinks list.
      drinks: undefined,
      // @ts-expect-error The API returned null for the languages list.
      languages: null,
    };
    const form = salonForm(incomplete);
    expect(form.drinks).toEqual([]);
    expect(form.languages).toEqual([]);
    expect(salonChanges(incomplete, { ...form, name: '  Salon Łucji  ' })).toEqual({
      changes: { name: 'Salon Łucji' },
    });
    expect(salonChanges(incomplete, { ...form, drinks: ['tea'], languages: ['uk'] })).toEqual({
      changes: { drinks: ['tea'], languages: ['uk'] },
    });
  });

  it('keeps only complete characters at the 1000-unit description limit', () => {
    const form = salonForm(salon);
    const withinLimit = 'ą'.repeat(998) + '🪮';
    expect(salonChanges(salon, { ...form, description: withinLimit + 'x' })).toEqual({
      changes: { description: withinLimit },
    });
    const prefix = 'ą'.repeat(999);
    expect(salonChanges(salon, { ...form, description: prefix + '🪮' })).toEqual({
      changes: { description: prefix },
    });
  });

  it('sends removed drinks and languages even when duplicates keep both list lengths unchanged', () => {
    const saved: Location = { ...salon, drinks: ['water', 'tea'], languages: ['pl', 'en'] };
    const form = salonForm(saved);
    expect(
      salonChanges(saved, { ...form, drinks: ['water', 'water'], languages: ['pl', 'pl'] }),
    ).toEqual({
      changes: { drinks: ['water'], languages: ['pl'] },
    });
    expect(
      salonChanges(saved, {
        ...form,
        drinks: ['tea', 'water', 'tea'],
        languages: ['en', 'en', 'pl'],
      }),
    ).toEqual({
      changes: {},
    });
  });

  it.each([
    ['90; -180', { latitude: 90, longitude: -180 }],
    [' -90, 180 ', { latitude: -90, longitude: 180 }],
    ['90.00001; -180', 'invalid'],
    ['-90; 180.00001', 'invalid'],
  ])('checks the map bounds for %s', (text, expected) => {
    expect(parseCoordinates(text)).toEqual(expected);
  });

  it('validates the existing postal code again after changing the salon country', () => {
    const form = {
      ...emptyNewSalon('Europe/London'),
      orgName: '  Łucja i spółka 🪮  ',
      city: 'Łódź',
      addressLine: 'ul. Krótka 1',
      postalCode: ' SW1A 1AA ',
      currency: 'EUR',
      currencyChosen: true,
    };
    expect(newSalonBodies(form, 'pl')).toMatchObject({
      location: { name: 'Łucja i spółka 🪮', postalCode: 'SW1A 1AA', currency: 'EUR' },
    });
    const moved = withTimeZone(form, 'Europe/Warsaw');
    expect(newSalonBodies(moved, 'pl')).toEqual({ problem: 'postalCode' });
    expect(newSalonBodies({ ...moved, postalCode: ' 00123 ' }, 'pl')).toMatchObject({
      location: { postalCode: '00-123', currency: 'EUR', timezone: 'Europe/Warsaw' },
    });
  });

  it('keeps setup open when two completed rows represent the same step', () => {
    const steps = ['services', 'team', 'hours', 'online', 'online'].map((step) => ({
      step,
      done: true,
    }));
    expect(setupFinished(steps)).toBe(false);
    expect(setupFinished([...steps, { step: 'legal', done: true }])).toBe(true);
  });

  it('leaves the legal step open when a policy arrives as an object instead of its text', () => {
    const steps = setupState({
      location: {
        bookingTerms: 'Regulamin',
        // @ts-expect-error The server returned an object where text was expected.
        privacyPolicy: { content: 'Polityka prywatności' },
        onlineBookingEnabled: true,
      },
      services: [{ id: 'cut', active: true }] as ServiceList,
      staff: [{ id: 'anna', active: true, serviceIds: ['cut'] }] as StaffList,
      hoursSet: true,
    });
    expect(steps.filter(({ done }) => !done)).toEqual([{ step: 'legal', done: false }]);
    expect(setupFinished(steps)).toBe(false);
  });

  it('keeps a bookable specialist when another row is missing its service list', () => {
    const services = [{ id: 'cut', active: true }] as ServiceList;
    const person = { id: 'anna', active: true, serviceIds: ['cut', 'cut'] } as StaffList[number];
    const incomplete = { ...person, id: 'jan', serviceIds: null };
    // @ts-expect-error The server returned an incomplete specialist.
    expect(bookableStaff(services, [incomplete, person])).toEqual([person]);
  });

  it('recognizes weekly hours on a later day even when one day has no intervals list', () => {
    const incomplete = { weekday: 1 };
    const open = { weekday: 2, intervals: [{ start: '09:00', end: '12:00' }] };
    // @ts-expect-error The server omitted intervals for the first day.
    expect(hasWeeklyHours({ weekly: [incomplete, open] })).toBe(true);
    // @ts-expect-error The server omitted intervals for the only day.
    expect(hasWeeklyHours({ weekly: [incomplete] })).toBe(false);
  });

  it('accepts an interval ending at midnight and rejects invalid days and clock ranges', () => {
    const lateShift = { start: '23:30', end: '24:00' };
    expect(hasWeeklyHours({ weekly: [{ weekday: 7, intervals: [lateShift] }] })).toBe(true);
    expect(
      hasWeeklyHours({
        weekly: [
          { weekday: 0, intervals: [lateShift] },
          { weekday: 1, intervals: [] },
          {
            weekday: 2,
            intervals: [
              { start: '10:00', end: '10:00' },
              { start: '19:00', end: '09:00' },
              { start: '23:60', end: '24:00' },
            ],
          },
        ],
      }),
    ).toBe(false);
  });

  it('uses a supported MIME type regardless of case, including a blob-only type', () => {
    expect(photoType('IMAGE/PNG', 'image/jpeg')).toBe('image/png');
    expect(photoType('', 'IMAGE/WEBP')).toBe('image/webp');
    expect(photoType('application/octet-stream', 'image/png')).toBe('image/png');
  });
});

describe('rewards and Base synchronization', () => {
  it.each([
    [' 1 ', 1],
    ['3650', 3650],
    [' \t ', null],
  ])('saves coupon validity %j and the remaining distinct services', (validityDays, expected) => {
    const selected = ['cut', 'colour', 'cut', 'beard', 'colour'];
    const form = {
      ...EMPTY_REWARD_FULL,
      name: '  Strzyżenie 🪮  ',
      percent: '10',
      cost: '1',
      validityDays,
      serviceIds: toggledService(selected, 'cut'),
    };
    expect(rewardToSave(form)).toMatchObject({
      ok: true,
      reward: {
        name: 'Strzyżenie 🪮',
        couponValidityDays: expected,
        serviceIds: ['colour', 'beard'],
      },
    });
    expect(selected).toEqual(['cut', 'colour', 'cut', 'beard', 'colour']);
  });

  it('counts elapsed minutes across midnight and the repeated hour in Warsaw', () => {
    expect(
      agoText('2026-11-25T23:59:00+01:00', DICTIONARIES.pl, new Date('2026-11-26T00:01:00+01:00')),
    ).toBe('2 min temu');
    expect(
      agoText('2026-10-25T02:59:00+02:00', DICTIONARIES.pl, new Date('2026-10-25T02:00:00+01:00')),
    ).toBe('1 min temu');
  });

  it('uses the last known import when the server returns an unreadable sync timestamp', () => {
    const status = {
      lastSyncAt: 'missing time',
      lastImportAt: '2026-11-25T23:56:00+01:00',
      lastErrorCode: null,
    } as BaseIntegration;
    const now = new Date('2026-11-26T00:01:00+01:00');
    expect(lastSyncLine(status, DICTIONARIES.pl, now)).toBe('Ostatnia synchronizacja: 5 min temu.');
    expect(lastSyncLine({ ...status, lastImportAt: null }, DICTIONARIES.pl, now)).toBe(
      DICTIONARIES.pl.shop.base.neverSynced,
    );
    for (const lastImportAt of [status.lastImportAt, null]) {
      expect(
        lastSyncLine(
          { ...status, lastImportAt, lastErrorCode: 'BASE_UNREACHABLE' },
          DICTIONARIES.pl,
          now,
        ),
      ).toBe(DICTIONARIES.pl.shop.base.errors.unreachable);
    }
  });
});

describe('sharing a salon link or export', () => {
  it('refuses to copy a booking link built with a missing host', async () => {
    const url = bookingLink('https://', salon);
    const copy = vi.fn();
    await expect(shareLink({ title: salon.name, message: url, url }, { copy })).resolves.toBe(
      'failed',
    );
    expect(copy).not.toHaveBeenCalled();
  });

  it.each(['   ', '/pl/b/centrum', 'https://', 'mailto:recepcja@example.com'])(
    'does not share or copy an invalid booking URL %j',
    async (url) => {
      const tools = {
        native: vi.fn().mockResolvedValue({ action: 'sharedAction' }),
        webShare: vi.fn().mockResolvedValue(undefined),
        copy: vi.fn().mockResolvedValue(undefined),
      };
      await expect(shareLink({ title: 'Salon', message: 'Rezerwacja', url }, tools)).resolves.toBe(
        'failed',
      );
      expect(tools.native).not.toHaveBeenCalled();
      expect(tools.webShare).not.toHaveBeenCalled();
      expect(tools.copy).not.toHaveBeenCalled();
    },
  );

  it('keeps a reserved character in the salon path or staff id inside that value', () => {
    const slug = 'łódź/centrum #2';
    const staffId = 'A+B & C#D';
    const link = new URL(staffQrLink('https://salon.example///', { slug }, staffId));
    expect(link.origin).toBe('https://salon.example');
    expect(link.pathname.split('/').map(decodeURIComponent)).toEqual(['', 's', slug]);
    expect([...link.searchParams]).toEqual([
      ['utm_source', 'qr'],
      ['staff', staffId],
    ]);
    expect(link.hash).toBe('');
  });

  it('shares a quoted multiline CSV cell verbatim, including its interior BOM', async () => {
    platform.OS = 'ios';
    const fileName = 'opinie-Łódź.csv';
    const body = 'Klient;Opinia\r\nŁucja;"🪮; ""tak""\r\n\uFEFFdruga linia"\r\n';
    share.mockResolvedValue({ action: 'sharedAction' });
    await expect(shareCsv({ fileName, csv: '\uFEFF' + body }, csvTools())).resolves.toBe('shared');
    expect(share).toHaveBeenCalledExactlyOnceWith({ title: fileName, message: body });
  });

  it('cleans up the browser download if clicking the CSV link fails', async () => {
    platform.OS = 'web';
    vi.useFakeTimers();
    const anchor = {
      click: vi.fn(() => {
        throw new Error('Download blocked');
      }),
      remove: vi.fn(),
    };
    vi.stubGlobal('document', {
      body: { appendChild: vi.fn() },
      createElement: () => anchor,
    });
    const url = 'blob:failed-download';
    vi.spyOn(URL, 'createObjectURL').mockReturnValue(url);
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});

    await expect(shareCsv({ fileName: 'opinie.csv', csv: 'Opinia\r\n' }, csvTools())).resolves.toBe(
      'failed',
    );
    expect(anchor.click).toHaveBeenCalledOnce();
    expect(anchor.remove).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(1000);
    expect(revoke).toHaveBeenCalledExactlyOnceWith(url);
  });
});
