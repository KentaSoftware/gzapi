# Feature: Populate gzapi with safe demo data

## Objective
The original objective was to provide a manually-run, idempotent `seed:demo` command that populates the MongoDB used by Vercel with realistic route-optimization and finance fixtures without mutating application startup behavior.

The accepted DMS-10 extension requested a Production-only Vercel build hook. The subsequent DMS-16/17 authorization supersedes that activation point: Production API initialization now awaits base roles/admin and insert-only missing demo fixtures before serving requests. The original manual seed remains available.

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

## Historical constraints (superseded where DMS-16/17 differs)
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
- [x] DMS-10 Wire the documented `vercel-build` hook for Production only; local, preview, and test executions must not connect or write.
- [x] DMS-11 Require explicit URI, matching database name, fixed service date, and Google key when work is needed; require existing admin before dependent writes. Never log secrets.
- [x] DMS-12 Inventory all owned deterministic fixtures before Google or writes; skip complete sets, validate geocoding and bidirectional DRIVE before partial repair, insert only missing fixtures with ownership checks and concurrency-safe behavior.
- [ ] DMS-13 Add deterministic offline RED/GREEN tests, documentation, and full verification. A live Vercel invocation remains unverified until independently observed.
- [x] DMS-14 Fail closed when the base admin is absent even if the fixture inventory is complete; cover connected `complete`, `seeded`, and disconnect-on-failure branches with injected dependencies and offline RED/GREEN tests.
- [x] DMS-15 Gate automatic Production writes behind explicit `DEMO_SEED_MODE=run`; default and `disabled` skip before reading credentials, unexpected modes fail closed, and Preview always skips. Offline RED/GREEN tests and an audit-only Production build with no secrets or database access are recorded. The actual Vercel hook remains unverified.
- [x] DMS-16 Move automatic demo preparation into the awaited Production API initialization sequence after base roles/admin; keep build compile-only and manual CLI intact. Skip local, Preview, and test. Use a fixed service-date anchor so cold starts do not drift; avoid opt-in mode, expected database, and service-date environment requirements.
- [x] DMS-17 Prove offline that complete owned fixtures skip Google but still ensure admin, and missing/unsafe fixtures fail initialization before login. Update operator documentation and run only isolated mock-only tests, build, lint, and diff checks.

## Authorized Scope
- `migrations/demo-001-seed-data.ts`
- `src/services/cashflow.ts`
- `README.md`
- `test/migrations/demo-seed.test.ts`
- `test/cashflow.service.test.ts`
- `odd/tasks/gzapi-demo-data-seed.md`

DMS-10 through DMS-14 scope only: `package.json`, `vercel.json`, `migrations/demo-001-seed-data.ts`, `migrations/demo-002-build-seed.ts`, `test/migrations/demo-seed.test.ts`, `test/migrations/demo-build-seed.test.ts`, `README.md`, and this task document. No remote calls, live seed, deployment, startup changes, or deletions.

DMS-15 bounded scope: `migrations/demo-002-build-seed.ts`, `test/migrations/demo-build-seed.test.ts`, `README.md`, and this task document only. Do not run ambient full-suite tests or execute a live seed.

DMS-16/17 authorized surfaces: `src/services/seed.ts`, `api/index.ts`, `migrations/demo-002-build-seed.ts`, `package.json`, `README.md`, `test/migrations/demo-build-seed.test.ts`, `test/phase0/vercel.handler.test.ts`, and this task document. Historical no-startup-change and build-hook decisions above remain evidence, not current constraints. No real MongoDB/Google calls, Production env inspection, deployment, deletion, or changes outside this list.

## Route
- DMS-01: delegated direct writer; multi-file implementation with external-provider and persistence safety.
- DMS-02: delegated direct writer; same bounded writer owns the coherent seed implementation.
- DMS-03: delegated verification after implementation.
- DMS-10 through DMS-13: delegated bounded writer; multi-file preparation, build wiring, and tests on the existing feature branch.
- DMS-14: same bounded writer, isolated correction to the existing work-unit; no full-suite rerun because the unrelated fixture test can drop its test database.
- DMS-15: bounded writer; one explicit Production opt-in plus audit-only verification, independently reviewed before the work-unit commit.
- DMS-16/17: delegated direct bounded writer; multi-file preparation and one coherent startup behavior work unit with tests and docs. Parent owns commit after review.
- Current delivery boundary: `feat/gzapi-production-build-seed` starts from the merged `master` state after PR #17. Commits `59f660a` and `8bb31f1` are published in draft PR #19 against `master`, linked to approved issue #18. No merge, Production deployment, or live seed was authorized.

## Forecast
- Forecast authored changes: approximately 350 lines, excluding generated files.
- Delivery strategy: `single-pr` for the current Production build-seed unit as draft PR #19 against `master`, linked to approved issue #18. PR #17 was the completed, merged historical seed-expansion slice; its associated issue #16 is closed. The new PR contains only the seven changed files from the two new commits.
- DMS-10 through DMS-13 forecast: roughly 280–450 authored lines including tests and docs; keep one coherent work-unit on the existing single-PR delivery strategy. The 400-line heuristic is advisory, not a reason to omit safety checks.
- DMS-14 follow-up forecast (historical): about 80–140 additional authored lines of tests and explicit dependencies; included in the current `single-pr` work-unit with the unavailable full suite disclosed.
- DMS-15 follow-up forecast (historical): about 60–100 additional authored lines including docs and tests; included in the current `single-pr` work-unit.
- DMS-16/17 forecast: approximately 250–400 authored lines across startup wiring, offline tests, and docs; choose `single-pr` for this bounded work unit on `feat/gzapi-startup-demo-seed` from previously merged PR #19 source head `aac5407`. The 400-line guideline is advisory; retain readable tests and documentation. Parent will evaluate review boundary and commit.

## Verification
- `npm test -- --grep "demo seed"` (first observe RED on new focused tests, then GREEN)
- `npm test` (pending: do not run in the current environment; the unrelated fixture test connects to and drops its test database, and the user explicitly prohibited touching the local test DB).
- `npm run build`
- `npm run lint`
- `git diff --check`
- `npm run vercel-build` only with a verified clean synthetic Production environment, `DEMO_SEED_MODE=disabled`, and no credentials; do not execute on uncertainty.
- `npm run seed:demo -- --dry-run` with a safe non-production target
- DMS-16/17: isolated mock-only `test/migrations/demo-build-seed.test.ts` and `test/phase0/vercel.handler.test.ts` (RED then GREEN when possible), `npm run build`, `npm run lint`, `git diff --check`. Never run full suite, real seed, ambient `vercel-build`, or local DB tests.
- DMS-16/17 RED: isolated `npx mocha -r ts-node/register test/migrations/demo-build-seed.test.ts test/phase0/vercel.handler.test.ts --timeout 10000` with `TS_NODE_TRANSPILE_ONLY=1` and `NODE_OPTIONS=--no-strip-types` had 3 passing, 8 failing (missing startup runner and unawaited demo dependency). GREEN after wiring and final normalization: 11 passing. `npm run build` passed; `npm run lint` reports only the six pre-existing Finance errors outside scope; `git diff --check` passed with line-ending warnings. No MongoDB/Google calls or real deployment.

## Progress
- Current branch/base: `feat/gzapi-production-build-seed` from the `master` state after merged PR #17. Work-unit commit `59f660a` contains DMS-10 through DMS-12, DMS-14 and DMS-15 with tests and docs; `8bb31f1` records its evidence. DMS-13 remains unchecked. Approved issue #18 and draft PR #19 are published; Vercel Preview is pending at first inspection. The latest DMS-15 focused run passed 32 tests; build and the sanitized synthetic Production-disabled `vercel-build` path passed. Lint still reports six pre-existing Finance errors. Full `npm test` is intentionally unavailable under the explicit prohibition on touching the local test database, and the live Vercel Production hook is still unobserved; do not claim full proof.
- DMS-15 RED: focused `npm test -- --grep "demo seed"` returned 30 passing and two failing (unset/disabled mode and unexpected mode reached URI validation). GREEN: 32 passing, including Preview skip and explicit `run` validation/insert-only paths. `npm run build` and `git diff --check` passed; `npm run lint` reports the same six pre-existing Finance errors outside scope. A sanitized child environment containing only Path, SystemRoot, TEMP, TMP, `VERCEL_ENV=production`, and `DEMO_SEED_MODE=disabled` ran `npm run vercel-build`; it compiled and printed `Production demo seed: skipped` with no URI, expected database, service date, or Google key. This proves only the local script path, not actual Vercel Production hook execution. No Mongo/Google connection, live seed, deployment, commit, or full-suite test was performed. DMS-13 remains open pending controlled Vercel proof and isolated full-suite verification.
- DMS-16/17 current behavior supersedes DMS-10–15 build activation. Work-unit commit `2433705` includes startup wiring, mock-only tests, and operator documentation. Parent spot check reran the isolated tests with 11 passing. `api/index.ts` awaits base seed then `runProductionStartupSeed` before creating the app; the runner reuses the existing connection and checks admin before owned inventory, only requesting Google credentials when fixtures are missing. Fixed code anchor `2026-10-21` avoids cold-start drift at the cost of aging history; changing the anchor adds monthly fixture IDs. `vercel-build` compiles only. DMS-13 historical live-hook proof remains unverified; no real Production startup has been observed.
- Independent documentation review: owned fixture inventory checks deterministic `_id`, `fixtureNamespace`, and `fixtureKey`, not payload validity. An edited owned fixture can therefore be considered complete and is not rewritten. The Production first-request duration risk remains unresolved: serial inventory performs hundreds of `findOne` calls, followed by provider calls and sequential writes when records are missing; no real Vercel runtime or timeout measurement exists. The local 11 isolated mock tests and passing build do not establish Production readiness; lint retains six unrelated baseline errors, full suite is forbidden here, and no live Google/DRIVE validation or Production deployment was authorized.
- DMS-14 RED: five new isolated build-runner cases failed because the existing runner ignored injected dependencies and reached the absent real connection; GREEN: all 29 focused `demo seed` cases passed after injecting database/inspection/seed/disconnect and validating `admin` before the complete skip. `npm run build` and `git diff --check` passed; lint reports only the same six pre-existing Finance errors outside authorized files. No Mongo or Google calls. The full suite was intentionally not rerun because its unrelated fixture test can drop a test database. DMS-13 remains open pending live Vercel Production hook proof and safe full-suite verification; no commit.
- DMS-14 independent review confirmed `complete` bypasses admin validation and prior build-runner tests cover only skip/config gates. Focused `demo seed` tests previously ran without database effects; do not rerun full `npm test` because `test/phase0/seed.test.ts` connects to and drops its test database. Live Production Vercel hook proof remains pending.
- DMS-10–13 offline verification: new focused test first RED (`MODULE_NOT_FOUND` for missing build runner), then GREEN 24 passing; Preview `npm run vercel-build` built and printed `skipped`; `npm run build` passed; `git diff --check` passed. `npm run lint` retains six pre-existing Finance errors and no new errors. `npm test` returned 517 passing, one failure in the unrelated route-plan fixture idempotency test because its seed rejects the ambient non-local Mongo target; the test suite's fixture setup connects to and drops its designated test database. Do not rerun that suite without separately approving its database effects. No real demo seed or Google request was invoked. Production Vercel hook execution remains unverified. No commit until required tests pass.
- DMS-10 accepted: official Vercel Node runtime documentation supports `vercel-build` in the nearest function package; the observed previous Production log did not show `npm run build`. Hook execution in a real Production build cannot be proven locally and remains pending.
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
Work-unit commit `2433705` remains local. Production API initialization now runs on the first request; `vercel-build` only compiles and there is no `DEMO_SEED_MODE` activation. Independently assess whether the serial inventory and missing-fixture provider/write sequence can fit Vercel's first-request duration limit before separately authorizing any deployment or live validation. The first real run may fail closed if Google rejects an address or DRIVE route. Do not infer payload validation or Production readiness from the 11 isolated mock tests and build; lint retains six pre-existing Finance errors, full-suite verification remains forbidden by the local test-database constraint, and no live provider or Production execution has occurred.
