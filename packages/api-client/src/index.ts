/**
 * Types of the Beauty Platform API, generated from its OpenAPI document — never written by hand.
 * The source is the zod response schemas in apps/api; after changing the API:
 *   OPENAPI_WRITE=1 pnpm --filter @beauty/api exec vitest run test/openapi.spec.ts
 *   pnpm --filter @beauty/api-client generate
 * CI fails while openapi.json or src/schema.d.ts are out of date.
 */
import type { components, operations, paths } from './schema.js';

export type { components, paths };

type Schemas = components['schemas'];

/** A currency a salon can price its services in (ISO 4217); amounts are in hundredths of it. */
export type Currency = NonNullable<
  NonNullable<
    operations['LocationsController_update']['requestBody']
  >['content']['application/json']['currency']
>;

/** The salon page for clients (`GET /v1/public/locations/{slug}`). */
export type PublicLocation = Schemas['PublicLocation'];
/** Booking terms and privacy policy of a salon (`GET …/legal`). */
export type PublicLegalTexts = Schemas['PublicLegalTexts'];
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
export type ClientLoyalty = Schemas['ClientLoyalty'];
export type ClientLoyaltyCard = ClientLoyalty['items'][number];

/** Salon account: sign-in, the signed-in user, devices. */
export type User = Schemas['User'];
export type Tokens = Schemas['Tokens'];
export type LoginCodeSent = Schemas['LoginCodeSent'];
export type Message = Schemas['Message'];
export type Me = Schemas['Me'];
export type Role = Me['organizations'][number]['role'];
export type Session = Schemas['SessionList'][number];
/** Salon cabinet: organizations, locations and the catalogue. */
export type Organization = Schemas['Organization'];
export type Location = Schemas['Location'];
/** Templates of the legal texts with the salon details filled in. */
export type LegalTemplates = Schemas['LegalTemplates'];
export type ServiceCategory = Schemas['ServiceCategory'];
export type Service = Schemas['Service'];
export type Staff = Schemas['Staff'];
/** What a specialist does: hairdresser, barber, nails… (the salon's own words are separate). */
export type Specialty = Staff['specialties'][number];
export type WorkingHours = Schemas['WorkingHours'];
export type TimeOff = Schemas['TimeOff'];
/** Salon cabinet: appointments, client cards, time blocks and the calendar. */
export type Appointment = Schemas['Appointment'];
export type AppointmentStatus = Appointment['status'];
export type AppointmentDetail = Schemas['AppointmentDetail'];
export type Customer = Schemas['Customer'];
export type CustomerDetail = Schemas['CustomerDetail'];
export type TimeBlock = Schemas['TimeBlock'];
/** Blocks made at once as "every week" (`POST …/time-blocks/series`). */
export type TimeBlockSeries = Schemas['TimeBlockSeries'];
export type Calendar = Schemas['Calendar'];
/** Salon cabinet: team, staff permissions and invitations. */
export type PermissionCatalog = Schemas['PermissionCatalog'];
export type PermissionKey = PermissionCatalog['permissions'][number]['key'];
export type Permissions = PermissionCatalog['me']['permissions'];
export type StaffCategory = Schemas['StaffCategory'];
export type PermissionMap = StaffCategory['permissions'];
export type Member = Schemas['Member'];
export type Invitation = Schemas['Invitation'];
export type InvitationPreview = Schemas['InvitationPreview'];
export type InvitationAccepted = Schemas['InvitationAccepted'];
/** The bell, Web Push and photos. */
export type Notification = Schemas['Notification'];
export type UnreadCount = Schemas['UnreadCount'];
export type PushPublicKey = Schemas['PushPublicKey'];
export type Photo = Schemas['Photo'];
/** Platform administrators: the email queue. */
export type OutboxStats = Schemas['OutboxStats'];
export type FailedEmail = Schemas['FailedEmail'];
/** Public catalogue of salons with its map. */
export type PublicSalonDirectory = Schemas['PublicSalonDirectory'];
export type PublicSalon = PublicSalonDirectory['items'][number];
/** The salon's loyalty program (owners and managers). */
export type LoyaltyProgram = Schemas['LoyaltyProgram'];
export type LoyaltyAccount = Schemas['LoyaltyAccount'];
export type LoyaltyTransaction = Schemas['LoyaltyTransaction'];
export type LoyaltyReward = Schemas['LoyaltyReward'];
export type LoyaltyCoupon = Schemas['LoyaltyCoupon'];
/** The salon's client tiers (`GET …/loyalty/tiers`). */
export type LoyaltyTiers = Schemas['LoyaltyTiers'];
/** Coupons on a visit and the client's unused ones (`GET …/appointments/{id}/coupons`). */
export type VisitCoupons = Schemas['VisitCoupons'];
export type SalonReport = Schemas['SalonReport'];

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
