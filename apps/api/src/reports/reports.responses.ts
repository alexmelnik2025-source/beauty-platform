import { z } from 'zod';
import { responseSchema } from '../common/openapi';

const money = (what: string) =>
  z.number().int().describe(`${what}, in hundredths of the location currency`);

export const salonReportSchema = responseSchema(
  'SalonReport',
  z.strictObject({
    from: z.string(),
    to: z.string(),
    currency: z.string().describe('ISO 4217 code of the location currency'),
    totals: z.strictObject({
      appointments: z
        .number()
        .int()
        .describe('Booked visits in the period (holds that were never confirmed are left out)'),
      completed: z.number().int().describe('Visits the client came to'),
      noShow: z.number().int(),
      cancelledByClient: z.number().int(),
      cancelledBySalon: z.number().int(),
      upcoming: z.number().int().describe('Booked and not marked yet (came / did not come)'),
      online: z.number().int().describe('Booked by the clients themselves online'),
      paidVisits: z.number().int().describe('"Came" visits marked as paid'),
      revenueGrosze: money('What the clients paid for paid visits, after discounts'),
      discountGrosze: money('Coupon and tier discounts on paid visits'),
      averageTicketGrosze: z
        .number()
        .int()
        .nullable()
        .describe('revenueGrosze / paidVisits, rounded down; null without paid visits'),
      noShowPercent: z
        .number()
        .int()
        .nullable()
        .describe('No-shows out of came + did not come, rounded; null when neither'),
      clients: z.number().int().describe('Different clients who came'),
      newClients: z
        .number()
        .int()
        .describe('Clients who came to the salon for the first time in this period'),
    }),
    byStaff: z
      .array(
        z.strictObject({
          staffId: z.string(),
          displayName: z.string(),
          completed: z.number().int(),
          noShow: z.number().int(),
          paidVisits: z.number().int(),
          revenueGrosze: money('What the clients paid'),
        }),
      )
      .describe('Staff members with visits in the period, most paid first'),
    byService: z
      .array(
        z.strictObject({
          serviceId: z.string(),
          name: z.string(),
          completed: z.number().int(),
          paidVisits: z.number().int(),
          revenueGrosze: money('What the clients paid'),
        }),
      )
      .describe('Services with visits in the period, most paid first'),
    byDay: z
      .array(
        z.strictObject({
          date: z.string(),
          completed: z.number().int(),
          revenueGrosze: money('What the clients paid'),
        }),
      )
      .describe('Every local day of the period, in order'),
  }),
);
export type SalonReportResponse = z.infer<typeof salonReportSchema>;
