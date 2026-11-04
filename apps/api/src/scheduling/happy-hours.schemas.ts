import { z } from 'zod';
import { parseClock } from './time';

const clock = z.string().refine((v) => parseClock(v) !== null, 'use HH:mm (00:00–24:00)');

export const replaceHappyHoursSchema = z.object({
  rules: z
    .array(
      z.object({
        weekdays: z
          .array(z.number().int().min(1).max(7))
          .min(1)
          .max(7)
          .describe('ISO weekdays: 1 = Monday … 7 = Sunday'),
        start: clock.describe('Local time the price starts (a visit starting at it gets it)'),
        end: clock.describe('Local time the price ends (a visit starting at it does not)'),
        discountPercent: z.number().int().min(1).max(90),
        staffIds: z.array(z.uuid()).max(100).default([]).describe('Empty = every staff member'),
        serviceIds: z.array(z.uuid()).max(500).default([]).describe('Empty = every service'),
      }),
    )
    .max(20),
});

export type ReplaceHappyHoursInput = z.infer<typeof replaceHappyHoursSchema>;
