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
- Demo fixtures cover six distinct calendar months with at least 120 paid sales, 36 paid purchases, and 60 dated expenses; catalog has at least 80 products, 8 brands, 6 categories, and 5 providers. Route fixtures have no more than 20 road-validated clients.
- A failed geocode or route validation performs no dependent writes and exits non-zero.
- Tests, build, lint result, and diff checks are recorded.

## Tasks
- [x] DMS-01 Implement guarded CLI target resolution, real-address geocoding, and pre-write road validation.
- [x] DMS-02 Implement deterministic route/catalog/sales and finance fixture upserts.
- [x] DMS-03 Add tests, documentation, and execute focused/full verification.
- [x] DMS-04 Expand deterministic, owned route and catalog fixtures while retaining existing IDs and pre-write provider validation.
- [x] DMS-05 Add six-month paid sales, purchase, and expense history; fix cashflow expense date ingestion if required.
- [x] DMS-06 Add offline regression tests for monthly totals, snapshot IDs, ownership, and provider failures; verify and document actual results.
- [x] DMS-07 Reject precise geocoding candidates whose normalized street or house number differs from the requested address.
- [x] DMS-08 Document sequential partial writes and prove deterministic rerun recovery without modifying unrelated records.
- [x] DMS-09 Derive six calendar months from a validated service-date anchor, preserve overlapping fixture keys, and report dry-run addresses as planned only.

## Authorized Scope
- `migrations/demo-001-seed-data.ts`
- `src/services/cashflow.ts`
- `README.md`
- `test/migrations/demo-seed.test.ts`
- `test/cashflow.service.test.ts`
- `odd/tasks/gzapi-demo-data-seed.md`

## Route
- DMS-01: delegated direct writer; multi-file implementation with external-provider and persistence safety.
- DMS-02: delegated direct writer; same bounded writer owns the coherent seed implementation.
- DMS-03: delegated verification after implementation.

## Forecast
- Forecast authored changes: approximately 350 lines, excluding generated files.
- Delivery strategy: `single-pr` (explicit user choice on the expanded seed). Keep the existing PR #17 targeting `master` as the only delivery vehicle; the enlarged diff exceeds the ~400-line review heuristic by user choice.

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
- Expansion reopened as DMS-04 through DMS-06; previous verification applies only to the smaller original fixture, not to this expansion. Dry-run plans data but does not geocode or prove routes.
- Expansion planned: 20 clients, three zones, 85 products, nine brands, seven categories, six providers; each of six months has 21 paid sales, seven paid purchases, 11 expenses. Existing keys remain in `gzapi-demo-seed-v1`. Added candidate addresses are publicly listed at https://www.cgcetucuman.org.ar/sucursales-rapipago/ ; Google precision and route acceptance remain unverified.
- Expansion evidence: cash-date test RED (one failing before the fix), focused `npm test -- --grep 'TICKET-003|demo seed'` 28 passing, final `npm test` 505 passing, `npm run build` passed, local `npm run seed:demo -- --dry-run` reported 21 planned addresses and zero provider/DB calls, `git diff --check` passed. `npm run lint` has six pre-existing Finance errors and no new errors. No real seed, real database, or Google request was performed by this writer.
- Independent verification reopened DMS-07 through DMS-09: precision plus matching city does not prove the requested street/number; sequential writes may stop after a partial fixture; fixed May–October 2026 dates become stale; dry-run must not describe uncalled geocoding as provider-resolved. These are offline corrections only, not evidence of accepted Google results.
- Scoped correction evidence: two focused tests first failed for address mismatch and fixed months; focused suite then passed 14 tests. Injected fifth-write failure left earlier owned writes intact; rerun with the same date filled the missing records and did not mutate an unrelated document. Full `npm test` passed 510 tests; `npm run build` passed; `git diff --check` passed; local dry-run planned 21 candidate addresses and made no DB/provider calls. Lint retains six existing Finance errors outside this task, with no new seed/test errors after fixes. No live database write or Google request was made as part of this correction.
- User selected a single PR against `master` for this expansion. Parent spot check: `npm test -- --grep "demo seed"` passed 16 tests; native risk assessment of the diff reported `medium` with RDD off. Do not describe candidate addresses as road-validated until the provider preflight succeeds.
- Work-unit commit `a5db616` contains DMS-04 through DMS-09, associated regression tests, cashflow correction, and operator documentation. The selected PR slice is the existing PR #17 against `master`; no production seed has run.

## Next Step
An operator must independently review the candidate addresses and run the production dry-run before attempting the real seed. The real run can fail closed if Google rejects any address or DRIVE route; do not claim road validation from dry-run or offline tests.
