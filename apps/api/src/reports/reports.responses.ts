import { z } from 'zod';
import { responseSchema } from '../common/openapi';

const money = (what: string) =>
  z.number().int().describe(`${what}, in hundredths of the salon currency`);

const counts = {
  completed: z.number().int().describe('Visits that took place ("came")'),
  noShow: z.number().int().describe('"Did not come"'),
  revenueGrosze: money('What paid visits brought (price minus discounts)'),
  paid: z.number().int().describe('Visits marked as paid'),
};

/** Task 14: what the salon earned and how its visits went in a period. */
export const salonReportSchema = responseSchema(
  'SalonReport',
  z.strictObject({
    location: z.strictObject({
      id: z.string(),
      name: z.string(),
      timezone: z.string(),
      currency: z.string(),
    }),
    from: z.string(),
    to: z.string(),
    scope: z
      .enum(['location', 'own'])
      .describe('location = the whole salon; own = only the visits of the signed-in specialist'),
    totals: z.strictObject({
      visits: z.number().int().describe('Every booked visit in the period, cancelled ones too'),
      upcoming: z.number().int().describe('Booked and not marked yet'),
      ...counts,
      cancelledByClient: z.number().int(),
      cancelledBySalon: z.number().int(),
      online: z.number().int().describe('Visits the clients booked themselves (not cancelled)'),
      discountGrosze: money('Discounts on paid visits'),
      averageTicketGrosze: money('Average paid visit; 0 when none'),
      clients: z.number().int().describe('Different clients with a visit that took place'),
      newClients: z
        .number()
        .int()
        .describe('Clients whose first visit at this salon that took place is in the period'),
    }),
    staff: z
      .array(z.strictObject({ id: z.string(), displayName: z.string(), ...counts }))
      .describe('Specialists with any visit in the period, by revenue'),
    services: z
      .array(z.strictObject({ id: z.string(), name: z.string(), ...counts }))
      .describe('Services with any visit in the period, by revenue'),
    days: z
      .array(
        z.strictObject({
          date: z.string(),
          completed: z.number().int(),
          revenueGrosze: money('Paid that day'),
        }),
      )
      .describe('Every day of the period, in the salon time zone'),
    weekdays: z
      .array(
        z.strictObject({
          weekday: z.number().int().describe('1 = Monday … 7 = Sunday'),
          completed: z.number().int(),
          noShow: z.number().int(),
          revenueGrosze: money('Paid on these weekdays'),
        }),
      )
      .describe('Monday to Sunday: which days of the week are busy and which are weak'),
    previous: z
      .strictObject({
        from: z.string(),
        to: z.string(),
        completed: z.number().int(),
        noShow: z.number().int(),
        paid: z.number().int(),
        revenueGrosze: money('What paid visits brought'),
        averageTicketGrosze: money('Average paid visit; 0 when none'),
        clients: z.number().int(),
      })
      .describe('The same number of days just before the period, to compare with'),
    occupancy: z
      .strictObject({
        workMinutes: z
          .number()
          .int()
          .describe('Working time by the schedule, minus vacations and blocked time'),
        bookedMinutes: z
          .number()
          .int()
          .describe('Part of the working time taken by visits that were not cancelled'),
        percent: z.number().int().describe('bookedMinutes of workMinutes, 0–100'),
        staff: z
          .array(
            z.strictObject({
              id: z.string(),
              displayName: z.string(),
              workMinutes: z.number().int(),
              bookedMinutes: z.number().int(),
              percent: z.number().int(),
            }),
          )
          .describe('Specialists with working time or visits in the period, busiest first'),
      })
      .describe('Task 141: how busy the specialists were ("Obłożenie")'),
    ratings: z
      .strictObject({
        reviews: z.number().int().describe('Reviews clients left for visits of the period'),
        average: z
          .number()
          .nullable()
          .describe('Average stars (1–5, one decimal); null when there are no reviews'),
        stars: z
          .array(z.number().int())
          .length(5)
          .describe('How many reviews gave 1, 2, 3, 4 and 5 stars'),
        staff: z
          .array(
            z.strictObject({
              id: z.string(),
              displayName: z.string(),
              reviews: z.number().int(),
              average: z.number().describe('Average stars, one decimal'),
            }),
          )
          .describe('Specialists with reviews in the period, best rated first'),
      })
      .describe('Task 213: how clients rated the visits of the period ("Oceny")'),
    topClients: z
      .array(
        z.strictObject({
          id: z.string(),
          name: z.string(),
          completed: z.number().int().describe('Visits that took place in the period'),
          revenueGrosze: money('What their paid visits brought'),
        }),
      )
      .describe(
        "Task 215: up to 10 clients who brought the most in the period (names only, no contacts); empty in a specialist's own report",
      ),
    busyHours: z
      .array(
        z.strictObject({
          weekday: z.number().int().describe('1 = Monday … 7 = Sunday'),
          hour: z.number().int().describe('Hour the visit starts at, 0–23, in the salon time zone'),
          visits: z.number().int().describe('Visits that were not cancelled'),
        }),
      )
      .describe('Task 216: "Godziny szczytu" — when visits start, only hours with visits'),
  }),
);

export type SalonReport = z.infer<typeof salonReportSchema>;
