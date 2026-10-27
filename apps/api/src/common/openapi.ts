import { HttpStatus, type INestApplication } from '@nestjs/common';
import { ApiBody, ApiResponse, DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { z } from 'zod';

type ApiBodyOptions = Parameters<typeof ApiBody>[0];
type SchemaObject = NonNullable<Extract<ApiBodyOptions, { schema?: unknown }>['schema']>;
type OpenApiDocument = ReturnType<typeof SwaggerModule.createDocument>;

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

/**
 * Named response shapes. The zod schema is the single source: the TypeScript type
 * (`z.infer`), the OpenAPI document and from it the typed client (`packages/api-client`).
 */
const responseSchemas = new Map<string, z.ZodType>();

/** A response shape with a name in the OpenAPI document (`components.schemas.<name>`). */
export function responseSchema<T extends z.ZodType>(name: string, schema: T): T {
  const known = responseSchemas.get(name);
  if (known && known !== schema) {
    throw new Error(`Two different response schemas are called ${name}`);
  }
  responseSchemas.set(name, schema);
  return schema;
}

/** The registered schema of a response name (tests check real responses against it). */
export function registeredResponseSchema(name: string): z.ZodType {
  const schema = responseSchemas.get(name);
  if (!schema) throw new Error(`No response schema called ${name}`);
  return schema;
}

function nameOf(schema: z.ZodType): string {
  for (const [name, known] of responseSchemas) {
    if (known === schema) return name;
  }
  throw new Error('Register the response schema with responseSchema(name, schema) first');
}

/** Documents the success response with a registered schema (see `responseSchema`). */
export const ApiZodResponse = (
  schema: z.ZodType,
  status: HttpStatus = HttpStatus.OK,
): MethodDecorator =>
  ApiResponse({ status, schema: { $ref: `#/components/schemas/${nameOf(schema)}` } });

function componentSchema(schema: z.ZodType): SchemaObject {
  const { $schema: _ignored, ...jsonSchema } = z.toJSONSchema(schema, {
    target: 'openapi-3.0',
    io: 'output',
  }) as Record<string, unknown>;
  return jsonSchema as SchemaObject;
}

/** The OpenAPI document of the whole API (served at /v1/docs-json, saved in packages/api-client). */
export function buildOpenApiDocument(app: INestApplication): OpenApiDocument {
  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('Beauty Platform API')
      .setDescription(
        'One API for the owner web app and the iOS/Android apps. Errors: { error: { code, message, requestId } }.',
      )
      .setVersion('v1')
      .addBearerAuth()
      .build(),
  );
  const schemas: Record<string, SchemaObject> = { ...document.components?.schemas };
  const sorted = [...responseSchemas].sort(([a], [b]) => (a < b ? -1 : 1));
  for (const [name, schema] of sorted) {
    schemas[name] = componentSchema(schema);
  }
  document.components = { ...document.components, schemas };
  return document;
}
