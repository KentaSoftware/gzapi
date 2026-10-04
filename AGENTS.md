# AGENTS.md

## Commands
- `npm run dev` starts `src/server.ts` through nodemon.
- `npm start` only runs `dist/server.js`; use it only if `dist/` already exists.
- `npm run lint` runs `ts-standard`.
- `npm test` runs `cross-env TS_NODE_TRANSPILE_ONLY=1 NODE_OPTIONS=--no-strip-types mocha -r ts-node/register "test/**/*.test.ts" --timeout 10000`; `--no-strip-types` keeps ts-node loading `.ts` under Node 24 native type-stripping.
- There is no CI/workflow or pre-commit config in this repo; verification is manual.

## Trust code over docs/scripts
- README env docs are stale for Mongo: code reads `MONGODB_URI`, not `DB_URI`.
- Default port is `3002` (`src/server.ts`), but root PowerShell scripts hardcode `3000`/`5000` and mixed path prefixes.
- App mounts `app.use(router)` with **no** global `/api` prefix.
- Login expects `{ nickname, password }` and returns `{ nickname, token, nameRole }`; some scripts still use `email` or `tokenSession`.
- `src/controllers/health.ts` exists, but there is no route file mounting `/health`.

## Routing conventions
- `src/routes/index.ts` auto-loads every file in `src/routes` and mounts it at `/${filename}`.
- Public paths follow the file name exactly: `purchaseDoc.ts` -> `/purchaseDoc`, `duplicateCheck.ts` -> `/duplicateCheck`, `categorie.ts` -> `/categorie`.
- Several controller comments still mention kebab-case paths like `/purchase-docs/*`; treat route filenames as the source of truth unless route registration changes.

## Architecture / feature wiring
- Entry point is `src/server.ts` (`startServer()`): loads dotenv, connects Mongo, runs `seedDatabase()`, then starts HTTP + Socket.IO. `src/app.ts` exports `createApp()` for tests and composition: deterministic `loadRoutes()`, middleware, request logger and `public/` at `/image`, with no listener and no Mongo connection.
- Purchase-doc uploads are async: `POST /purchaseDoc/upload` stores the file under `public/uploads/purchase-docs`, creates a draft in `PROCESSING`, kicks off Document AI + duplicate check in the background, then clients poll `GET /purchaseDoc/:draftId` and finish with `POST /purchaseDoc/:draftId/confirm`.
- Purchase-doc analysis depends on external Document AI (`DOCUMENT_AI_URL`, default `http://localhost:8000`); upload defaults are 10 MB and `image/jpeg,image/png,image/webp,application/pdf`.
- Catalog search/matching logic lives in `src/services/catalog.ts` and `src/services/productAlias.ts`; the batch-search indexes are a manual mongo-shell migration in `migrations/add-batch-search-indexes.js`.

## Repo-specific gotchas
- Startup seeding needs `ADMIN_PASSWORD`. The seed is idempotent: it upserts the admin role/user by `Role.name` and the business roles (Propietario, Administración, Preventista, Repartidor) with their permission grants.
- Test files under `test/` are tracked and committed; `npm test` only runs `test/**/*.test.ts`.
- `src/app.ts` exports `createApp()` and does not listen; Supertest-style tests import `createApp()` directly (see `test/phase0/`).
- Backup routes shell out to `mongodump` / `mongorestore`; local testing needs MongoDB Database Tools plus `BACKUP_URI`, `USER`, and `PASS`.
- The role service file is literally `src/services/role..ts`, and controllers import it as `../services/role.`. Rename carefully.
