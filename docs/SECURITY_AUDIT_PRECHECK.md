# Security audit precheck — 2026-10-29

This is a source-level review checklist, not a penetration-test result. It records what was verified in source and the concrete regression tests still needed. No claim is made that the application is fully secure.

## Verified controls in inspected code

- `MembershipGuard` requires an authenticated request, validates the organization UUID, finds an active membership for the exact user/organization pair, returns 404 for missing/inactive membership, and applies `RequireRoles` metadata.
- The guard builds the request membership context from database membership, location assignments and effective permissions. Owners get an empty `locationIds` list, which appears to be the application's convention for owner-wide access; downstream services must consistently respect that convention.
- Invitation creation restricts managers to staff invitations for locations in their own membership context. The service separately checks that every requested location belongs to the target organization, and checks that staff/category IDs belong to the invited locations/organization.
- The push unsubscribe operation deletes only a subscription matching both the authenticated user ID and endpoint.
- Platform-admin access requires a verified account email listed in `PLATFORM_ADMIN_EMAILS`; unauthorized users receive 404.
- Production configuration rejects in-memory mail and push transports, and rejects non-`none` SMS transports. The VAPID key pair must be configured together.

## Deployment-sensitive finding: rate limits are process-local

`apps/api/src/common/rate-limiter.service.ts` stores counters in a local `Map`. The source comment explicitly says this is suitable for a single API instance and must move to PostgreSQL when there are several instances. The documentation repeats this constraint.

Impact: with multiple API replicas, each replica has independent counters, so the effective limit can be multiplied by the number of replicas and requests routed across replicas do not share a single limit. This is a known deployment limitation, not evidence that the current single-instance deployment is exploitable.

Before horizontal scaling, implement shared atomic limits (PostgreSQL transaction/upsert or another owner-approved shared store) and add concurrent multi-instance-equivalent tests. Do not add a paid provider without approval.

## Required PostgreSQL regression matrix

| Area                    | Test with two different organizations/users                                          | Expected result                               |
| ----------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------- |
| Organization cabinet    | User from org A requests org B's IDs                                                 | 404 for organization access; no data leak     |
| Location-scoped manager | Manager assigned to location A addresses location B in the same org                  | denied; no cross-location read or write       |
| Staff permissions       | Non-owner changes a category/member permission map                                   | 403                                           |
| Invitations             | Manager invites to an unassigned location or references another org's staff/category | rejected; no invitation created               |
| Invitation acceptance   | Wrong verified email, revoked token, expired token, token reused                     | rejected; no membership change                |
| Photos                  | User guesses another tenant's photo/object identifier                                | denied; no metadata or bytes leaked           |
| Notifications/push      | User requests another user's notification or unsubscribes their endpoint             | denied/no-op; no other user's data changes    |
| Admin outbox            | Non-admin or unverified configured admin email accesses/retries queue                | 404; no email retried                         |
| Rate limits             | High-cardinality IP keys and repeated attempts; replica behavior                     | bounded memory and documented effective limit |

Run these tests against the project's real PostgreSQL test setup. Do not replace transactional/concurrency checks with mocks.

## Important review notes

- A route guard alone is not sufficient evidence of tenant isolation: inspect each service query for tenant predicates, especially when a route accepts a location, staff, photo, invitation or notification ID.
- For manager access, test both reads and mutations. Confirm that the service uses the authenticated membership context, rather than trusting submitted organization/location IDs.
- Do not log invitation tokens, auth codes, push keys, SMTP/API secrets, or raw personal data while adding diagnostics.
- The current session did not provide a shell or working tree, so tests, typecheck, lint, build and Docker validation were not run. This checklist is based on source inspection only.
