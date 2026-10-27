/**
 * Types of the Beauty Platform API, generated from its OpenAPI document — never written by hand.
 * The source is the zod response schemas in apps/api; after changing the API:
 *   OPENAPI_WRITE=1 pnpm --filter @beauty/api exec vitest run test/openapi.spec.ts
 *   pnpm --filter @beauty/api-client generate
 * CI fails while openapi.json or src/schema.d.ts are out of date.
 */
import type { components, paths } from './schema.js';

export type { components, paths };

type Schemas = components['schemas'];

/** The salon page for clients (`GET /v1/public/locations/{slug}`). */
export type PublicLocation = Schemas['PublicLocation'];
/** Free start times (`GET …/availability`). */
export type Availability = Schemas['Availability'];
export type Slot = Schemas['Slot'];
/** A slot kept for 10 minutes while the client confirms. */
export type Hold = Schemas['Hold'];
export type CodeSent = Schemas['CodeSent'];
export type BookingConfirmed = Schemas['BookingConfirmed'];
/** An appointment as the client sees it (manage link). */
export type PublicAppointment = Schemas['PublicAppointment'];
/** "My visits" client app. */
export type ClientPerson = Schemas['ClientPerson'];
export type ClientSignIn = Schemas['ClientSignIn'];
export type ClientCodeSent = Schemas['ClientCodeSent'];
export type ClientAppointment = Schemas['ClientAppointment'];
export type ClientAppointmentList = Schemas['ClientAppointmentList'];

/** Salon account: sign-in, the signed-in user, devices. */
export type User = Schemas['User'];
export type Tokens = Schemas['Tokens'];
export type Message = Schemas['Message'];
export type Me = Schemas['Me'];
export type Role = Me['organizations'][number]['role'];
export type Session = Schemas['SessionList'][number];
/** Salon cabinet: organizations, locations and the catalogue. */
export type Organization = Schemas['Organization'];
export type Location = Schemas['Location'];
export type ServiceCategory = Schemas['ServiceCategory'];
export type Service = Schemas['Service'];
export type Staff = Schemas['Staff'];
export type WorkingHours = Schemas['WorkingHours'];
export type TimeOff = Schemas['TimeOff'];

/** Body of a successful JSON response: `ResponseOf<'/v1/client/me', 'get'>`. */
export type ResponseOf<
  Path extends keyof paths,
  Method extends keyof paths[Path],
> = paths[Path][Method] extends {
  responses: infer R;
}
  ? {
      [Status in keyof R]: Status extends 200 | 201 | 202
        ? R[Status] extends { content: { 'application/json': infer Body } }
          ? Body
          : never
        : never;
    }[keyof R]
  : never;
