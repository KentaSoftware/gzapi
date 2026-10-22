# Feature: Populate gzapi with safe demo data

## Objective
Provide a manually-run, idempotent `seed:demo` command that populates the MongoDB used by Vercel with realistic route-optimization and finance fixtures without mutating application startup behavior.

Client coordinates must come from real geocoded addresses and must be validated as drivable before any client or dependent fixture is written. The seed must fail closed when geocoding or route validation is unavailable.

## Problem
The deployed database currently contains only bootstrap roles and the `admin` user. The existing route fixture is local-only, uses synthetic coordinates, and finance has no combined demo-data seed. Startup seeding would make every deploy or cold start mutate production data.

## Scope
- Add an explicit CLI migration for demo data.
- Geocode real demo addresses through the configured Google geocoding provider.
- Accept only precise geocoding results and validate depot/client connectivity with Google Routes before persistence.
- Upsert deterministic route, catalog, sales, purchase, and finance fixtures under a dedicated namespace.
- Provide dry-run and explicit target safeguards for remote databases.
- Document execution through Vercel environment variables.

## Constraints
- Work only in `gzapi`.
- Do not change `seedDatabase()` startup behavior.
- Never delete unrelated documents.
- Never persist fallback, synthetic, approximate, or unvalidated client coordinates.
- Do not expose MongoDB URIs, API keys, or credentials in logs, tests, docs, or commits.
- Preserve existing REST routes and the currently disconnected purchase-document route.

## Acceptance Criteria
- `npm run seed:demo -- --dry-run` validates the target and reports the planned fixture without writes.
- The real execution is explicitly target-confirmed and idempotent.
- Every seeded client has a real geocoded address, `placeId`, precise geocoding metadata, and coordinates proven routable by Google Routes.
- Route fixtures contain route-ready clients, sales, vehicles, zones, configuration, and persisted route snapshots.
- Finance fixtures include historical paid sales, paid purchases, expenses, and cashflow configuration sufficient for dashboard testing.
- A failed geocode or route validation performs no dependent writes and exits non-zero.
- Tests, build, lint result, and diff checks are recorded.

## Tasks
- [x] DMS-01 Implement guarded CLI target resolution, real-address geocoding, and pre-write road validation.
- [x] DMS-02 Implement deterministic route/catalog/sales and finance fixture upserts.
- [x] DMS-03 Add tests, documentation, and execute focused/full verification.

## Authorized Scope
- `migrations/demo-001-seed-data.ts`
- `package.json`
- `README.md`
- `test/migrations/demo-seed.test.ts`
- `odd/tasks/gzapi-demo-data-seed.md`

## Route
- DMS-01: delegated direct writer; multi-file implementation with external-provider and persistence safety.
- DMS-02: delegated direct writer; same bounded writer owns the coherent seed implementation.
- DMS-03: delegated verification after implementation.

## Forecast
- Forecast authored changes: approximately 350 lines, excluding generated files.
- Delivery strategy: `ask-on-risk`; one reviewable work-unit commit is planned unless the implementation exceeds the delivery budget.

## Verification
- `npm test`
- `npm run build`
- `npm run lint`
- `git diff --check`
- `npm run seed:demo -- --dry-run` with a safe non-production target

## Progress
- Existing startup seed and route fixture audited.
- Existing route fixture is local-only and uses synthetic coordinates; no finance fixture exists.
- Guarded implementation and deterministic seam tests are now present; verification results are recorded in the implementation handoff.
- Verification observed: `npm test` 498 passing, build passed, lint retained only six known Finance errors, diff check passed, and local dry-run passed without database or provider access.

## Next Step
Run the local dry-run, then run the production dry-run and real seed only after reviewing its address and route-provider output.
