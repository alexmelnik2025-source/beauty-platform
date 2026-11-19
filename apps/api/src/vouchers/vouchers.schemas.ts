import { z } from 'zod';
import { responseSchema } from '../common/openapi';
import { CSV_LOCALES } from '../reports/visits-csv';

const money = (what: string) =>
  z.number().int().describe(`${what}, in hundredths of the salon currency`);

// ── Requests ─────────────────────────────────────────────

/** Task 490: "Nowy bon" — a gift voucher the salon sold at its own till. */
export const createGiftVoucherSchema = z.object({
  amountGrosze: z.number().int().min(100).max(10_000_000),
  /** The last day it may be used (the salon's own time); null or left out = no end. */
  validUntil: z.iso.date().nullable().optional(),
  /** Who it is for or who bought it, in the salon's own words. */
  recipient: z.string().trim().min(1).max(80).nullable().optional(),
  note: z.string().trim().min(1).max(200).nullable().optional(),
});

/** Task 490: "Zapłać bonem" — part or all of what is left. */
export const redeemGiftVoucherSchema = z.object({
  amountGrosze: z.number().int().min(1).max(10_000_000),
  /** What was paid for ("strzyżenie", "pomada"). */
  note: z.string().trim().min(1).max(120).optional(),
});

/**
 * Task 498: "Zmień bon" — the last day, who it is for and the note (not the amount: that is
 * money taken at the till). A field left out stays as it is; null clears it.
 */
export const updateGiftVoucherSchema = z
  .object({
    validUntil: z.iso.date().nullable().optional(),
    recipient: z.string().trim().min(1).max(80).nullable().optional(),
    note: z.string().trim().min(1).max(200).nullable().optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: 'Nothing to change',
  });

export const giftVoucherCodeSchema = z
  .string()
  .trim()
  .min(4)
  .max(20)
  .transform((code) => code.toUpperCase().replace(/[\s-]/g, ''));

export type CreateGiftVoucherInput = z.infer<typeof createGiftVoucherSchema>;
export type RedeemGiftVoucherInput = z.infer<typeof redeemGiftVoucherSchema>;
export type UpdateGiftVoucherInput = z.infer<typeof updateGiftVoucherSchema>;

// ── Responses ────────────────────────────────────────────

export const GIFT_VOUCHER_STATUSES = ['active', 'used', 'expired', 'cancelled'] as const;

const giftVoucher = z.strictObject({
  id: z.string(),
  code: z.string().describe('What the client shows at the till: 8 letters and digits'),
  amountGrosze: money('What it was worth when sold'),
  balanceGrosze: money('What is left to use'),
  validUntil: z
    .string()
    .nullable()
    .describe('The last day it may be used, YYYY-MM-DD in the salon’s own time; null = no end'),
  recipient: z.string().nullable(),
  note: z.string().nullable(),
  status: z
    .enum(GIFT_VOUCHER_STATUSES)
    .describe(
      'active — may be used; used — nothing left; expired — past validUntil; cancelled — by the owner or a manager',
    ),
  soldDate: z.string().describe('The day it was sold, YYYY-MM-DD in the salon’s own time'),
  soldByName: z.string().nullable().describe('Who sold it; null when unknown'),
  cancelledAt: z.iso.datetime().nullable(),
});

export const giftVoucherSchema = responseSchema('GiftVoucher', giftVoucher);

export const giftVoucherListSchema = responseSchema(
  'GiftVoucherList',
  z.strictObject({
    vouchers: z.array(giftVoucher).describe('Newest first, at most 500'),
    activeBalanceGrosze: money('What is left on all the vouchers that may still be used'),
    expiringSoon: z
      .strictObject({
        until: z
          .string()
          .describe('30 days from today in the salon’s own time, YYYY-MM-DD (included)'),
        count: z.number().int().describe('Vouchers that may be used now and end by `until`'),
        balanceGrosze: money('What is left on them'),
      })
      .describe(
        'Task 501: "Wygasają w ciągu 30 dni" — so the salon reminds the client or gives more time',
      ),
  }),
);

export const giftVoucherDetailsSchema = responseSchema(
  'GiftVoucherDetails',
  z.strictObject({
    voucher: giftVoucher,
    uses: z
      .array(
        z.strictObject({
          id: z.string(),
          amountGrosze: money('Paid with the voucher'),
          note: z.string().nullable(),
          date: z.string().describe('The day in the salon’s own time, YYYY-MM-DD'),
          time: z.string().describe('The time in the salon’s own time, HH:MM'),
          byName: z.string().nullable().describe('Who noted it; null when unknown'),
        }),
      )
      .describe('Payments with the voucher, newest first'),
  }),
);

export type GiftVoucherResponse = z.infer<typeof giftVoucherSchema>;
export type GiftVoucherListResponse = z.infer<typeof giftVoucherListSchema>;
export type GiftVoucherDetailsResponse = z.infer<typeof giftVoucherDetailsSchema>;

/** Task 494: "CSV bonów" — the file's language. */
export const vouchersCsvQuerySchema = z.object({
  locale: z.enum(CSV_LOCALES).default('pl'),
});
export type VouchersCsvQuery = z.infer<typeof vouchersCsvQuerySchema>;
