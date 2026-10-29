# Stock Persistence Diagnostics

## Objective
Add sanitized server-side diagnostics for Smart Stock repository failures so Production logs can help distinguish failure categories without exposing secrets or raw database messages.

## Problem and rationale
The `/stock/overview` endpoint returned `STOCK_REPOSITORY_ERROR` (HTTP 503), but the controller currently emits only the generic response and the request-completion log. The underlying persistence cause is therefore unavailable in runtime logs.

## Scope and constraints
- Log only an allowlisted event/category and validated request correlation ID; never log raw error messages, stack traces, connection strings, query values, or credentials.
- Preserve the existing generic HTTP response and status behavior.
- Add a mock-only regression test; no database/provider access, Production retries, environment inspection, or deployment.
- Preserve unrelated `.gitignore` changes and untracked `.codegraph/`.

## Task checklist
- [x] **SPD-1 — Add sanitized persistence-failure logging and regression coverage.** A repository failure emits a single allowlisted diagnostic with stable code and validated correlation ID; raw details are not logged and the generic 503 response is preserved.

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

## Progress and next step
- Branch `fix/stock-persistence-diagnostics` created from `feat/api-startup-stock-seed`.
- SPD-1 implementation and checks complete; preparing its work-unit commit. No Production retry, database/provider access, environment inspection, or deployment performed.
- Forecast: one small work unit, well below the ~400-line delivery budget. Delivery strategy: ask-on-risk.
