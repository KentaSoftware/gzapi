# Simulation Admin Permissions

## Objective and problem
Restore normal admin access to the Simulation workspace after the merged main/master update. The persisted admin role lacks `simulation:read` and `simulation:write` because `BASE_PERMISSIONS` omits both grants. The frontend correctly denies access from the role embedded in the login JWT.

## Authorization and scope
- User explicitly requested fixing admin access, then creating the related issue and pull request.
- Base: `master` at `41cbc0c`; branch: `fix/simulation-admin-permissions`.
- Change only the admin seed grants, their focused regression coverage, and this task document.
- Preserve existing admin credentials, custom permissions, business-role grants, unrelated data, and prior branches.
- Do not bypass frontend permissions, forge session grants, change demo endpoint authorization, or enable production calculations.
- Runtime verification uses only local `gzapi_simulation_e2e`, API port 3002, and frontend port 3000. Keep the Google provider key empty; no external route/geocoding calls.
- Refresh the admin session through a normal login after reseeding; old JWTs intentionally retain their prior permission snapshot.

## Tasks and route
- [x] ADMIN-1: Add a failing regression for creation and idempotent backfill of admin Simulation read/write grants while preserving custom grants. Implement the minimal seed correction and observe GREEN. Route: delegated direct; trigger: seed behavior and regression tests are two non-trivial files.
- [x] ADMIN-2: Verify focused seed/Simulation tests and actual browser access after normal admin login. Work-unit commit: `651db50`. Route: writer self-check, parent rerun/browser check, medium native risk assessment with RDD off. Failed/skipped unrelated checks are disclosed below.
- [ ] ADMIN-3: Nonduplicate issue https://github.com/KentaSoftware/gzapi/issues/57 created with `bug` and `status:needs-review`. Await maintainer issue approval before opening the linked PR to master. No merge requested. Route: parent git/gh.

## Checks
Safe test-first runner: `npm exec --no -- cross-env TS_NODE_TRANSPILE_ONLY=1 NODE_OPTIONS=--no-strip-types mocha -r ts-node/register test/phase0/seed.test.ts --grep "admin simulation seed permissions" --timeout 10000`. The unfiltered Phase 0 file is not authorized for this verification because its unrelated integration suite drops a separate local database.
Also run the deterministic Simulation HTTP/production composition regressions and `git diff --check`; use actual repository lint/typecheck scripts only and disclose baseline failures.
Before this fix, merged frontend checks passed 28 tests plus TypeScript/lint (three existing image warnings); API deterministic checks passed 197 tests and 47 HTTP tests. Real browser admin login succeeded but `/simulation` was denied, with no demo XHRs.

## Delivery
Forecast: fewer than 200 authored changed lines; `ask-on-risk` default. No oversized PR or review-size exception expected. RDD is off; do not enable it or start native review. Do not auto-merge or publish unrelated local commits.

## Progress and next step
In-memory admin seed regression: RED 0 passing/2 failing for missing grants; GREEN 2 passing. Parent reran the exact filtered safe runner: 2 passing. Three Simulation API/composition suites: 50 passing. `tsc --noEmit` and focused lint pass; repository lint fails on unrelated existing violations. `git diff --cached --check` passed with LF-to-CRLF notices. The existing unfiltered Phase 0 integration suite was not run because it connects to and drops `gzapi_phase0_test`; no such database mutation was performed.

Actual local browser proof: after the normal nodemon restart reran the additive seed, the old JWT still denied access as expected. A normal logout/login as the existing admin loaded the workspace with eight visible scenario records, a surplus switch, and enabled Simular. Created exactly one local demo scenario `ESC-025` through the UI (POST 201), retrieved its detail (GET 200), and opened detail and two-record comparison dialogs with focus inside. No console errors and only `/simulation/demo/*` requests were observed. No manual role mutation, password reset, permission injection, production calculation, or external provider call was needed.

Native assessment: medium risk, under budget, 78 authored changed lines before this evidence update. RDD remained off; writer self-verification and parent rerun/browser readback performed. Verified work-unit commit `651db50` contains the source, regressions, and evidence (80 additions/2 deletions). Issue #57 is created; PR publication awaits its approval. The separate demo-endpoint authorization gap and existing general-seed Google-key error remain out of scope. Both local services remain running, and the refreshed admin session can use Simulation.
