import { describe, expect, it } from 'vitest';
import { encodeQr as businessQr } from '../../mobile-business/src/qr';
import { encodeQr as cabinetQr } from '../../web/lib/qr';
import { encodeQr, qrRuns, utf8 } from '../src/qr';

/** All modules as text rows ('#' dark, '.' light). */
function rows(qr: { size: number; isDark(x: number, y: number): boolean }): string[] {
  const out: string[] = [];
  for (let y = 0; y < qr.size; y++) {
    let row = '';
    for (let x = 0; x < qr.size; x++) row += qr.isDark(x, y) ? '#' : '.';
    out.push(row);
  }
  return out;
}

describe('salon QR code in the client app (task 357)', () => {
  it('is module for module the code of the cabinet and the business app', () => {
    for (const text of [
      'https://app.example.com/pl/b/gestalt-barbershop',
      'http://localhost:3000/uk/b/kyiv-barber',
      `https://app.example.com/en/b/${'long-salon-name-'.repeat(12)}`,
    ]) {
      const ours = rows(encodeQr(text));
      expect(ours).toEqual(rows(cabinetQr(text)));
      expect(ours).toEqual(rows(businessQr(text)));
    }
  });

  it('encodes an empty payload as a version 1 symbol', () => {
    const qr = encodeQr('');
    expect(qr.version).toBe(1);
    expect(qr.size).toBe(21);
    expect(rows(qr)).toEqual(rows(cabinetQr('')));
  });

  it('fits exactly 2331 UTF-8 bytes into a version 40 symbol', () => {
    const full = 'ł'.repeat(1165) + 'a';
    expect(encodeQr(full)).toMatchObject({ version: 40, size: 177 });
    expect(() => encodeQr(full + 'a')).toThrow(RangeError);
  });

  it.each(['x\ud83dy', 'x\udc88y'])('replaces an unpaired surrogate in the payload', (text) => {
    expect(utf8(text)).toEqual(Array.from(new TextEncoder().encode(text)));
    expect(rows(encodeQr(text))).toEqual(rows(encodeQr('x�y')));
  });

  it('writes letters as UTF-8 without TextEncoder', () => {
    for (const text of ['Łódź', 'Київ', '💈']) {
      expect(utf8(text)).toEqual(Array.from(new TextEncoder().encode(text)));
    }
  });

  it('chooses the version by UTF-8 bytes at the version 1 limit of 14 bytes', () => {
    const exactlyFull = '💈'.repeat(3) + 'ł';
    expect(encodeQr(exactlyFull).version).toBe(1);
    expect(encodeQr(exactlyFull + 'x').version).toBe(2);
  });

  it('rejects a payload one byte beyond the largest level M code', () => {
    expect(() => encodeQr('a'.repeat(2332))).toThrow(RangeError);
  });

  it('draws every dark module exactly once', () => {
    const qr = encodeQr('https://app.example.com/pl/b/gestalt-barbershop');
    let drawn = 0;
    for (const run of qrRuns(qr)) {
      for (let i = 0; i < run.length; i++) expect(qr.isDark(run.x + i, run.y)).toBe(true);
      drawn += run.length;
    }
    let dark = 0;
    for (let y = 0; y < qr.size; y++) for (let x = 0; x < qr.size; x++) if (qr.isDark(x, y)) dark++;
    expect(drawn).toBe(dark);
  });
});
