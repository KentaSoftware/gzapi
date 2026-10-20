# Feature: Deploy gzapi as Vercel REST API without Socket.IO

## Objective
Make `gzapi` deployable as a Vercel Node.js function using MongoDB and the existing REST routes, without relying on Socket.IO.

## Problem
Vercel routes to `src/app.ts`, which exports only the named `createApp` factory. The deployment therefore fails with an invalid default export before MongoDB startup and seeding. The backend also initializes Socket.IO and emits events that are not required for this deployment.

## Scope
- Add a Vercel-compatible default REST handler.
- Cache application/database initialization per warm function instance and preserve idempotent seeding.
- Validate the MongoDB environment variable with a safe diagnostic.
- Remove Socket.IO runtime/dependency usage while preserving REST endpoint behavior.
- Update focused tests and deployment documentation/configuration.

## Constraints
- Work only in `gzapi`.
- Branch from `dev-KentaSoftware`.
- Preserve the existing local `npm run dev` REST behavior.
- Do not expose secrets in logs, tests, docs, or commits.
- Do not change the frontend repository.
- Socket.IO is intentionally out of scope for this deployment.

## Acceptance Criteria
- Vercel receives a default-exported handler and no longer reports an invalid export for `src/app.js`.
- The handler connects with `MONGODB_URI`, runs the existing idempotent seed once per warm instance, and serves existing routes.
- No backend runtime or dependency imports `socket.io`.
- Existing REST tests, build, lint, and focused handler tests pass.
- Local development still starts through `src/server.ts` without Socket.IO.
- A smoke test can verify the deployed handler and Mongo seed without exposing credentials.

## Tasks
- [x] VRS-01 Add and test the Vercel REST entrypoint and initialization lifecycle.
- [x] VRS-02 Remove Socket.IO runtime/dependency usage and preserve REST mutation behavior.
- [x] VRS-03 Update configuration, environment documentation, and deployment-focused tests.
- [x] VRS-04 Run verification, commit the work unit, push the branch, and prepare the PR.

## Authorized Scope
- `vercel.json`
- `api/index.ts`
- `src/app.ts`
- `src/config/mongo.ts`
- `src/server.ts`
- `src/socket.ts`
- `src/interfaces/Socket.types.ts`
- `src/controllers/**/*.ts`
- `src/services/**/*.ts`
- `src/**/*.test.ts`
- `test/**/*.test.ts`
- `package.json`
- `package-lock.json`
- `README.md`
- `AGENTS.md`
- `odd/tasks/gzapi-vercel-rest-without-socket.md`

## Verification
- `npm ci`
- `npm test`
- `npm run lint`
- `npm run build`
- `git diff --check`
- Search confirms no runtime `socket.io` dependency/import remains.

## Forecast
- Estimated authored changes: 150–250 lines plus lockfile updates.
- Delivery strategy: single reviewable work-unit commit and one PR.

## Progress
- Branch created from `dev-KentaSoftware`.
- Task document created before source changes.
- VRS-01 through VRS-03 completed in commit `1a5c1ad`.
- Vercel handler, Mongo URI validation, no-op event adapter, dependency removal, and focused tests are implemented.
- Writer verification: `npm ci` passed; `npm test` passed with 324 tests; `npm run lint` passed; `npm run build` passed; `git diff --check` passed.
- Parent spot check: `npm test` passed with 324 tests.
- Native assessment: medium risk, `slice_budget_reached`; receipt-driven development is disabled for this clone and immutable review transport is unavailable in the active runtime.
- Branch pushed: `origin/fix/vercel-rest-without-socket`.
- Approved issue created: `https://github.com/KentaSoftware/gzapi/issues/8`.
- Pull request created: `https://github.com/KentaSoftware/gzapi/pull/9`, based on `dev-KentaSoftware`, with `type:bug`.
- Vercel Preview check passed and deployment completed.

## Next Step
Review and merge PR #9, then redeploy Production with the configured `MONGODB_URI`, `JWT_SECRET`, and `ADMIN_PASSWORD` values and verify the MongoDB seed.
