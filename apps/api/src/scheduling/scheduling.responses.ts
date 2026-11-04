import { z } from 'zod';
import { languageSchema, specialtySchema } from '../common/enums.schemas';
import { responseSchema } from '../common/openapi';

export const serviceCategorySchema = responseSchema(
  'ServiceCategory',
  z.strictObject({
    id: z.string(),
    name: z.string(),
    sortOrder: z.number().int(),
    version: z.number().int(),
  }),
);
export type ServiceCategoryResponse = z.infer<typeof serviceCategorySchema>;

export const serviceCategoryListSchema = responseSchema(
  'ServiceCategoryList',
  z.array(serviceCategorySchema),
);

export const serviceSchema = responseSchema(
  'Service',
  z.strictObject({
    id: z.string(),
    locationId: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    durationMinutes: z.number().int(),
    bufferMinutes: z
      .number()
      .int()
      .describe('Cleanup after the service: blocks the staff member, not shown to clients'),
    priceGrosze: z.number().int().describe('Hundredths of the location currency: 50.00 = 5000'),
    active: z.boolean(),
    sortOrder: z.number().int(),
    categoryId: z.string().nullable(),
    color: z.string().nullable().describe('Calendar colour, #RRGGBB'),
    version: z.number().int(),
    createdAt: z.string(),
    updatedAt: z.string(),
    staffIds: z
      .array(z.string())
      .describe('Specialists who perform it; empty = clients cannot book it online'),
  }),
);
export type ServiceResponse = z.infer<typeof serviceSchema>;

export const serviceListSchema = responseSchema('ServiceList', z.array(serviceSchema));

export const staffSchema = responseSchema(
  'Staff',
  z.strictObject({
    id: z.string(),
    locationId: z.string(),
    userId: z.string().nullable().describe('The team member’s account, when they have one'),
    displayName: z.string().describe('Shown to clients'),
    bio: z.string().nullable(),
    languages: z.array(languageSchema),
    specialties: z
      .array(specialtySchema)
      .describe('What the specialist does, main one first; shown to clients'),
    customSpecialty: z.string().nullable().describe('The salon’s own words, shown after the list'),
    active: z.boolean(),
    sortOrder: z.number().int(),
    version: z.number().int(),
    serviceIds: z.array(z.string()),
    photoUrl: z.string().nullable().describe('/v1/public/photos/<id>; null when there is none'),
    createdAt: z.string(),
    updatedAt: z.string(),
  }),
);
export type StaffResponse = z.infer<typeof staffSchema>;

export const staffListSchema = responseSchema('StaffList', z.array(staffSchema));

const interval = z.strictObject({
  start: z.string().describe('Location-local HH:MM'),
  end: z.string().describe('HH:MM; 24:00 = end of day'),
});

export const workingHoursSchema = responseSchema(
  'WorkingHours',
  z.strictObject({
    timezone: z.string(),
    weekly: z.array(
      z.strictObject({
        weekday: z.number().int().describe('ISO weekday: 1 = Monday … 7 = Sunday'),
        intervals: z.array(interval),
      }),
    ),
    overrides: z
      .array(z.strictObject({ date: z.string(), intervals: z.array(interval) }))
      .describe('Special days from today on; no intervals = day off'),
  }),
);
export type WorkingHoursResponse = z.infer<typeof workingHoursSchema>;

export const timeOffSchema = responseSchema(
  'TimeOff',
  z.strictObject({
    id: z.string(),
    start: z.string().describe("Location-local, 'YYYY-MM-DDTHH:mm'"),
    end: z.string(),
    startsAt: z.string().describe('Instant, ISO 8601 UTC'),
    endsAt: z.string(),
    note: z.string().nullable(),
  }),
);
export type TimeOffResponse = z.infer<typeof timeOffSchema>;

export const timeOffListSchema = responseSchema('TimeOffList', z.array(timeOffSchema));
