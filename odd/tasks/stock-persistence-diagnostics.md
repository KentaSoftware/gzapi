# Stock Persistence Diagnostics

## Objective
Add sanitized server-side diagnostics for Smart Stock repository failures so Production logs can help distinguish failure categories without exposing secrets or raw database messages.

## Problem and rationale
The `/stock/overview` endpoint returned `STOCK_REPOSITORY_ERROR` (HTTP 503), but the controller currently emits only the generic response and the request-completion log. The underlying persistence cause is therefore unavailable in runtime logs.

## Scope and constraints
- Log only an allowlisted event/category, static repository operation, bounded cause classification, optional safe numeric database code, and validated request correlation ID; never log raw error messages, stacks, connection strings, query values, or credentials.
- Preserve the existing generic HTTP response and status behavior.
- Use mock-only regression tests. No direct database/provider access or environment inspection. One Production page GET after deployment is authorized solely to collect the sanitized diagnostic; existing API startup behavior may run its idempotent seed as a side effect.
- Preserve unrelated `.gitignore` changes and untracked `.codegraph/`.

## Task checklist
- [x] **SPD-1 — Add sanitized persistence-failure logging and regression coverage.** A repository failure emits a single allowlisted diagnostic with stable code and validated correlation ID; raw details are not logged and the generic 503 response is preserved.
- [x] **SPD-2 — Add safe failure-stage and cause classification.** Overview diagnostics now identify a static repository operation and low-cardinality cause class, optionally a safe integer database code; raw error details remain excluded and the generic 503 envelope is unchanged. Mock-only regression coverage verifies the sanitized record and redaction.
- [ ] **SPD-3 — Capture one authorized Production diagnostic and apply the evidenced fix.** Route: direct after diagnostics. Acceptance: record the sanitized observed category/operation; make only a causal code fix supported by that evidence and mock tests. Do not query the database or retry beyond the single authorized page GET.

## Verification evidence
- Baseline Production evidence: exact request produced HTTP 503; Vercel logs contained only a completion record, with no persistence cause.
- Test-first requirement: observe a failing mock-only regression test before implementation, then pass it after implementation.
- RED: `npx cross-env TS_NODE_TRANSPILE_ONLY=1 NODE_OPTIONS=--no-strip-types mocha -r ts-node/register test/stock.contract.test.ts --timeout 10000` failed at the diagnostic assertion (14 passing, 1 failing); response status/body assertions passed.
- GREEN: same focused command passed (15 passing); regression asserts sentinel persistence text is absent from emitted log payload and the generic 503 envelope is unchanged.
- `npm run build` — passed (`tsc`).
- `npx ts-standard src/controllers/stock.ts test/stock.contract.test.ts` — passed (no output).
- `git diff --check` — passed (no output).
- Independent read-only review — no issues found; parent structural spot-check confirmed allowlisted logging and response preservation.
- Native risk assessment (RDD off): `medium`, `under_budget`; assessment included an unrelated pre-existing `.gitignore` edit, which was left untouched.
- SPD-2 RED: focused contract/repository test command failed as expected (38 passing, 1 failing) at the new diagnostic assertion; existing generic 503 status/body assertions passed.
- SPD-2 GREEN: focused contract/repository test command passed (39 passing).
- SPD-2 `npm run build` — passed (`tsc`).
- SPD-2 scoped `npx ts-standard src/controllers/stock.ts src/services/stock.ts src/services/stockMongoRepository.ts test/stock.contract.test.ts test/stock.mongo.repository.test.ts` — passed (no output).
- SPD-2 `git diff --check` — passed; Git emitted only line-ending conversion warnings.
- SPD-2 correction: removed raw exception retention from `StockServiceError` and diagnostics; Mongo repository wrappers now preserve only allowlisted cause/category, operation, and safe optional database code. Controller independently validates all diagnostic fields before logging.
- Correction test-first RED: focused contract/repository command failed at the unknown diagnostic record assertion (39 passing, 1 failing); response status/body assertions passed.
- Correction GREEN: focused contract/repository command passed (40 passing), including known duplicate-key and unknown cause redaction assertions; generic response unchanged.
- Correction `npm run build` and scoped `npx ts-standard src/controllers/stock.ts src/services/stock.ts src/services/stockMongoRepository.ts test/stock.contract.test.ts test/stock.mongo.repository.test.ts` passed.
- Correction `git diff --check` passed; only line-ending conversion warnings were emitted.
- SPD-2 bounded correction RED: focused contract/repository tests failed as expected (40 passing, 2 failing): Mongo connection name classified unknown and direct repository error labeled as overview list-products.
- SPD-2 bounded correction GREEN: focused contract/repository tests passed (42 passing), including neutral repository operation fallback, exact-name connection classification, arbitrary-name unknown classification, sentinel redaction, and generic 503 response.
- SPD-2 bounded correction `npm run build` passed (`tsc`); scoped `npx ts-standard src/controllers/stock.ts src/services/stock.ts src/services/stockMongoRepository.ts test/stock.contract.test.ts test/stock.mongo.repository.test.ts` passed; `git diff --check` passed (Git emitted line-ending conversion warnings).
- SPD-2 controller correction RED: focused contract/repository tests failed as expected (42 passing, 1 failing), showing that the controller downgraded the valid `connection` cause to `unknown`.
- SPD-2 controller correction GREEN: focused contract/repository tests passed (43 passing), covering allowlisted `connection` and neutral `stock_repository_unknown` fallback for both absent and invalid operation metadata; generic response remains unchanged.
- SPD-2 controller correction `npm run build`, scoped `npx ts-standard src/controllers/stock.ts src/services/stock.ts src/services/stockMongoRepository.ts test/stock.contract.test.ts test/stock.mongo.repository.test.ts`, and `git diff --check` passed; Git emitted only line-ending conversion warnings.
- Merge-resolution check: retained origin/master search/category filtering, rich product display fields, latest-sale status, and per-product expiry alert days while preserving HEAD's sanitized diagnostics. The optional latest-sale read remains caught and non-fatal; propagating list/history/availability/bucket reads (including global-overview reads and filtered catalog totals) carry their matching static operation labels.
- Merge-resolution focused mock test: first attempted before implementation and blocked by the unresolved conflict markers (`TS1185`); after resolution, `test/stock.contract.test.ts`, `test/stock.service.test.ts`, and `test/stock.mongo.repository.test.ts` passed together (110 passing), including the optional-read and repository-stage diagnostic assertions.
- Merge-resolution `npm run build` passed (`tsc`). The requested scoped `npx ts-standard ...` command was run, but reports pre-existing issues in untouched merge files `src/services/stockMongoRepository.ts:1024`, `test/stock.contract.test.ts:150`, and `test/stock.mongo.repository.test.ts:212-213,236-237`; no such findings remain in the changed `src/services/stock.ts` or `test/stock.service.test.ts`.
- SPD-2 merge-resolution `git diff --check` passed (Git emitted only LF-to-CRLF conversion warnings); conflict-marker scan of editable TypeScript source files found no remaining markers. SPD-3 remains pending.

## Progress and next step
- Branch `fix/stock-persistence-diagnostics` created from `feat/api-startup-stock-seed`.
- SPD-1 implementation and checks complete. Work-unit commit: `6c9a55aaaad3239271b9ec6c3c355b08312b5073` (`fix(stock): log sanitized repository failures`).
- SPD-2 implementation and local verification are complete. Work-unit commit: `37ef2cf` (`fix(stock): add safe persistence diagnostics`). PR #30 was already merged into `feat/api-startup-stock-seed`, so it could not be retargeted; replacement PR #31 targets `master`. The merge conflict with newer `master` overview behavior is resolved and verified; SPD-3 remains pending: merge PR #31, deploy, and capture exactly one authorized Production page GET. No direct database/provider access or environment inspection.
- Forecast: one small work unit, well below the ~400-line delivery budget. Delivery strategy: ask-on-risk.
