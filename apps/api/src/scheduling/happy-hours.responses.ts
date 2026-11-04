import { z } from 'zod';
import { responseSchema } from '../common/openapi';

export const happyHoursSchema = responseSchema(
  'HappyHours',
  z.strictObject({
    rules: z.array(
      z.strictObject({
        id: z.string(),
        weekdays: z.array(z.number().int()).describe('ISO weekdays: 1 = Monday … 7 = Sunday'),
        start: z.string().describe('HH:mm, local time of the salon'),
        end: z.string().describe('HH:mm; a visit starting before it gets the price'),
        discountPercent: z.number().int(),
        staffIds: z.array(z.string()).describe('Empty = every staff member'),
        serviceIds: z.array(z.string()).describe('Empty = every service'),
      }),
    ),
  }),
);
export type HappyHoursResponse = z.infer<typeof happyHoursSchema>;
