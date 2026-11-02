# Initial night shift review — 2026-10-29

Historical snapshot from before the local checkout became available. Its task statuses and validation limits are superseded by the final report in [NIGHT_SHIFT_REPORT.md](NIGHT_SHIFT_REPORT.md); retained here so the earlier branch work and findings are not discarded.

## Scope and execution constraints

This report records work verified through the GitHub repository API. The execution environment used for this session does not provide a checked-out working tree or a shell in which to run pnpm, PostgreSQL, Docker, generated-code commands, or the repository test suite. Therefore no code-level validation is claimed. This limitation is not evidence that the repository itself cannot run these checks.

## Sources inspected

- `README.md` on `main`: Node.js 24, pnpm 12, PostgreSQL-backed tests, workspace scripts.
- `docs/BACKLOG.md` on `main` and `feat/api-client-permissions`.
- `docs/README.md`: architecture, authorization and tenant-isolation expectations, OpenAPI generation workflow, real PostgreSQL requirement.
- `package.json`, `pnpm-workspace.yaml`, `apps/api/package.json`, `packages/api-client/package.json`.
- `apps/api/test/openapi.spec.ts`, `apps/api/src/common/openapi.ts`.
- `apps/api/src/organizations/permissions.controller.ts`, `permissions.service.ts`, `invitations.controller.ts`, `invitations.service.ts`, `apps/api/src/push/push.controller.ts`, `push.service.ts`, `apps/api/src/admin/admin.controller.ts`.
- `apps/web/lib/types.ts`, `packages/api-client/src/index.ts`, `packages/api-client/openapi.json`.
- Git comparison `main...feat/api-client-permissions` and commit `2089523397de9feee69a4eaec3d053735d56e112`.

## Initial repository state

- `feat/api-client-permissions` exists and was one commit ahead of `main`, with no commits behind at inspection time.
- Its difference from `main` contained only a two-line addition to `docs/BACKLOG.md`; the commit ahead is the documented Task 7 part 2b-1 change.
- No open PR was found for this branch at inspection time.
- `apps/web/lib/types.ts` still declares the handwritten `MyPermissions` interface.
- `packages/api-client/openapi.json` contains paths for permissions, invitations, photos, notifications, push subscriptions and admin outbox, but those paths do not yet reference named response schemas. The schema component list does not include dedicated response schemas for those areas. This is a concrete gap to address in Task A, but each schema must first be verified against actual controller/service return values.
- `apps/api/test/openapi.spec.ts` verifies that the saved OpenAPI document matches the document generated from the running API and that selected real responses match strict schemas. The documented refresh commands are:
  - `OPENAPI_WRITE=1 pnpm --filter @beauty/api exec vitest run test/openapi.spec.ts`
  - `pnpm --filter @beauty/api-client generate`

## Task status

### A — Task 7 part 2b-2: typed API client

**Status: partially audited; implementation blocked in this execution environment.**

- Branch: `feat/api-client-permissions` exists; this report is on `docs/night-shift-report`.
- Verified findings: the handwritten `MyPermissions` type remains; targeted endpoints exist in OpenAPI but lack dedicated named response schemas.
- Files changed for implementation: none.
- Tests, lint, typecheck, build: not run; no shell/working tree is available here.
- Required next step: in a local checkout, inspect the complete controllers and services for each endpoint; define strict response schemas next to the owning module; decorate endpoints with `ApiZodResponse`; run the real PostgreSQL OpenAPI tests; regenerate OpenAPI and `@beauty/api-client`; migrate web usage; then remove `MyPermissions` only if all usages are replaced. Run tests, lint, typecheck and build before marking ready for owner review.
- Draft PR: none for implementation.

### B — Task 8: server preparation

**Status: not started.**

- No Dockerfiles, production compose file, environment validation, or deployment guide were changed.
- Docker image builds and compose validation: not run.
- Blocker: cannot safely validate multi-stage builds or production startup configuration without a working checkout and Docker.
- Next step: inspect current Docker/compose files and scripts first, then implement only missing pieces on a separate branch and test actual builds.

### C — Task 9: public directory and language filter

**Status: not started.**

- No code or migrations changed.
- PostgreSQL API tests and map integration: not run.
- Next step: inspect public location API, current language fields and web routes; implement paginated public-only search and PL/UA/RU/BY/EN filtering with privacy tests before adding map UI.

### D — Task 10: bonuses

**Status: not started.**

- No schema, migration, server logic, UI, or tests changed.
- Next step: inspect existing appointment/service/organization models and write additive migration plus isolated server-side rules and PostgreSQL boundary tests before UI work.

### E — authorization and tenant-isolation audit

**Status: partial source review; no security conclusion claimed.**

- Reviewed permission/invitation controller and service source entry points, push controller/service, and platform-admin outbox controller.
- No security tests were run and no vulnerabilities were patched in this session.
- Next step: enumerate every cabinet route and verify organization/location membership and role enforcement in server guards and services. Add cross-organization read/write regression tests for appointments, customers, staff, services, photos, notifications and invitations. Treat untested paths as unaudited, not secure.

### F — PL/UA/RU/EN localization

**Status: not started.**

- No translation files or localization checks changed.
- Next step: identify the actual translation framework and dictionaries; add a test that compares required keys across all four interface locales and fails on missing keys.

## Checks run

- GitHub branch and compare metadata inspection: completed.
- File inspection through GitHub API: completed for the sources listed above.
- Unit/API tests: not run.
- PostgreSQL tests: not run.
- Lint/typecheck/build: not run.
- Docker build/compose validation: not run.
- GitHub Actions status was not successfully retrieved in this session; no CI result is claimed.

## Questions / decisions for owner

- SMS provider remains an existing open decision in `docs/BACKLOG.md`; no provider was selected or integrated.
- Before production deployment, owner must approve hosting/provider choices and any external data-processing agreements. No deployment was performed.
- Translation wording that requires native-speaker review should be listed after the localization scan; no new translation claims are made here.

## Morning review and exact next step

1. Open this report and confirm the repository state has not changed unexpectedly.
2. Resume Task A from `feat/api-client-permissions`.
3. Use a local checkout with Node.js 24, pnpm 12, and the project's test PostgreSQL available; inspect full endpoint return shapes before creating response schemas.
4. Do not mark Task A complete or remove `MyPermissions` until generated types and all checks pass.
5. Continue B–F in the specified order only after each prior task is verifiably complete or explicitly blocked.

This report is deliberately conservative: it records inspection and blockers, not unperformed implementation or tests.
