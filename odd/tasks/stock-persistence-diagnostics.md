# Stock Persistence Diagnostics

## Objective
Add sanitized server-side diagnostics for Smart Stock repository failures so Production logs can help distinguish failure categories without exposing secrets or raw database messages.

## Problem and rationale
The `/stock/overview` endpoint returned `STOCK_REPOSITORY_ERROR` (HTTP 503), but the controller currently emits only the generic response and the request-completion log. The underlying persistence cause is therefore unavailable in runtime logs.

## Scope and constraints
- Log only an allowlisted event/category, static repository operation, bounded cause classification, optional safe numeric database code, and validated request correlation ID; never log raw error messages, stacks, connection strings, query values, or credentials.
- Preserve the existing generic HTTP response and status behavior.
- Use mock-only regression tests. Never log raw error messages, stacks, connection strings, query values, or credentials. The user has now authorized autonomous Production diagnosis, code changes, PR/issue work, and deployment as needed; any page reproduction must use the Stock page and only sanitized runtime diagnostics.
- Preserve unrelated `.gitignore` changes and untracked `.codegraph/`.

## Task checklist
- [x] **SPD-1 — Add sanitized persistence-failure logging and regression coverage.** A repository failure emits a single allowlisted diagnostic with stable code and validated correlation ID; raw details are not logged and the generic 503 response is preserved.
- [x] **SPD-2 — Add safe failure-stage and cause classification.** Overview diagnostics now identify a static repository operation and low-cardinality cause class, optionally a safe integer database code; raw error details remain excluded and the generic 503 envelope is unchanged. Mock-only regression coverage verifies the sanitized record and redaction.
- [x] **SPD-3a — Add bounded `listProducts` substage diagnostics.** Route: delegated direct. Added finite labels for catalog query, category lookup, tracked bucket read, untracked ledger read, and product normalization; controller validates labels before logging, and generic 503 behavior remains unchanged. Added mock-only coverage, including malformed product-ID classification.
- [ ] **SPD-3b — Add bounded product-normalization detail labels.** Route: delegated direct. The first post-deploy reproduction returned `stage=product_normalization`, `cause=unknown`, and the generic 503. Add finite labels for the internal normalization boundaries only; do not expose field values, IDs, raw error text, or schema/data details.
- [ ] **SPD-3c — Reproduce once through the authorized Stock page and apply the evidenced fix.** Route: direct after SPD-3b. Use only the observed safe stage/cause to decide the code fix; if evidence remains inconclusive, stop without speculative data/query changes.

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
- Independent read-only verification of the merged candidate found no actionable issues; confirmed master overview behavior and that latest-sales remains best-effort.
- PR #30 was already merged into `feat/api-startup-stock-seed`; replacement PR #31 targeted `master`, Vercel checks passed, and PR #31 merged as `ca453366d3749aae2da37c1a5509f1b77cce505e`.
- Production deployment `dpl_5UCSSJzff9wsEeQRsujewiMEs9UH` completed READY and aliased to `https://gzapi-inky.vercel.app`.
- Exactly one authorized Stock page reload was made. Its `GET /stock/overview` returned HTTP 503; the one matching sanitized diagnostic had correlation ID `17b96c2a-ab2c-4fe7-ac8f-79dd9e5dccf2`, operation `stock_overview_list_products`, cause `unknown`, and no database code.
- Static review found no deterministic repository/fixture mismatch proving the cause. Possible collection/data-shape explanations remain hypotheses; no database access or further Production request was made.
- Follow-up authorization: user explicitly authorized autonomous further diagnosis, implementation, PR/issue work, and deployment. `vercel env pull` marks the Production connection variable as a non-readable secret; `vercel env run` could not inject it in this PowerShell invocation and instead loaded local `.env` files. No local URI was used and no direct database connection was attempted.
- SPD-3a focused repository + contract tests: 54 passing; includes stage allowlisting/redaction, generic 503 preservation, category lookup failure classification, and malformed product ID normalization classification.
- SPD-3a `npm run build` passed. Scoped `npx ts-standard` reported the already-recorded lint findings in existing repository/test lines; no unrelated lint cleanup was included. `git diff --check` passed (only Windows line-ending conversion warnings).
- Independent read-only review found and corrected an unfiltered-path stage boundary that had classified Product ID conversion errors as category lookup; a regression test observed RED (31 passing, 1 failing) then GREEN (32 passing). The filtered path was unchanged.
- `gentle-ai review mode status`: off (clone-local). `gentle-ai review assess` with untracked `.codegraph/` excluded: medium risk, under budget; no native review was started while RDD is off.
- PR #32 created against `master`, linked to approved issue #29, with exactly one `type:bug` label. At last check, Vercel Preview Comments passed and the Vercel deployment check was still pending.
- After PR #32 merged and deployed, login to the authorized Stock page succeeded. One `/stock/overview` request returned the unchanged generic 503; allowlisted Production log matched correlation ID `8cb5921d-b552-4cb8-b6d5-5f0fff5a629a`, operation `stock_overview_list_products`, cause `unknown`, stage `product_normalization`, and no database code. No raw logs, product data, or credentials were retained. The stage alone does not identify a safe fix.
- SPD-3b adds finite `substage` labels under the broad stage; invalid identity, physical quantity, and inventory metadata each have mock regression coverage, and the controller independently omits unknown substages.
- SPD-3b combined focused contract/repository tests: 55 passing. `npm run build` passed; `git diff --check` passed. Scoped lint reports existing findings only (repository indentation and pre-existing test lines); no new lint findings.
- Independent read-only review found no critical, major, or minor gaps in allowlisting, stage propagation, redaction, generic response preservation, or representative invalid-data tests.

## Progress and next step
- Branch `fix/stock-persistence-diagnostics` created from `feat/api-startup-stock-seed`.
- SPD-1 implementation and checks complete. Work-unit commit: `6c9a55aaaad3239271b9ec6c3c355b08312b5073` (`fix(stock): log sanitized repository failures`).
- SPD-2 implementation and local verification are complete. Work-unit commit: `37ef2cf` (`fix(stock): add safe persistence diagnostics`). PR #30 had already merged into `feat/api-startup-stock-seed`; replacement PR #31 merged into `master`. Production diagnostics are deployed and one page request captured, but `stock_overview_list_products` reported only cause `unknown`.
- SPD-3a implementation and focused verification are complete. Work-unit commit: `d17e71c` (`fix(stock): add repository substage diagnostics`); documentation evidence commit: `0a52c3a`. PR #32 merged as `932f32676585b310986e3d326d60568c00047c8a`; Vercel checks passed. The first authorized post-deploy reproduction identified `product_normalization`, so SPD-3b added finite normalization substages. SPD-3b work-unit commit: `2830d75` (`fix(stock): classify product normalization failures`). Next: deliver SPD-3b through a follow-up PR, deploy, and perform one further page reproduction. No DB connection is needed or planned.
- Forecast: one small work unit, well below the ~400-line delivery budget. Delivery strategy: ask-on-risk.
