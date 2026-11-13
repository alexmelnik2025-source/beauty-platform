import { describe, expect, it } from 'vitest';
import { parsePercent, percentInput, percentText } from '../src/commissions';

describe('commissions (task 375)', () => {
  it('reads what the owner types', () => {
    expect(parsePercent('40')).toBe(40);
    expect(parsePercent(' 42,5 ')).toBe(42.5);
    expect(parsePercent('42.5')).toBe(42.5);
    expect(parsePercent('0')).toBe(0);
    expect(parsePercent('100')).toBe(100);
    expect(parsePercent('')).toBeNull();
    for (const bad of ['42,55', '101', '-1', '4o', '1e2', '100,1']) {
      expect(parsePercent(bad)).toBeUndefined();
    }
  });

  it('shows a percent in the app language', () => {
    expect(percentText(45.5, 'pl')).toBe('45,5%');
    expect(percentText(40, 'en')).toBe('40%');
    expect(percentInput(42.5, 'en')).toBe('42.5');
    expect(percentInput(null, 'pl')).toBe('');
  });
});
