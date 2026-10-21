# Feature: Load gzapi routes reliably on Vercel

## Objective
Make every existing gzapi REST route available through the Vercel handler, including `/ping` and `/auth/login`, by replacing filesystem-scanned variable imports with a statically bundled route registry.

## Problem
Production initializes MongoDB and the seed successfully, but `/ping` and `/auth/login` return 404. `src/routes/index.ts` discovers route files with `readdirSync` and imports them through a variable dynamic import; Vercel bundling does not reliably include or resolve those modules, and the loader swallows the import failures.

## Scope
- Replace Vercel-incompatible dynamic route discovery with explicit static route imports and mounts.
- Preserve the existing route URLs and local development behavior.
- Make route-loading failures observable instead of silently returning an empty router.
- Add deterministic coverage proving representative public routes are registered.
- Update deployment tracking and create an approved issue plus PR against `master`.

## Constraints
- Work only in `gzapi`.
- Do not modify `gestion-web-gz`.
- Preserve MongoDB initialization, idempotent seed behavior, authentication behavior, and existing route order where relevant.
- Do not reintroduce Socket.IO.
- Do not expose credentials or secrets in logs, tests, docs, or commits.

## Acceptance Criteria
- Production `GET /ping` returns `PING`.
- Production `POST /auth/login` reaches the auth controller instead of returning Express 404.
- Existing route modules remain mounted under their current filename-based prefixes.
- Local tests and build pass; the route registry does not depend on runtime filesystem scanning.
- Route import failures are surfaced during app construction rather than swallowed.
- An approved GitHub issue is linked from the PR against `master`.

## Tasks
- [x] VRL-01 Map route exports and define the static registry preserving current prefixes.
- [x] VRL-02 Implement the Vercel-safe route registry and focused tests.
- [x] VRL-03 Run verification and confirm local representative endpoint behavior.
- [x] VRL-04 Create the approved issue, push the branch, and open the PR against `master`.

## Authorized Scope
- `src/routes/index.ts`
- `test/phase0/**/*.test.ts`
- `test/**/*.test.ts`
- `odd/tasks/gzapi-vercel-static-route-registry.md`

## Verification
- `npm test`
- `npm run lint`
- `npm run build`
- `git diff --check`
- Runtime route search confirms `/ping` and `/auth/login` are statically registered.

## Progress
- Branch `fix/vercel-static-route-registry` created from `origin/master` at `8d29715`.
- Production evidence confirms MongoDB connection and seed success before route 404 responses.
- Static imports now register all 27 route modules with their filename prefixes; focused route-loader coverage passes for `/ping` and `/auth/login`.
- `npm test` passes with 492 tests; build and diff checks pass. Lint remains blocked by six pre-existing Finance errors.
- Parent spot check: `npm test -- --grep "route loader"` passed with 2 tests.
- Independent verification of commit `5cc2c26` reproduced 492 passing tests, a passing build, passing diff check, and 27 static route imports; the same six Finance lint errors remain.
- Approved issue created: `https://github.com/KentaSoftware/gzapi/issues/11`.
- Branch pushed as `origin/fix/vercel-static-route-registry`.
- Pull request created: `https://github.com/KentaSoftware/gzapi/pull/12`, based on `master`, with `type:bug`.
- Vercel Preview Comments passed; the Vercel deployment check is pending.

## Next Step
Wait for Vercel Preview to complete, then verify `/ping` and `/auth/login` on the deployed preview before merging PR #12.
