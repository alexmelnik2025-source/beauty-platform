import { z } from 'zod';
import { parseClock } from './time';

const clock = z.string().refine((v) => parseClock(v) !== null, 'use HH:mm (00:00–24:00)');

export const replaceHappyHoursSchema = z.object({
  rules: z
    .array(
      z
        .object({
          kind: z
            .enum(['hours', 'lastMinute'])
            .default('hours')
            .describe(
              'Task Q7: hours = chosen days and hours; lastMinute = visits booked online shortly before they start',
            ),
          lastMinuteHours: z
            .number()
            .int()
            .min(1)
            .max(72)
            .nullish()
            .describe('Last Minute only: at most this many hours before the visit (1–72)'),
          weekdays: z
            .array(z.number().int().min(1).max(7))
            .min(1)
            .max(7)
            .optional()
            .describe('ISO weekdays: 1 = Monday … 7 = Sunday (Last Minute: every day if left out)'),
          start: clock
            .optional()
            .describe(
              'Local time the price starts (a visit starting at it gets it; Last Minute: 00:00 if left out)',
            ),
          end: clock
            .optional()
            .describe(
              'Local time the price ends (a visit starting at it does not; Last Minute: 24:00 if left out)',
            ),
          discountPercent: z.number().int().min(1).max(90),
          staffIds: z.array(z.uuid()).max(100).default([]).describe('Empty = every staff member'),
          serviceIds: z.array(z.uuid()).max(500).default([]).describe('Empty = every service'),
        })
        .superRefine((r, ctx) => {
          if (r.kind === 'lastMinute') {
            if (r.lastMinuteHours == null) {
              ctx.addIssue({
                code: 'custom',
                path: ['lastMinuteHours'],
                message: 'required for a Last Minute rule',
              });
            }
            return;
          }
          if (r.lastMinuteHours != null) {
            ctx.addIssue({
              code: 'custom',
              path: ['lastMinuteHours'],
              message: 'only for a Last Minute rule',
            });
          }
          for (const key of ['weekdays', 'start', 'end'] as const) {
            if (r[key] === undefined) {
              ctx.addIssue({ code: 'custom', path: [key], message: 'required' });
            }
          }
        }),
    )
    .max(20),
});

export type ReplaceHappyHoursInput = z.infer<typeof replaceHappyHoursSchema>;
