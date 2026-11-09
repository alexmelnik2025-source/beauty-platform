/**
 * QR code of the salon's page in the client app (task 357): a friend standing next to you scans
 * it and books. The same encoder as the cabinet's "Kod QR" (apps/web/lib/qr.ts) and the business
 * app (apps/mobile-business/src/qr.ts) — test/qr.test.ts checks all give the same code. Byte mode,
 * error correction level M, automatic version 1–40 and mask; drawn with plain Views (`qrRuns`).
 * Follows the structure of Project Nayuki's reference implementation (MIT).
 */

/** Error correction codewords per block, level M, by version (index 0 unused). */
const ECC_PER_BLOCK = [
  0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28,
  28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28,
];
/** Number of error correction blocks, level M, by version (index 0 unused). */
const ECC_BLOCKS = [
  0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25,
  26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49,
];
/** Format bits of level M. */
const LEVEL_M = 0;

export interface QrCode {
  /** Modules per side, without the quiet zone. */
  size: number;
  version: number;
  /** true = dark module. */
  isDark(x: number, y: number): boolean;
}

function at<T>(list: readonly T[], i: number): T {
  return list[i] as T;
}

function rawDataModules(ver: number): number {
  let result = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const numAlign = Math.floor(ver / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (ver >= 7) result -= 36;
  }
  return result;
}

function dataCodewords(ver: number): number {
  return Math.floor(rawDataModules(ver) / 8) - at(ECC_PER_BLOCK, ver) * at(ECC_BLOCKS, ver);
}

function gfMultiply(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

function rsDivisor(degree: number): number[] {
  const result: number[] = new Array<number>(degree - 1).fill(0);
  result.push(1);
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = gfMultiply(at(result, j), root);
      if (j + 1 < result.length) result[j] = at(result, j) ^ at(result, j + 1);
    }
    root = gfMultiply(root, 0x02);
  }
  return result;
}

function rsRemainder(data: readonly number[], divisor: readonly number[]): number[] {
  const result: number[] = divisor.map(() => 0);
  for (const b of data) {
    const factor = b ^ (result.shift() as number);
    result.push(0);
    divisor.forEach((coef, i) => {
      result[i] = at(result, i) ^ gfMultiply(coef, factor);
    });
  }
  return result;
}

function bit(value: number, i: number): boolean {
  return ((value >>> i) & 1) !== 0;
}

export function encodeQr(text: string): QrCode {
  const bytes = utf8(text);
  let ver = 1;
  for (; ; ver++) {
    if (ver > 40) throw new RangeError('Text too long for a QR code');
    const countBits = ver <= 9 ? 8 : 16;
    if (4 + countBits + bytes.length * 8 <= dataCodewords(ver) * 8) break;
  }
  const capacityBits = dataCodewords(ver) * 8;

  // Data bit stream: byte mode, length, bytes, terminator, padding.
  const bits: number[] = [];
  const append = (value: number, len: number) => {
    for (let i = len - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  append(0b0100, 4);
  append(bytes.length, ver <= 9 ? 8 : 16);
  for (const b of bytes) append(b, 8);
  append(0, Math.min(4, capacityBits - bits.length));
  append(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacityBits; pad ^= 0xec ^ 0x11) append(pad, 8);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | at(bits, i + j);
    data.push(b);
  }

  // Error correction blocks, interleaved.
  const numBlocks = at(ECC_BLOCKS, ver);
  const blockEccLen = at(ECC_PER_BLOCK, ver);
  const rawCodewords = Math.floor(rawDataModules(ver) / 8);
  const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
  const shortBlockLen = Math.floor(rawCodewords / numBlocks);
  const divisor = rsDivisor(blockEccLen);
  const blocks: number[][] = [];
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const dat = data.slice(k, k + shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1));
    k += dat.length;
    const ecc = rsRemainder(dat, divisor);
    if (i < numShortBlocks) dat.push(0);
    blocks.push(dat.concat(ecc));
  }
  const codewords: number[] = [];
  for (let i = 0; i < at(blocks, 0).length; i++) {
    blocks.forEach((block, j) => {
      if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks) codewords.push(at(block, i));
    });
  }

  // Function patterns.
  const size = ver * 4 + 17;
  const modules: boolean[][] = Array.from({ length: size }, () =>
    new Array<boolean>(size).fill(false),
  );
  const isFunction: boolean[][] = Array.from({ length: size }, () =>
    new Array<boolean>(size).fill(false),
  );
  const set = (x: number, y: number, dark: boolean) => {
    at(modules, y)[x] = dark;
    at(isFunction, y)[x] = true;
  };
  for (let i = 0; i < size; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }
  const finder = (x: number, y: number) => {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        const xx = x + dx;
        const yy = y + dy;
        if (xx >= 0 && xx < size && yy >= 0 && yy < size) set(xx, yy, dist !== 2 && dist !== 4);
      }
    }
  };
  finder(3, 3);
  finder(size - 4, 3);
  finder(3, size - 4);
  const alignPositions: number[] = [];
  if (ver > 1) {
    const numAlign = Math.floor(ver / 7) + 2;
    const step = Math.floor((ver * 8 + numAlign * 3 + 5) / (numAlign * 4 - 4)) * 2;
    for (let pos = size - 7; alignPositions.length < numAlign - 1; pos -= step) {
      alignPositions.unshift(pos);
    }
    alignPositions.unshift(6);
  }
  const last = alignPositions.length - 1;
  alignPositions.forEach((ax, i) => {
    alignPositions.forEach((ay, j) => {
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          set(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      }
    });
  });
  const drawFormat = (mask: number) => {
    const value = (LEVEL_M << 3) | mask;
    let rem = value;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const f = ((value << 10) | rem) ^ 0x5412;
    for (let i = 0; i <= 5; i++) set(8, i, bit(f, i));
    set(8, 7, bit(f, 6));
    set(8, 8, bit(f, 7));
    set(7, 8, bit(f, 8));
    for (let i = 9; i < 15; i++) set(14 - i, 8, bit(f, i));
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(f, i));
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(f, i));
    set(8, size - 8, true);
  };
  drawFormat(0); // reserves the format area; drawn again with the chosen mask
  if (ver >= 7) {
    let rem = ver;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const v = (ver << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      set(a, b, bit(v, i));
      set(b, a, bit(v, i));
    }
  }

  // Codewords in the zigzag order.
  let index = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!at(at(isFunction, y), x) && index < codewords.length * 8) {
          at(modules, y)[x] = bit(at(codewords, index >>> 3), 7 - (index & 7));
          index++;
        }
      }
    }
  }

  // The mask with the lowest penalty.
  const applyMask = (mask: number) => {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (at(at(isFunction, y), x)) continue;
        let invert: boolean;
        switch (mask) {
          case 0:
            invert = (x + y) % 2 === 0;
            break;
          case 1:
            invert = y % 2 === 0;
            break;
          case 2:
            invert = x % 3 === 0;
            break;
          case 3:
            invert = (x + y) % 3 === 0;
            break;
          case 4:
            invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
            break;
          case 5:
            invert = ((x * y) % 2) + ((x * y) % 3) === 0;
            break;
          case 6:
            invert = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
            break;
          default:
            invert = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
        }
        if (invert) at(modules, y)[x] = !at(at(modules, y), x);
      }
    }
  };
  const dark = (x: number, y: number) => at(at(modules, y), x);
  let bestMask = 0;
  let bestPenalty = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    applyMask(mask);
    drawFormat(mask);
    const p = penalty(size, dark);
    if (p < bestPenalty) {
      bestPenalty = p;
      bestMask = mask;
    }
    applyMask(mask); // XOR again = undo
  }
  applyMask(bestMask);
  drawFormat(bestMask);

  return { size, version: ver, isDark: dark };
}

/** Penalty score of the standard (runs, 2×2 blocks, finder-like patterns, dark/light balance). */
function penalty(size: number, dark: (x: number, y: number) => boolean): number {
  let result = 0;
  const finderLike = [true, false, true, true, true, false, true];
  for (let pass = 0; pass < 2; pass++) {
    const get = pass === 0 ? dark : (x: number, y: number) => dark(y, x);
    for (let y = 0; y < size; y++) {
      let run = 1;
      for (let x = 1; x <= size; x++) {
        if (x < size && get(x, y) === get(x - 1, y)) {
          run++;
        } else {
          if (run >= 5) result += 3 + (run - 5);
          run = 1;
        }
      }
      for (let x = 0; x + 7 <= size; x++) {
        if (!finderLike.every((d, i) => get(x + i, y) === d)) continue;
        const lightBefore = [1, 2, 3, 4].every((i) => x - i < 0 || !get(x - i, y));
        const lightAfter = [0, 1, 2, 3].every((i) => x + 7 + i >= size || !get(x + 7 + i, y));
        if (lightBefore || lightAfter) result += 40;
      }
    }
  }
  let darkCount = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (dark(x, y)) darkCount++;
      if (
        x + 1 < size &&
        y + 1 < size &&
        dark(x, y) === dark(x + 1, y) &&
        dark(x, y) === dark(x, y + 1) &&
        dark(x, y) === dark(x + 1, y + 1)
      ) {
        result += 3;
      }
    }
  }
  const total = size * size;
  result += (Math.ceil(Math.abs(darkCount * 20 - total * 10) / total) - 1) * 10;
  return result;
}

/** UTF-8 bytes of the text (no TextEncoder — not every phone's JavaScript engine has it). */
export function utf8(text: string): number[] {
  const out: number[] = [];
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0;
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else {
      out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
  }
  return out;
}

/** A horizontal run of dark modules: one View on the screen instead of `length` squares. */
export interface QrRun {
  x: number;
  y: number;
  length: number;
}

/** Dark modules joined into horizontal runs, row by row (a typical salon link: ~300 Views). */
export function qrRuns(qr: QrCode): QrRun[] {
  const runs: QrRun[] = [];
  for (let y = 0; y < qr.size; y++) {
    let x = 0;
    while (x < qr.size) {
      if (!qr.isDark(x, y)) {
        x++;
        continue;
      }
      const start = x;
      while (x < qr.size && qr.isDark(x, y)) x++;
      runs.push({ x: start, y, length: x - start });
    }
  }
  return runs;
}
