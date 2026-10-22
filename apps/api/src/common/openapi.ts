import { ApiBody } from '@nestjs/swagger';
import { z } from 'zod';

type ApiBodyOptions = Parameters<typeof ApiBody>[0];
type SchemaObject = NonNullable<Extract<ApiBodyOptions, { schema?: unknown }>['schema']>;

/** Converts a zod schema into an OpenAPI schema, so validation and docs never disagree. */
export function openApiSchema(schema: z.ZodType): SchemaObject {
  const { $schema: _ignored, ...jsonSchema } = z.toJSONSchema(schema, { io: 'input' }) as Record<
    string,
    unknown
  >;
  return jsonSchema as SchemaObject;
}

/** Documents a request body from the same zod schema that validates it. */
export const ApiZodBody = (schema: z.ZodType): MethodDecorator =>
  ApiBody({ schema: openApiSchema(schema) });
