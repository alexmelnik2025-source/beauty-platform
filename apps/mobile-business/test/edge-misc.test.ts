import { afterEach, describe, expect, it, vi } from 'vitest';
import { BusinessApi, type CancellationGuard } from '../src/api';
import { matchesProductSearch, parseBarcode } from '../src/barcode';
import { emptyContacts, newCustomerBody } from '../src/clientContacts';
import { currencyForTimeZone, salonZoneOf, timeZoneLabel } from '../src/country';
import { guardForm, guardRulesToSave } from '../src/guard';
import { dialForTimeZone, normalizePhone } from '../src/phone';
import { encodeQr, utf8 } from '../src/qr';
import { categoryBody, categoryForm } from '../src/rights';
import { ratesChange } from '../src/services';

describe('country and contact details', () => {
  it.each(['Europe/Kiev', 'Europe/Kyiv'])(
    'uses the saved Ukrainian zone %s for new contacts',
    (zone) => {
      expect(salonZoneOf(zone)).toBe('Europe/Kiev');
      expect(currencyForTimeZone(zone)).toBe('UAH');
      expect(timeZoneLabel(zone, 'en')).toBe('Ukraine (Kyiv)');
      const dial = dialForTimeZone(zone);
      const phone = ' (050)\u00a0123-45-67 ';
      expect(normalizePhone(phone, dial)).toBe('+380501234567');
      expect(
        newCustomerBody({ ...emptyContacts('uk'), name: ' Олена ', phone, email: ' ' }, dial),
      ).toEqual({
        ok: true,
        body: { name: 'Олена', phone: '+380501234567', locale: 'uk' },
      });
    },
  );

  it.each([
    ['0044 12345', '+4412345'],
    ['0044 1234567890123', '+441234567890123'],
    ['0044 1234', null],
    ['0044 12345678901234', null],
  ])('checks the international length after removing the 00 prefix in %s', (phone, expected) => {
    const result = newCustomerBody({ ...emptyContacts('en'), name: 'Jan', phone }, '48');
    expect(result).toEqual(
      expected
        ? { ok: true, body: { name: 'Jan', phone: expected, locale: 'en' } }
        : { ok: false, problem: 'phone' },
    );
  });
});

describe('scanned product codes and salon QR codes', () => {
  it('keeps leading zeroes and checks the digit after scanner whitespace is stripped', () => {
    const barcode = parseBarcode('0000\t0000 0001 7\r\n');
    expect(barcode).toBe('0000000000017');
    expect(
      matchesProductSearch({ name: 'Wax', barcode: barcode ?? null }, '0000 0000 0001 7\r\n'),
    ).toBe(true);
    expect(parseBarcode('0000 0000 0001 8')).toBeUndefined();
  });

  it('measures the first QR version boundary in bytes including a four-byte character', () => {
    const fits = '1234567890💈';
    expect(encodeQr(fits).version).toBe(1);
    expect(encodeQr(fits + 'x').version).toBe(2);
  });

  it('replaces each unpaired surrogate with the UTF-8 replacement character', () => {
    expect(utf8('\ud83dA\udc88')).toEqual([0xef, 0xbf, 0xbd, 0x41, 0xef, 0xbf, 0xbd]);
  });
});

describe('permissions, cancellation rules and service rates', () => {
  it('checks a trimmed category name at both sides of the server limit', () => {
    const form = categoryForm(null, [{ key: 'viewClientContacts', default: false }]);
    const limit = 'Ł'.repeat(60);
    expect(categoryBody({ ...form, name: '  ' + limit + ' ' })).toEqual({
      ok: true,
      name: limit,
      permissions: { viewClientContacts: false },
    });
    expect(categoryBody({ ...form, name: limit + 'a' })).toEqual({ ok: false });
  });

  const settings: CancellationGuard = {
    enabled: true,
    maxChanges: 1,
    windowHours: 1,
    lateCancelMinutes: 1,
    maxNoShows: 1,
    action: 'approval',
    version: 0,
  };

  it('preserves a one-hour window when editing a different rule in a day-based form', () => {
    expect(guardRulesToSave(settings, { ...guardForm(settings), noShows: '20' })).toEqual({
      ok: true,
      save: { ...settings, maxNoShows: 20 },
    });
  });

  it('accepts the largest rule window and late period and rejects the next unit', () => {
    const form = { ...guardForm(settings), changes: '50', windowDays: '365', lateMinutes: '10080' };
    expect(guardRulesToSave(settings, form)).toEqual({
      ok: true,
      save: { ...settings, maxChanges: 50, windowHours: 8760, lateCancelMinutes: 10080 },
    });
    expect(guardRulesToSave(settings, { ...form, windowDays: '366' })).toEqual({
      ok: false,
      problem: 'windowDays',
    });
    expect(guardRulesToSave(settings, { ...form, lateMinutes: '10081' })).toEqual({
      ok: false,
      problem: 'lateMinutes',
    });
  });

  it('clears the last specialist’s rates even if the removed row contains unfinished edits', () => {
    const rates = {
      prices: [{ serviceId: 'haircut', staffId: 'anna', priceGrosze: 1 }],
      durations: [{ serviceId: 'haircut', staffId: 'anna', durationMinutes: 5 }],
    };
    const service = { id: 'haircut', priceGrosze: 5000, durationMinutes: 30 };
    const draft = { anna: { price: '0,', duration: '?' } };
    expect(ratesChange(rates, service, draft, [])).toEqual({ ok: true, prices: [], durations: [] });
    expect(ratesChange(rates, service, draft, ['anna'])).toEqual({
      ok: false,
      problem: 'staffPrice',
      staffId: 'anna',
    });
  });
});

const { platform, secure } = vi.hoisted(() => ({
  platform: { OS: 'web' },
  secure: { getItemAsync: vi.fn(), setItemAsync: vi.fn(), deleteItemAsync: vi.fn() },
}));
vi.mock('react-native', () => ({ Platform: platform }));
vi.mock('expo-secure-store', () => secure);

describe('restoring a business session from storage', () => {
  const key = 'beauty.business.refreshToken';
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetAllMocks();
    vi.resetModules();
  });

  it('clears only the rejected entry and opens sign-in on the next restore without a request', async () => {
    platform.OS = 'web';
    const damaged = 'damaged-but-long-enough-for-refresh';
    const values = new Map([
      [key, damaged],
      ['language', 'uk'],
    ]);
    vi.stubGlobal('localStorage', {
      getItem: (name: string) => values.get(name) ?? null,
      removeItem: (name: string) => values.delete(name),
    });
    const { tokenStore } = await import('../src/storage');
    const refresh = vi.fn(async () =>
      Response.json({ error: { code: 'INVALID_REFRESH_TOKEN' } }, { status: 401 }),
    );
    const api = new BusinessApi('https://api.test', tokenStore, refresh);
    await expect(api.restore()).resolves.toBe(false);
    expect(refresh).toHaveBeenCalledWith(
      'https://api.test/v1/auth/refresh',
      expect.objectContaining({
        body: JSON.stringify({ refreshToken: damaged }),
      }),
    );
    expect(values).toEqual(new Map([['language', 'uk']]));
    await expect(api.restore()).resolves.toBe(false);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('can show sign-in with no browser storage and makes no refresh request', async () => {
    platform.OS = 'web';
    vi.stubGlobal('localStorage', undefined);
    const { tokenStore } = await import('../src/storage');
    const refresh = vi.fn();
    await expect(new BusinessApi('https://api.test', tokenStore, refresh).restore()).resolves.toBe(
      false,
    );
    expect(refresh).not.toHaveBeenCalled();
  });

  it('retries a temporarily unavailable native store without deleting the saved session', async () => {
    platform.OS = 'ios';
    const locked = new Error('Keychain unavailable');
    secure.getItemAsync
      .mockRejectedValueOnce(locked)
      .mockResolvedValueOnce('previous-refresh-token');
    const { tokenStore } = await import('../src/storage');
    const refresh = vi.fn(async () =>
      Response.json({ accessToken: 'access', refreshToken: 'rotated-refresh-token' }),
    );
    const api = new BusinessApi('https://api.test', tokenStore, refresh);
    await expect(api.restore()).rejects.toBe(locked);
    expect(refresh).not.toHaveBeenCalled();
    expect(secure.deleteItemAsync).not.toHaveBeenCalled();
    await expect(api.restore()).resolves.toBe(true);
    expect(secure.setItemAsync).toHaveBeenCalledWith(key, 'rotated-refresh-token');
    expect(api.signedIn).toBe(true);
  });
});
