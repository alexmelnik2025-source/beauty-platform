import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/api';
import { isBarcodeTaken, matchesProductSearch, parseBarcode } from '../src/barcode';

describe('parseBarcode (task 522)', () => {
  it('empty means not written', () => {
    expect(parseBarcode('')).toBeNull();
    expect(parseBarcode('   ')).toBeNull();
  });

  it('drops spaces and writes capital letters, like the server', () => {
    expect(parseBarcode(' 5901234 123457 ')).toBe('5901234123457');
    expect(parseBarcode('gst-wosk-1')).toBe('GST-WOSK-1');
  });

  it.each([
    ['9638 5074', '96385074', '96385075'],
    ['01234565', '01234565', '01234564'],
    ['5901234 123457', '5901234123457', '5901234123458'],
    ['4006381333931', '4006381333931', '4016381333931'],
  ])('checks the EAN digits of %s', (scanned, expected, damaged) => {
    expect(parseBarcode(scanned)).toBe(expected);
    expect(parseBarcode(damaged)).toBeUndefined();
  });

  it('also accepts custom product codes outside the EAN formats', () => {
    expect(parseBarcode('1234567')).toBe('1234567');
    expect(parseBarcode('ab-12345')).toBe('AB-12345');
  });

  it('refuses a code too short, too long or with other signs', () => {
    expect(parseBarcode('12')).toBeUndefined();
    expect(parseBarcode('1'.repeat(33))).toBeUndefined();
    expect(parseBarcode('590/123')).toBeUndefined();
    expect(parseBarcode('ąę123')).toBeUndefined();
  });
});

describe('matchesProductSearch (task 522)', () => {
  const pomade = { name: 'Pomada matowa', barcode: '5901234123457' };
  const wax = { name: 'Wosk', barcode: null };

  it('finds by a piece of the name in any letter case', () => {
    expect(matchesProductSearch(pomade, 'MATO')).toBe(true);
    expect(matchesProductSearch(wax, 'wos')).toBe(true);
    expect(matchesProductSearch(wax, 'pomada')).toBe(false);
  });

  it('finds by the barcode, with spaces or not', () => {
    expect(matchesProductSearch(pomade, '5901234 123457')).toBe(true);
    expect(matchesProductSearch(pomade, '123457')).toBe(true);
    expect(matchesProductSearch(wax, '123457')).toBe(false);
  });

  it('an empty search shows everything', () => {
    expect(matchesProductSearch(wax, '  ')).toBe(true);
  });
});

describe('isBarcodeTaken (task 522)', () => {
  it('is the 409 of a code another product has', () => {
    expect(isBarcodeTaken(new ApiError(409, 'taken', 'BARCODE_TAKEN'))).toBe(true);
    expect(isBarcodeTaken(new ApiError(409, 'limit', 'STOCK_LIMIT'))).toBe(false);
    expect(isBarcodeTaken(new Error('x'))).toBe(false);
  });
});
