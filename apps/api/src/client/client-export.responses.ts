import { z } from 'zod';
import { responseSchema } from '../common/openapi';
import {
  appointmentSourceSchema,
  appointmentStatusSchema,
  cancelledBySchema,
  localeSchema,
} from '../common/enums.schemas';
import { loyaltyTransactionTypeSchema } from '../loyalty/loyalty.responses';
import { visitDrinkSchema, visitMoodSchema } from '../booking/visit-wishes';
import { RESERVATION_STATUSES } from '../shop/shop.schemas';
import { waitlistStatusSchema } from '../waitlist/waitlist.responses';

/**
 * "Download my data" (task 40, GDPR right of access and portability): everything the salons on
 * the platform keep about the signed-in client, found by the confirmed email. Not included:
 * the salon's internal notes and tags, who on the team did what, other clients.
 */

const exportVisitSchema = z.strictObject({
  id: z.string(),
  salon: z.string().describe('The salon place (location) name'),
  date: z.string().describe('Local date at the salon, YYYY-MM-DD'),
  time: z.string().describe('Local wall-clock time at the salon, HH:MM'),
  start: z.string().describe('Instant, ISO 8601 UTC'),
  durationMinutes: z.number().int(),
  service: z.string(),
  staff: z.string(),
  status: appointmentStatusSchema,
  source: appointmentSourceSchema,
  priceGrosze: z.number().int().describe('Hundredths of the currency'),
  discountGrosze: z.number().int(),
  currency: z.string().describe('ISO 4217'),
  paid: z.boolean(),
  cancelledBy: cancelledBySchema.nullable(),
  cancelReason: z.string().nullable(),
  bookedAt: z.string(),
  // Task 617: everything else the client typed or did around the visit.
  wishes: z
    .strictObject({
      mood: visitMoodSchema.nullable(),
      drink: visitDrinkSchema.nullable(),
      note: z.string().nullable(),
    })
    .describe('What the client asked for this visit (task 80)'),
  review: z
    .strictObject({
      rating: z.number().int(),
      text: z.string().nullable(),
      reply: z.string().nullable().describe('The salon’s public answer'),
      at: z.string(),
    })
    .nullable(),
  products: z
    .array(
      z.strictObject({
        name: z.string(),
        quantity: z.number().int(),
        unitPriceGrosze: z.number().int(),
        status: z.enum(RESERVATION_STATUSES),
        reservedAt: z.string(),
      }),
    )
    .describe('Products put aside for this visit (Q3)'),
});

const exportWaitlistSchema = z.strictObject({
  salon: z.string(),
  date: z.string().describe('The day the client waits for, YYYY-MM-DD'),
  service: z.string(),
  staff: z.string().nullable().describe('null: any specialist'),
  name: z.string(),
  phone: z.string().nullable(),
  status: waitlistStatusSchema,
  createdAt: z.string(),
});

const exportSessionSchema = z.strictObject({
  clientType: z.enum(['web', 'mobile']),
  userAgent: z.string().nullable(),
  createdAt: z.string(),
  lastUsedAt: z.string(),
  expiresAt: z.string(),
});

const exportConsentSchema = z.strictObject({
  type: z.enum(['booking_terms', 'marketing']),
  version: z.string().describe('Version of the text the client saw'),
  granted: z.boolean(),
  ip: z.string().nullable(),
  at: z.string(),
});

const exportLoyaltySchema = z.strictObject({
  balance: z.number().int().describe('Stamps of the current cycle or points'),
  lifetimeEarned: z.number().int(),
  history: z.array(
    z.strictObject({
      type: loyaltyTransactionTypeSchema,
      points: z.number().int(),
      balanceAfter: z.number().int(),
      expiresAt: z.string().nullable(),
      at: z.string(),
    }),
  ),
  coupons: z.array(
    z.strictObject({
      code: z.string(),
      name: z.string(),
      status: z.enum(['active', 'used', 'expired', 'cancelled']),
      expiresAt: z.string().nullable(),
      usedAt: z.string().nullable(),
      createdAt: z.string(),
    }),
  ),
});

const exportSalonSchema = z.strictObject({
  // The salon as clients know it (its first place), and the company that keeps the data.
  salon: z.string(),
  company: z.string().describe('The data controller: the organization (company) name'),
  client: z
    .strictObject({
      name: z.string(),
      phone: z.string(),
      email: z.string().nullable(),
      locale: localeSchema,
      birthday: z
        .string()
        .nullable()
        .describe('"MM-DD", no year, if the salon wrote it down (task 240)'),
      createdAt: z.string(),
      wishes: z
        .strictObject({
          mood: visitMoodSchema.nullable(),
          drink: visitDrinkSchema.nullable(),
          note: z.string().nullable(),
        })
        .describe('The standing wishes the salon remembers from the last visit (task 80)'),
    })
    .nullable()
    .describe('null: the client only waits for a time here and has no card yet (task 617)'),
  consents: z.array(exportConsentSchema).describe('Oldest first'),
  visits: z.array(exportVisitSchema).describe('Newest first'),
  loyalty: z.array(exportLoyaltySchema).describe('Loyalty cards in this salon (one per program)'),
  waitlist: z
    .array(exportWaitlistSchema)
    .describe('Task 617: the client’s waiting-list entries in this salon, by the confirmed e-mail'),
});
export type ClientExportSalon = z.infer<typeof exportSalonSchema>;

export const clientExportSchema = responseSchema(
  'ClientDataExport',
  z.strictObject({
    exportedAt: z.string(),
    person: z.strictObject({
      email: z.string(),
      locale: localeSchema,
      createdAt: z.string(),
    }),
    salons: z.array(exportSalonSchema),
    favorites: z
      .array(z.strictObject({ salon: z.string(), since: z.string() }))
      .describe('Task 617: salons the client marked as favorite'),
    sessions: z
      .array(exportSessionSchema)
      .describe('Task 617: where the client is signed in right now (no tokens)'),
  }),
);
export type ClientExportResponse = z.infer<typeof clientExportSchema>;
