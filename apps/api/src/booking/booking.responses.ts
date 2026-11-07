import { visitWishesSchema } from './visit-wishes';
import { z } from 'zod';
import {
  appointmentSourceSchema,
  appointmentStatusSchema,
  cancelledBySchema,
  localeSchema,
  paymentMethodSchema,
} from '../common/enums.schemas';
import { responseSchema } from '../common/openapi';
import { loyaltyRewardKindSchema } from '../loyalty/loyalty.schemas';

const visitCouponFields = {
  id: z.string(),
  code: z.string(),
  name: z.string(),
  kind: loyaltyRewardKindSchema,
  discountPercent: z.number().int().nullable(),
  version: z.number().int(),
};

/** What the salon sees in the calendar, appointment cards, client cards and time blocks. */

export const appointmentSchema = responseSchema(
  'Appointment',
  z.strictObject({
    id: z.string(),
    locationId: z.string(),
    status: appointmentStatusSchema,
    source: appointmentSourceSchema.describe(
      'online = booked by the client, manual = by the salon',
    ),
    start: z.string(),
    end: z.string(),
    blockedUntil: z.string().describe('end plus the cleanup time of the service'),
    date: z.string().describe('Location-local date, YYYY-MM-DD'),
    time: z.string().describe('Location-local start time, HH:MM'),
    staff: z.strictObject({ id: z.string(), displayName: z.string() }),
    service: z.strictObject({ id: z.string(), name: z.string() }),
    customer: z
      .strictObject({
        id: z.string(),
        name: z.string(),
        phone: z.string().nullable().describe('null when the caller may not see client contacts'),
        email: z.string().nullable().describe('null when the caller may not see client contacts'),
        birthdayToday: z
          .boolean()
          .describe(
            "Task 243: the visit is on the client's birthday (the salon's day); false when the caller may not see client contacts",
          ),
      })
      .nullable(),
    priceGrosze: z
      .number()
      .int()
      .nullable()
      .describe('Hundredths of the location currency; null when a staff member may not see prices'),
    discountGrosze: z
      .number()
      .int()
      .nullable()
      .describe(
        'What loyalty coupons take off priceGrosze (the client pays the difference); null when prices are hidden',
      ),
    coupons: z
      .array(
        z.strictObject({
          ...visitCouponFields,
          discountGrosze: z.number().int().nullable().describe('null when prices are hidden'),
        }),
      )
      .describe('Loyalty coupons used on this visit (task 10d)'),
    tierDiscount: z
      .strictObject({
        name: z.string(),
        discountPercent: z.number().int(),
        discountGrosze: z.number().int().nullable().describe('null when prices are hidden'),
      })
      .nullable()
      .describe("The client's tier discount used on this visit (task 10e), as it was then"),
    staffChosenByClient: z
      .boolean()
      .describe('The client chose this staff member themselves (not "any staff member")'),
    firstVisit: z.boolean().describe('No completed visit of this client before this appointment'),
    durationMinutes: z.number().int(),
    bufferMinutes: z.number().int(),
    note: z.string().nullable(),
    wishes: visitWishesSchema,
    holdExpiresAt: z.string().nullable(),
    awaitingApproval: z
      .boolean()
      .describe(
        'Task 161b: booked online by a client the cancellation guard marks; the salon accepts (approve) or cancels it',
      ),
    cancelledAt: z.string().nullable(),
    cancelledBy: cancelledBySchema.nullable(),
    cancelReason: z.string().nullable(),
    paidAt: z
      .string()
      .nullable()
      .describe('When the staff marked the visit as paid (this earns loyalty stamps or points)'),
    paymentMethod: paymentMethodSchema
      .nullable()
      .describe(
        'Task 227: how the client paid, as the staff marked it; null = not said or not paid',
      ),
    tipGrosze: z
      .number()
      .int()
      .describe(
        'Task 229: the tip the client left, in hundredths of the salon currency (0 = none); not part of the price',
      ),
    version: z.number().int(),
    createdAt: z.string(),
  }),
);
export type AppointmentResponse = z.infer<typeof appointmentSchema>;

export const appointmentListSchema = responseSchema('AppointmentList', z.array(appointmentSchema));

export const appointmentDetailSchema = responseSchema(
  'AppointmentDetail',
  appointmentSchema.extend({
    history: z.array(
      z.strictObject({
        type: z.string(),
        actor: z.string(),
        at: z.string(),
        data: z.unknown(),
      }),
    ),
  }),
);
export type AppointmentDetailResponse = z.infer<typeof appointmentDetailSchema>;

export const customerSchema = responseSchema(
  'Customer',
  z.strictObject({
    id: z.string(),
    name: z.string(),
    phone: z.string().nullable().describe('null when the caller may not see client contacts'),
    email: z.string().nullable().describe('null when the caller may not see client contacts'),
    locale: localeSchema,
    note: z.string().nullable().describe('null when the caller may not see notes and tags'),
    tags: z.array(z.string()).nullable(),
    birthday: z
      .string()
      .nullable()
      .describe(
        '"MM-DD", no year (task 240); null when unknown or the caller may not see client contacts',
      ),
    anonymizedAt: z
      .string()
      .nullable()
      .describe('When the owner erased the personal data (GDPR); the name is then "—"'),
    version: z.number().int(),
    createdAt: z.string(),
  }),
);
export type CustomerResponse = z.infer<typeof customerSchema>;

export const customerListSchema = responseSchema('CustomerList', z.array(customerSchema));

/** Task 224: the labels the salon gave its clients, to filter the client list by one. */
export const customerTagsSchema = responseSchema(
  'CustomerTags',
  z.strictObject({
    tags: z
      .array(
        z.strictObject({
          tag: z.string(),
          clients: z.number().int().describe('Clients with this label the caller can see'),
        }),
      )
      .describe(
        'Most used first, then alphabetically; at most 50. Empty when the caller may not see notes and tags',
      ),
  }),
);
export type CustomerTagsResponse = z.infer<typeof customerTagsSchema>;

export const customerDetailSchema = responseSchema(
  'CustomerDetail',
  customerSchema.extend({
    marketingConsent: z.boolean().nullable().describe('null for staff members'),
    visits: z
      .array(
        z.strictObject({
          id: z.string(),
          locationId: z.string(),
          start: z.string(),
          status: appointmentStatusSchema,
          serviceName: z.string(),
          staffName: z.string(),
        }),
      )
      .describe('Staff without viewClientHistory get only their own appointments with this client'),
    summary: z
      .strictObject({
        completed: z.number().int().describe('Visits that took place'),
        noShow: z.number().int().describe('Times the client did not come'),
        cancelledByClient: z.number().int(),
        cancelledBySalon: z.number().int(),
        upcoming: z.number().int().describe('Confirmed visits still ahead'),
        firstVisitAt: z.string().nullable().describe('Start of the first visit that took place'),
        lastVisitAt: z.string().nullable().describe('Start of the latest visit that took place'),
        rhythmDays: z
          .number()
          .int()
          .nullable()
          .describe(
            'Task 250: the client usually comes back every so many days (the median between visits that took place on different days); null with fewer than 3 such visits',
          ),
        favoriteService: z
          .strictObject({ name: z.string(), visits: z.number().int() })
          .nullable()
          .describe(
            'Task 261: the service the client had most often (visits that took place, by name; the latest wins a tie); null below 2 such visits',
          ),
        favoriteStaff: z
          .strictObject({ name: z.string(), visits: z.number().int() })
          .nullable()
          .describe(
            'Task 261: the specialist the client went to most often (visits that took place); null below 2 such visits',
          ),
        paid: z
          .array(
            z.strictObject({
              currency: z.string().describe('ISO 4217 code of the salon'),
              amountGrosze: z
                .number()
                .int()
                .describe('Paid visits after coupons, in hundredths of the currency'),
            }),
          )
          .nullable()
          .describe('One row per currency of the salons; null for staff members'),
      })
      .describe(
        'Task 98: counted over all of the visits the caller may see (the same as `visits`, without the limit of 100)',
      ),
  }),
);
export type CustomerDetailResponse = z.infer<typeof customerDetailSchema>;

export const timeBlockSchema = responseSchema(
  'TimeBlock',
  z.strictObject({
    id: z.string(),
    locationId: z.string(),
    staffId: z.string().nullable().describe('null = the whole location'),
    start: z.string(),
    end: z.string(),
    date: z.string().describe('Location-local start date, YYYY-MM-DD'),
    time: z.string().describe('Location-local start time, HH:MM'),
    reason: z.string().nullable(),
    seriesId: z.string().nullable().describe('Blocks made together as "every week"; null = single'),
    version: z.number().int(),
    deleted: z.boolean(),
    updatedAt: z.string(),
  }),
);
export type TimeBlockResponse = z.infer<typeof timeBlockSchema>;

export const timeBlockListSchema = responseSchema('TimeBlockList', z.array(timeBlockSchema));

export const timeBlockSeriesSchema = responseSchema(
  'TimeBlockSeries',
  z.strictObject({
    seriesId: z.string(),
    items: z.array(timeBlockSchema),
    skippedDates: z
      .array(z.string())
      .describe('Location-local dates left free because appointments were already there'),
  }),
);
export type TimeBlockSeriesResponse = z.infer<typeof timeBlockSeriesSchema>;

const calendarStaffSchema = z.strictObject({
  id: z.string(),
  displayName: z.string(),
  days: z
    .array(
      z.strictObject({
        date: z.string(),
        intervals: z.array(z.strictObject({ start: z.string(), end: z.string() })),
      }),
    )
    .describe('Working hours per local date (special days already applied). Empty = day off'),
});
export type CalendarStaff = z.infer<typeof calendarStaffSchema>;

export const calendarSchema = responseSchema(
  'Calendar',
  z.strictObject({
    location: z.strictObject({
      id: z.string(),
      name: z.string(),
      timezone: z.string(),
      currency: z.string().describe('ISO 4217; prices are in hundredths of it'),
      slotStepMinutes: z.number().int(),
    }),
    from: z.string(),
    to: z.string(),
    staff: z.array(calendarStaffSchema),
    timeOff: z.array(
      z.strictObject({
        id: z.string(),
        staffId: z.string(),
        start: z.string(),
        end: z.string(),
        note: z.string().nullable(),
      }),
    ),
    appointments: z.array(appointmentSchema),
    blocks: z.array(timeBlockSchema),
  }),
);
export type CalendarResponse = z.infer<typeof calendarSchema>;

export const visitCouponsSchema = responseSchema(
  'VisitCoupons',
  z.strictObject({
    tier: z
      .strictObject({
        name: z.string(),
        discountPercent: z.number().int(),
        discountGrosze: z
          .number()
          .int()
          .nullable()
          .describe(
            'What it takes off (applied) or would take off this visit; null when prices are hidden or it cannot be used',
          ),
        applied: z.boolean().describe('Already used on this visit'),
        problem: z
          .enum(['NOT_COMBINABLE', 'NO_DISCOUNT'])
          .nullable()
          .describe('Why it cannot be used on this visit; null = it can'),
      })
      .nullable()
      .describe(
        "The client's tier discount in this salon (task 10e); null when the client has no tier with a discount",
      ),
    applied: z.array(
      z.strictObject({
        ...visitCouponFields,
        discountGrosze: z.number().int().nullable().describe('null when prices are hidden'),
      }),
    ),
    available: z
      .array(
        z.strictObject({
          ...visitCouponFields,
          expiresAt: z.string().nullable(),
          discountGrosze: z
            .number()
            .int()
            .nullable()
            .describe('What it would take off this visit; null when prices are hidden'),
          problem: z
            .enum(['EXPIRED', 'NOT_FOR_SERVICE', 'NOT_COMBINABLE', 'NO_DISCOUNT'])
            .nullable()
            .describe('Why it cannot be used on this visit; null = it can'),
        }),
      )
      .describe("The client's unused coupons in this salon"),
  }),
);
export type VisitCouponsResponse = z.infer<typeof visitCouponsSchema>;
