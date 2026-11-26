import { expect, it } from 'vitest';
import { timeIn } from '../src/day';
import { localToInstant } from '../src/newVisit';

it.each([
  ['2026-03-29', '01:30', '2026-03-29T00:30:00.000Z', '01:30'],
  ['2026-03-29', '02:30', '2026-03-29T01:30:00.000Z', '03:30'],
  ['2026-10-25', '02:30', '2026-10-25T00:30:00.000Z', '02:30'],
  ['2026-10-25', '03:30', '2026-10-25T02:30:00.000Z', '03:30'],
])('posts the salon schedule instant for a walk-in at %s %s', (date, input, iso, display) => {
  const start = localToInstant(date, input, 'Europe/Warsaw');
  expect(start).toBe(iso);
  expect(timeIn(start, 'Europe/Warsaw')).toBe(display);
});
