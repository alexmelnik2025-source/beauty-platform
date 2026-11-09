import { describe, expect, it } from 'vitest';
import { encodeQr as cabinetQr } from '../../web/lib/qr';
import { encodeQr, qrRuns, utf8 } from '../src/qr';
import { qrLink } from '../src/share';

/** All modules as text rows ('#' dark, '.' light) — easy to compare and to read in a diff. */
function rows(qr: { size: number; isDark(x: number, y: number): boolean }): string[] {
  const out: string[] = [];
  for (let y = 0; y < qr.size; y++) {
    let row = '';
    for (let x = 0; x < qr.size; x++) row += qr.isDark(x, y) ? '#' : '.';
    out.push(row);
  }
  return out;
}

describe('salon QR code in the business app (task 354)', () => {
  it('opens the same short link as the cabinet’s "Kod QR"', () => {
    expect(qrLink('https://app.example.com/', { slug: 'gestalt-barbershop' })).toBe(
      'https://app.example.com/s/gestalt-barbershop?utm_source=qr',
    );
    expect(qrLink('http://localhost:3000', { slug: 'kyiv-barber' })).toBe(
      'http://localhost:3000/s/kyiv-barber?utm_source=qr',
    );
  });

  it('is module for module the code the cabinet draws', () => {
    for (const text of [
      'https://app.example.com/s/gestalt-barbershop?utm_source=qr',
      'http://localhost:3000/s/a?utm_source=qr',
      `https://app.example.com/s/${'long-salon-name-'.repeat(12)}?utm_source=qr`,
      'Barber Łódź — Київ',
    ]) {
      const ours = encodeQr(text);
      const cabinet = cabinetQr(text);
      expect(ours.version).toBe(cabinet.version);
      expect(ours.size).toBe(cabinet.size);
      expect(rows(ours)).toEqual(rows(cabinet));
    }
  });

  it('writes letters as UTF-8 without TextEncoder', () => {
    for (const text of ['abc', 'Łódź', 'Київ', 'zł €', '✂️💈']) {
      expect(utf8(text)).toEqual(Array.from(new TextEncoder().encode(text)));
    }
  });

  it('has the three finder squares in the corners', () => {
    const qr = encodeQr('https://app.example.com/s/gestalt-barbershop?utm_source=qr');
    expect(qr.size).toBe(qr.version * 4 + 17);
    const r = rows(qr);
    const finderTop = '#######';
    expect(r[0]!.slice(0, 7)).toBe(finderTop);
    expect(r[0]!.slice(-7)).toBe(finderTop);
    expect(r[qr.size - 1]!.slice(0, 7)).toBe(finderTop);
    expect(r[3]!.slice(0, 7)).toBe('#.###.#');
  });

  it('joins dark modules into runs that cover exactly the dark modules', () => {
    const qr = encodeQr('https://app.example.com/s/gestalt-barbershop?utm_source=qr');
    const runs = qrRuns(qr);
    const drawn = new Set<string>();
    for (const run of runs) {
      expect(run.length).toBeGreaterThan(0);
      for (let i = 0; i < run.length; i++) drawn.add(`${run.x + i},${run.y}`);
      // Runs are maximal: a light module (or the edge) on both sides.
      expect(run.x === 0 || !qr.isDark(run.x - 1, run.y)).toBe(true);
      expect(run.x + run.length === qr.size || !qr.isDark(run.x + run.length, run.y)).toBe(true);
    }
    let dark = 0;
    for (let y = 0; y < qr.size; y++) {
      for (let x = 0; x < qr.size; x++) {
        if (qr.isDark(x, y)) {
          dark++;
          expect(drawn.has(`${x},${y}`)).toBe(true);
        }
      }
    }
    expect(drawn.size).toBe(dark);
    // Fewer Views than squares.
    expect(runs.length).toBeLessThan(dark * 0.75);
  });
});
