import { z } from 'zod';
import { responseSchema } from '../common/openapi';

export const pushPublicKeySchema = responseSchema(
  'PushPublicKey',
  z.strictObject({ publicKey: z.string().nullable() }),
);
