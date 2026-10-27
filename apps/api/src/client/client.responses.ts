import { z } from 'zod';
import { publicAppointmentSchema } from '../booking/public-booking.responses';
import { localeSchema } from '../common/enums.schemas';
import { responseSchema } from '../common/openapi';

export const clientPersonSchema = responseSchema(
  'ClientPerson',
  z.strictObject({ id: z.string(), email: z.string(), locale: localeSchema }),
);
export type PersonResponse = z.infer<typeof clientPersonSchema>;

export const clientCodeSentSchema = responseSchema(
  'ClientCodeSent',
  z.strictObject({ codeExpiresAt: z.string() }),
);

export const clientSignInSchema = responseSchema(
  'ClientSignIn',
  z.strictObject({
    person: clientPersonSchema,
    expiresAt: z.string(),
    token: z
      .string()
      .optional()
      .describe(
        'Mobile only: keep it in the Keychain/Keystore and send as `Authorization: Bearer`',
      ),
  }),
);
export type ClientSignInResponse = z.infer<typeof clientSignInSchema>;

export const clientAppointmentSchema = responseSchema(
  'ClientAppointment',
  publicAppointmentSchema.extend({
    bookAgain: z
      .strictObject({ slug: z.string(), serviceId: z.string(), staffId: z.string().nullable() })
      .nullable()
      .describe(
        'Same service and staff member again; null when the salon no longer takes it online',
      ),
  }),
);
export type ClientAppointmentResponse = z.infer<typeof clientAppointmentSchema>;

export const clientAppointmentListSchema = responseSchema(
  'ClientAppointmentList',
  z.strictObject({ items: z.array(clientAppointmentSchema) }),
);
