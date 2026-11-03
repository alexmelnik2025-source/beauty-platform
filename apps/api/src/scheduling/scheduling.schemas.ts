import { z } from 'zod';
import { isValidLocalDate, parseClock } from './time';
import { languagesSchema } from '../organizations/organizations.schemas';
import { specialtySchema } from '../common/enums.schemas';

const fiveMinuteSteps = (min: number, max: number) =>
  z
    .number()
    .int()
    .min(min)
    .max(max)
    .refine((v) => v % 5 === 0, 'must be a multiple of 5 minutes');

// ── Services ─────────────────────────────────────────────

const serviceFields = {
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(500).nullable(),
  durationMinutes: fiveMinuteSteps(5, 480),
  bufferMinutes: fiveMinuteSteps(0, 120),
  /** Price in grosze: 50.00 PLN = 5000. */
  priceGrosze: z.number().int().min(0).max(10_000_000),
  active: z.boolean(),
  sortOrder: z.number().int().min(0).max(10_000),
  categoryId: z.uuid().nullable(),
  /** Calendar colour "#RRGGBB". */
  color: z
    .string()
    .regex(/^#[0-9A-Fa-f]{6}$/, 'use #RRGGBB')
    .nullable(),
};

const staffIds = z.array(z.uuid()).max(200);

export const createServiceSchema = z.object({
  ...serviceFields,
  description: serviceFields.description.optional(),
  categoryId: serviceFields.categoryId.optional(),
  color: serviceFields.color.optional(),
  bufferMinutes: serviceFields.bufferMinutes.default(0),
  active: serviceFields.active.default(true),
  sortOrder: serviceFields.sortOrder.default(0),
  /** Specialists who perform it; without them clients cannot book the service online. */
  staffIds: staffIds.optional(),
});

export const serviceStaffSchema = z.object({ staffIds });

export const updateServiceSchema = z
  .object(serviceFields)
  .partial()
  .extend({ version: z.number().int().min(1) });

export const createServiceCategorySchema = z.object({
  name: z.string().trim().min(1).max(60),
  sortOrder: z.number().int().min(0).max(10_000).default(0),
});

export const updateServiceCategorySchema = createServiceCategorySchema
  .partial()
  .extend({ version: z.number().int().min(1) });

// ── Staff ────────────────────────────────────────────────

const staffFields = {
  displayName: z.string().trim().min(1).max(80),
  bio: z.string().trim().max(500).nullable(),
  languages: languagesSchema,
  /** Repeats are dropped, the order is kept (the first one is the main specialty). */
  specialties: z
    .array(specialtySchema)
    .max(10)
    .transform((list) => [...new Set(list)]),
  /** The salon's own words when nothing on the list fits; an empty text clears it. */
  customSpecialty: z
    .string()
    .trim()
    .max(40)
    .nullable()
    .transform((v) => (v ? v : null)),
  active: z.boolean(),
  sortOrder: z.number().int().min(0).max(10_000),
};

const serviceIds = z.array(z.uuid()).max(200);

export const createStaffSchema = z.object({
  ...staffFields,
  bio: staffFields.bio.optional(),
  languages: staffFields.languages.default([]),
  specialties: staffFields.specialties.default([]),
  customSpecialty: staffFields.customSpecialty.optional(),
  active: staffFields.active.default(true),
  sortOrder: staffFields.sortOrder.default(0),
  serviceIds: serviceIds.default([]),
});

export const updateStaffSchema = z
  .object(staffFields)
  .partial()
  .extend({ version: z.number().int().min(1) });

export const staffServicesSchema = z.object({ serviceIds });

// ── Working hours ────────────────────────────────────────

const clock = z
  .string()
  .refine((v) => parseClock(v) !== null, 'use HH:mm, e.g. 09:30 (24:00 allowed as an end)')
  .transform((v) => parseClock(v)!);

/** Intervals of one day: sorted, non-overlapping; gaps between them are breaks. */
const dayIntervals = z
  .array(z.object({ start: clock, end: clock }))
  .max(6)
  .superRefine((intervals, ctx) => {
    const sorted = [...intervals].sort((a, b) => a.start - b.start);
    sorted.forEach((interval, i) => {
      if (interval.start >= interval.end) {
        ctx.addIssue({ code: 'custom', message: 'start must be before end' });
      }
      const next = sorted[i + 1];
      if (next && next.start < interval.end) {
        ctx.addIssue({ code: 'custom', message: 'intervals overlap' });
      }
    });
  });

export const weeklyHoursSchema = z.object({
  /** Days not listed are days off. */
  days: z
    .array(z.object({ weekday: z.number().int().min(1).max(7), intervals: dayIntervals }))
    .max(7)
    .refine(
      (days) => new Set(days.map((d) => d.weekday)).size === days.length,
      'each weekday at most once',
    ),
});

export const overrideSchema = z.object({ intervals: dayIntervals.min(1) });

export const localDateSchema = z.string().refine(isValidLocalDate, 'use YYYY-MM-DD');

// ── Time off ─────────────────────────────────────────────

const localDateTime = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, "use the location's local time: YYYY-MM-DDTHH:mm");

export const createTimeOffSchema = z.object({
  start: localDateTime,
  end: localDateTime,
  note: z.string().trim().max(200).optional(),
});

// ── Availability ─────────────────────────────────────────

export const MAX_RANGE_DAYS = 31;

export const availabilityQuerySchema = z
  .object({
    serviceId: z.uuid(),
    staffId: z.uuid().optional(),
    from: localDateSchema,
    to: localDateSchema,
  })
  .refine((q) => q.from <= q.to, { message: 'from must not be after to', path: ['to'] })
  .refine((q) => (Date.parse(q.to) - Date.parse(q.from)) / 86_400_000 < MAX_RANGE_DAYS, {
    message: `at most ${MAX_RANGE_DAYS} days per request`,
    path: ['to'],
  });

export type CreateServiceInput = z.infer<typeof createServiceSchema>;
export type UpdateServiceInput = z.infer<typeof updateServiceSchema>;
export type CreateServiceCategoryInput = z.infer<typeof createServiceCategorySchema>;
export type UpdateServiceCategoryInput = z.infer<typeof updateServiceCategorySchema>;
export type CreateStaffInput = z.infer<typeof createStaffSchema>;
export type UpdateStaffInput = z.infer<typeof updateStaffSchema>;
export type WeeklyHoursInput = z.infer<typeof weeklyHoursSchema>;
export type OverrideInput = z.infer<typeof overrideSchema>;
export type CreateTimeOffInput = z.infer<typeof createTimeOffSchema>;
export type AvailabilityQuery = z.infer<typeof availabilityQuerySchema>;
