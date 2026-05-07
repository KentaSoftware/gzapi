# AGENTS.md

## Commands
- `npm run dev` starts `src/app.ts` through nodemon.
- `npm start` only runs `dist/app.js`; use it only if `dist/` already exists.
- `npm run lint` runs `ts-standard`.
- `npm test` runs `cross-env TS_NODE_TRANSPILE_ONLY=1 mocha -r ts-node/register "test/**/*.test.ts" --timeout 10000`.
- There is no CI/workflow or pre-commit config in this repo; verification is manual.

## Trust code over docs/scripts
- README env docs are stale for Mongo: code reads `MONGODB_URI`, not `DB_URI`.
- Default port is `3002` (`src/app.ts`), but root PowerShell scripts hardcode `3000`/`5000` and mixed path prefixes.
- App mounts `app.use(router)` with **no** global `/api` prefix.
- Login expects `{ nickname, password }` and returns `{ nickname, token, nameRole }`; some scripts still use `email` or `tokenSession`.
- `src/controllers/health.ts` exists, but there is no route file mounting `/health`.

## Routing conventions
- `src/routes/index.ts` auto-loads every file in `src/routes` and mounts it at `/${filename}`.
- Public paths follow the file name exactly: `purchaseDoc.ts` -> `/purchaseDoc`, `duplicateCheck.ts` -> `/duplicateCheck`, `categorie.ts` -> `/categorie`.
- Several controller comments still mention kebab-case paths like `/purchase-docs/*`; treat route filenames as the source of truth unless route registration changes.

## Architecture / feature wiring
- Entry point is `src/app.ts`: loads dotenv, connects Mongo, runs `seedDatabase()`, installs the global request logger, serves `public/` at `/image`, then starts HTTP + Socket.IO.
- Purchase-doc uploads are async: `POST /purchaseDoc/upload` stores the file under `public/uploads/purchase-docs`, creates a draft in `PROCESSING`, kicks off Document AI + duplicate check in the background, then clients poll `GET /purchaseDoc/:draftId` and finish with `POST /purchaseDoc/:draftId/confirm`.
- Purchase-doc analysis depends on external Document AI (`DOCUMENT_AI_URL`, default `http://localhost:8000`); upload defaults are 10 MB and `image/jpeg,image/png,image/webp,application/pdf`.
- Catalog search/matching logic lives in `src/services/catalog.ts` and `src/services/productAlias.ts`; the batch-search indexes are a manual mongo-shell migration in `migrations/add-batch-search-indexes.js`.

## Repo-specific gotchas
- Startup seeding needs `ADMIN_PASSWORD` and currently is not reliable on a fresh DB: `src/services/seed.ts` creates the admin role with `nickname`, but `src/models/role.ts` requires `name`. The app catches the seed error and continues, so do **not** assume admin bootstrap succeeded.
- `test/` is gitignored, but `npm test` only looks under `test/**/*.test.ts`. If you add tests there, unignore the folder or the tests will not be committed.
- `src/app.ts` starts listening immediately and does not export the Express app; adding Supertest-style tests usually requires refactoring or careful module loading.
- Backup routes shell out to `mongodump` / `mongorestore`; local testing needs MongoDB Database Tools plus `BACKUP_URI`, `USER`, and `PASS`.
- The role service file is literally `src/services/role..ts`, and controllers import it as `../services/role.`. Rename carefully.
