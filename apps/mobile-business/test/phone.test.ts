import { describe, expect, it } from 'vitest';
import { dialForTimeZone, normalizePhone } from '../src/phone';

describe('dialForTimeZone', () => {
  it.each([
    ['Europe/Warsaw', '48'],
    ['Europe/Kyiv', '380'],
    ['Europe/Kiev', '380'],
    ['Europe/Rome', '39'],
    ['Europe/Istanbul', '90'],
    ['Unknown', '48'],
  ])('suggests the calling code for %s', (zone, expected) => {
    expect(dialForTimeZone(zone)).toBe(expected);
  });
});

describe('normalizePhone', () => {
  it.each([
    ['600 100-200', undefined, '+48600100200'],
    ['(050) 123 45 67', '380', '+380501234567'],
    ['02 12345678', '39', '+390212345678'],
    ['0044 20 7946 0000', '48', '+442079460000'],
    ['+48 (600) 100-200', '380', '+48600100200'],
    ['12345', '48', '12345'],
    ['abc-123', '48', 'abc123'],
    ['', '48', ''],
  ])('normalizes %j using %s', (value, dial, expected) => {
    expect(normalizePhone(value, dial)).toBe(expected);
  });
});
