import { z } from 'zod';
import { paymentMethodSchema } from '../common/enums.schemas';
import { responseSchema } from '../common/openapi';

const money = (what: string) =>
  z.number().int().describe(`${what}, in hundredths of the salon currency`);

const counts = {
  completed: z.number().int().describe('Visits that took place ("came")'),
  noShow: z.number().int().describe('"Did not come"'),
  revenueGrosze: money('What paid visits brought (price minus discounts)'),
  paid: z.number().int().describe('Visits marked as paid'),
  cancelledByClient: z.number().int().describe('Task 219: visits the client cancelled'),
  cancelledBySalon: z.number().int().describe('Task 219: visits the salon cancelled'),
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
    payments: z
      .array(
        z.strictObject({
          method: z
            .enum([...paymentMethodSchema.options, 'unknown'])
            .describe('How the client paid; unknown = the staff did not say'),
          paid: z.number().int().describe('Paid visits of the period'),
          revenueGrosze: money('What they brought (price minus discounts)'),
        }),
      )
      .describe(
        'Task 227: paid visits by payment method ("Sposoby płatności"), most money first, unknown last',
      ),
    tips: z
      .strictObject({
        totalGrosze: money('Tips clients left on the visits of the period that took place'),
        visits: z.number().int().describe('Visits with a tip'),
        staff: z
          .array(
            z.strictObject({
              id: z.string(),
              displayName: z.string(),
              tipsGrosze: money('Tips on the visits of this specialist'),
              visits: z.number().int(),
            }),
          )
          .describe('Specialists with a tip in the period, most first'),
      })
      .describe('Task 229: "Napiwki" — noted by the staff; not part of the revenue'),
    tillCloses: z
      .strictObject({
        days: z
          .array(
            z.strictObject({
              date: z.string(),
              expectedCashGrosze: money('What should have been in the till when it was counted'),
              countedCashGrosze: money('The cash counted in the till'),
              differenceGrosze: z.number().int().describe('Counted minus expected'),
              cashInGrosze: money('Task 237: cash put into the till that day (now)'),
              cashOutGrosze: money('Task 237: cash taken out of the till that day (now)'),
            }),
          )
          .describe('Days of the period whose till was counted, oldest first'),
        differenceGrosze: z
          .number()
          .int()
          .describe('All the differences of the period added up (below zero — cash missing)'),
      })
      .describe(
        'Task 233: "Zamknięcia kasy" (task 232) in the period; empty in a specialist\'s own report',
      ),
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
    rebooking: z
      .strictObject({
        clients: z.number().int().describe('Different clients with a visit that took place'),
        rebooked: z
          .number()
          .int()
          .describe(
            'Of them, clients with a later visit (booked, came or did not come) after their last visit of the period',
          ),
        percent: z.number().int().describe('rebooked of clients, 0–100'),
        staff: z
          .array(
            z.strictObject({
              id: z.string(),
              displayName: z.string(),
              clients: z.number().int(),
              rebooked: z.number().int(),
              percent: z.number().int(),
            }),
          )
          .describe(
            "By the specialist of the client's last visit of the period, most clients first",
          ),
      })
      .describe(
        'Task 218: how many clients of the period booked their next visit ("Kolejna wizyta")',
      ),
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
    marketing: z
      .strictObject({
        clients: z.number().int().describe('Different clients with a visit that took place'),
        consented: z
          .number()
          .int()
          .describe('Of them, clients whose latest answer about the salon messages is "yes"'),
        percent: z.number().int().describe('consented of clients, 0–100'),
        newInPeriod: z
          .number()
          .int()
          .describe('Of the consented, clients who said "yes" for the first time in the period'),
        unsubscribed: z
          .number()
          .int()
          .describe('Clients who once said "yes" and later "no" (for example, the email link)'),
      })
      .describe(
        'Task 244: "Zgody na wiadomości" — counts only; all zeros in a specialist\'s own report',
      ),
  }),
);

export type SalonReport = z.infer<typeof salonReportSchema>;

/** Task 232: the day's till — what the cash visits should have brought and what was counted. */
export const tillCloseSchema = responseSchema(
  'TillClose',
  z.strictObject({
    date: z.string(),
    currency: z.string(),
    expectedCashGrosze: money(
      'What should be in the till now: cash visits plus cash put in minus cash taken out',
    ),
    visitsCashGrosze: money('What the visits of the day paid in cash brought'),
    cashInGrosze: money('Task 236: cash put into the till that day'),
    cashOutGrosze: money('Task 236: cash taken out of the till that day'),
    movements: z
      .array(
        z.strictObject({
          id: z.string(),
          kind: z.enum(['in', 'out']),
          amountGrosze: money('The amount put in or taken out'),
          note: z.string().describe('Why (e.g. "change for the day", "towels")'),
          createdByName: z.string(),
          createdAt: z.string(),
        }),
      )
      .describe('Task 236: cash put in or taken out that day, oldest first'),
    close: z
      .strictObject({
        countedCashGrosze: money('The cash counted in the till'),
        expectedCashGrosze: money('What should have been in the till when it was counted'),
        differenceGrosze: z
          .number()
          .int()
          .describe('Counted minus expected: below zero — cash is missing, above — too much'),
        note: z.string().nullable(),
        closedByName: z.string(),
        closedAt: z.string(),
      })
      .nullable()
      .describe('null — the till of that day was not counted yet'),
    unclosedDay: z
      .string()
      .nullable()
      .describe(
        'Task 239: the latest earlier day (up to 14 days back) on which the till had cash — visits paid in cash, cash put in or taken out — when its till was not counted; null when it was or there was none',
      ),
  }),
);

export type TillCloseResponse = z.infer<typeof tillCloseSchema>;
