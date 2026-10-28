# GZ API

REST API for the Golozur ecosystem. The backend supports commercial
management for sales, purchases, products, clients, users, roles, and reports,
with MongoDB, JWT authentication, and PDF generation.

## Local development quick path

### Prerequisites

- Node.js and npm
- MongoDB running locally at `127.0.0.1:27017`

Install dependencies from this directory:

```bash
npm install
```

Create the local environment file with one of these commands:

```powershell
Copy-Item .env.example .env
```

```bash
cp .env.example .env
```

Start the API:

```bash
npm run dev
```

At startup, the base seed creates or updates the `admin` role and the four
business roles (`Propietario`, `Administración`, `Preventista`, and
`Repartidor`). It also creates the `admin` user when that user does not exist.
The seed is idempotent: restarting the API does not create duplicate roles or
reset an existing admin user's password. The local bootstrap credentials are:

```text
nickname: admin
password: 123
```

Change these credentials outside local development. The API is available at
`http://localhost:3002`. For example, log in with:

```http
POST http://localhost:3002/auth/login
Content-Type: application/json

{
  "nickname": "admin",
  "password": "123"
}
```

## Environment variables

The application reads `MONGODB_URI`, not `DB_URI`. The main local settings are:

| Variable | Purpose |
| --- | --- |
| `MONGODB_URI` | MongoDB connection URI, normally `mongodb://127.0.0.1:27017/gzapi` locally |
| `PORT` | HTTP port; the development default is `3002` |
| `JWT_SECRET` | Secret used to sign JWTs; use a strong private value outside local development |
| `ADMIN_PASSWORD` | Password used only when the base seed first creates `admin`; defaults to `123` when missing or empty |
| `DOCUMENT_AI_URL` | Optional Document AI service URL |
| `DOCUMENT_AI_TIMEOUT` | Optional Document AI request timeout |
| `DOCUMENT_AI_DEBUG` | Optional Document AI debug setting |
| `UPLOAD_MAX_SIZE` | Optional upload size limit |
| `UPLOAD_ALLOWED_MIMES` | Optional allowed upload MIME types |
| `BACKUP_URI`, `USER`, `PASS` | Optional backup and restore configuration |

The base seed creates roles and the `admin` user only. It does not create
synthetic route-plan data.

## Vercel deployment

Vercel uses `api/index.ts` as the default REST function entrypoint. It routes
the existing Express paths without adding an `/api` prefix, connects to
MongoDB, and runs the idempotent base seed during warm-instance
initialization. Configure these required environment variables in Vercel:

| Variable | Purpose |
| --- | --- |
| `MONGODB_URI` | MongoDB connection URI |
| `JWT_SECRET` | Secret used to sign JWTs |
| `ADMIN_PASSWORD` | Password used when the seed first creates `admin` |
| `GOOGLE_MAPS_SERVER_API_KEY` | Server key required by the demo seed for geocoding and Google Routes DRIVE validation |

The optional provider and integration variables are `DOCUMENT_AI_URL`,
`DOCUMENT_AI_TIMEOUT`, `DOCUMENT_AI_DEBUG`, `BACKUP_URI`, `USER`, and `PASS`.
Upload settings can also be customized with `UPLOAD_MAX_SIZE` and
`UPLOAD_ALLOWED_MIMES`. Socket.IO is not part of this Vercel deployment; REST
call sites retain a no-op compatibility event adapter.

## Phase 0 contract gate

`PHASE_0_CONTRACTS_ENABLED` is controlled by the runtime environment. It is
read at runtime, accepts only the exact string `true`, and defaults to false
when unset or set to any other value. Do not add this flag to tracked `.env`
files or commit an environment value for it.

Set the flag to `true` only in an approved intended runtime after the required
baseline, preflight, backup/restore, opening-count, reconciliation, rollback,
and owner-approval evidence has been completed and archived. This repository
does not claim that staging or production is enabled now.

## Production and build commands

```bash
npm run build  # Compile TypeScript into dist/
npm start      # Start the compiled server
npm run lint   # Run the TypeScript lint checks
npm test       # Run the Mocha test suite
```

## Stock migration commands

The six Stock migration commands below expose the existing TypeScript
entrypoints without adding arguments or bypassing their safety checks. npm
forwards operator arguments after `--`; the package scripts contain no target,
approval, proof, or credential values.

Every command requires these base arguments. Set them through the approved
operator secret mechanism; do not commit credentials or proof contents, and
remember that shell-expanded values can still be visible in process arguments:

```bash
export MONGODB_URI
export MIGRATION_ENVIRONMENT
export STOCK_APPROVAL_ID
```

### Safe dry-run templates

All six dry-run paths are non-mutating and do not connect to MongoDB. They
produce a plan or artifact and preserve the existing argument requirements:

```bash
npm run migration:stock:preflight -- \
  --dry-run --uri "$MONGODB_URI" \
  --environment "$MIGRATION_ENVIRONMENT" \
  --confirm-target "$MIGRATION_ENVIRONMENT" \
  --approval-id "$STOCK_APPROVAL_ID"

npm run migration:stock:indexes -- --dry-run --uri "$MONGODB_URI" --environment "$MIGRATION_ENVIRONMENT" --confirm-target "$MIGRATION_ENVIRONMENT" --approval-id "$STOCK_APPROVAL_ID"
npm run migration:stock:opening-template -- --dry-run --uri "$MONGODB_URI" --environment "$MIGRATION_ENVIRONMENT" --confirm-target "$MIGRATION_ENVIRONMENT" --approval-id "$STOCK_APPROVAL_ID"
npm run migration:stock:opening-count -- --dry-run --uri "$MONGODB_URI" --environment "$MIGRATION_ENVIRONMENT" --confirm-target "$MIGRATION_ENVIRONMENT" --approval-id "$STOCK_APPROVAL_ID" --input "$STOCK_OPENING_INPUT"
npm run migration:stock:repair-projections -- --dry-run --uri "$MONGODB_URI" --environment "$MIGRATION_ENVIRONMENT" --confirm-target "$MIGRATION_ENVIRONMENT" --approval-id "$STOCK_APPROVAL_ID" --input "$STOCK_REPAIR_INPUT"
npm run migration:stock:verify -- --dry-run --uri "$MONGODB_URI" --environment "$MIGRATION_ENVIRONMENT" --confirm-target "$MIGRATION_ENVIRONMENT" --approval-id "$STOCK_APPROVAL_ID"
```

Preflight, opening-template, and verification inspect or describe state; they
do not change business data. Index creation is non-mutating only with
`--dry-run`. Opening-count and projection-repair dry-runs only parse and plan
their inputs.

### Proof-gated apply templates

Only omit `--dry-run` after the required preflight and backup evidence exists.
The existing helper validates proof status, target fingerprint, artifact hash,
restore verification, and backup archive hash before mutation-capable work.
Use paths supplied by the operator environment:

```bash
npm run migration:stock:indexes -- \
  --uri "$MONGODB_URI" \
  --environment "$MIGRATION_ENVIRONMENT" \
  --confirm-target "$MIGRATION_ENVIRONMENT" \
  --approval-id "$STOCK_APPROVAL_ID" \
  --preflight-proof "$STOCK_PREFLIGHT_PROOF" \
  --backup-proof "$STOCK_BACKUP_PROOF"

npm run migration:stock:opening-count -- \
  --uri "$MONGODB_URI" \
  --environment "$MIGRATION_ENVIRONMENT" \
  --confirm-target "$MIGRATION_ENVIRONMENT" \
  --approval-id "$STOCK_APPROVAL_ID" \
  --input "$STOCK_OPENING_INPUT" \
  --preflight-proof "$STOCK_PREFLIGHT_PROOF" \
  --backup-proof "$STOCK_BACKUP_PROOF"

npm run migration:stock:repair-projections -- \
  --uri "$MONGODB_URI" \
  --environment "$MIGRATION_ENVIRONMENT" \
  --confirm-target "$MIGRATION_ENVIRONMENT" \
  --approval-id "$STOCK_APPROVAL_ID" \
  --input "$STOCK_REPAIR_INPUT" \
  --preflight-proof "$STOCK_PREFLIGHT_PROOF" \
  --backup-proof "$STOCK_BACKUP_PROOF"
```

The index, opening-count, and projection-repair apply commands can mutate
database state and fail closed when either proof argument is missing or
invalid. Live verification remains read-only, but its existing entrypoint is
also proof-gated; use the same proof arguments when running it without
`--dry-run`. JSON input approval metadata must match `--approval-id` (and
`--approved-by` when supplied).

## Route-plan test fixture seed

`npm run seed:route-plan:test` is a separate, local-only fixture command. It
uses the `test_route_plan` database and is intended for route-planning tests and
demo data, not normal application startup or production databases.

```bash
npm run seed:route-plan:test
```

The fixture seed is idempotent and only accepts a local MongoDB URI at
`localhost` or `127.0.0.1`; it rejects other databases and hosts. It creates
synthetic route data including six delivery zones, 34 clients, 34 pending
sales, catalog fixtures, a test vehicle, route configuration, and deterministic
demo snapshots. It does not replace the base seed.

Optional variables:

```bash
ROUTE_PLAN_SERVICE_DATE=2026-10-14 npm run seed:route-plan:test
ROUTE_PLAN_TEST_PASSWORD=route-plan-local-password npm run seed:route-plan:test
```

## Demo-data seed: automatic Production build and manual CLI

The `vercel-build` script always runs `npm run build`. Its demo seed defaults
to **no database or provider access**: unset `DEMO_SEED_MODE` or
`DEMO_SEED_MODE=disabled` prints `Production demo seed: skipped`, even when
`VERCEL_ENV=production` and the URI or Google key is absent. An unexpected
mode fails the Production build without connecting. Preview, local builds,
and tests always skip regardless of the mode. This is not application startup
logic. A local build with synthetic `VERCEL_ENV=production` and
`DEMO_SEED_MODE=disabled` can audit the script path without credentials; it
does **not** prove Vercel executed the hook.

Only set `DEMO_SEED_MODE=run` in Vercel Production after confirming the target
and approving writes. A complete fixture skips Google and all writes; missing
owned fixtures are geocoded and road-validated before the hook inserts only
absent records.
Existing records, including edited demo documents, are never overwritten by
the automatic path. The documented Vercel Node runtime hook is configured,
but its actual execution in a Production build has **not** been verified.

Before enabling `run`, set `MONGODB_URI`, `DEMO_SEED_EXPECTED_DATABASE`, and a
fixed `DEMO_SERVICE_DATE=YYYY-MM-DD` in Vercel Production. The expected-database
variable is **our application-level safety guard**, not a Vercel-provided
variable: its value must be the exact database name selected by the URI. Use
`test` only if the Production URI has been independently confirmed to select
that database; never infer it from a local default. `GOOGLE_MAPS_SERVER_API_KEY`
is required when any fixture is missing. The base `admin` user must already
exist; if it does not, the build fails rather than creating unrelated startup
data. Build failures abort the deployment; no secret value is printed. A missing URI never
falls back to localhost. Multiple builds use deterministic IDs and insert-only
upserts; concurrent winners are checked for namespace/key ownership. Writes
are sequential, not transactional: a failed build can leave partial demo data,
which the next Production build with the **same** service date can complete.
Do not rotate that date casually: a different month creates additional history.

`seed:demo` remains a manually-run operator command. It upserts only documents owned by the
`gzapi-demo-seed-v1` fixture namespace and never deletes unrelated data.

The seed resolves the depot and client addresses through Google Geocoding,
accepts only `ROOFTOP` or `RANGE_INTERPOLATED` results matching the requested
street, house number, and city (ignoring accents and common Spanish street
abbreviations), and validates every
depot/client pair in both directions with Google Routes `DRIVE` routing before
any dependent document is written. Route snapshots use the provider's returned
distance, duration, and encoded polyline; the seed fails closed if a provider
result is missing or not routable.

The planned fixture contains 20 clients across three zones, one pending route
sale per client, three route snapshots, 85 products, nine brands, seven
categories, six providers, and six calendar months ending at the service-date
month with 21 paid sales, seven paid purchases, and 11 dated expenses per month.
No finance event is dated after the service-date anchor. The default anchor is
today's UTC calendar date; set `DEMO_SERVICE_DATE=YYYY-MM-DD` to reproduce an
exact run. Existing fixture IDs and keys remain stable for overlapping months.
Monthly reruns never delete older months: finance records accumulate beyond six
months, so review dashboard date filters accordingly. Candidate addresses are
listed publicly at https://www.cgcetucuman.org.ar/sucursales-rapipago/ ;
their continued existence, Google geocoding precision and DRIVE connectivity
are **not** verified by `--dry-run`. Review provider results before authorizing
a real run: any unresolvable address blocks all writes.

Required environment variables for a real run are `MONGODB_URI` and
`GOOGLE_MAPS_SERVER_API_KEY`. The base startup seed must already have created
the `admin` user, which is used only as the fixture actor. `DEMO_SERVICE_DATE`
is optional and accepts a real `YYYY-MM-DD` service date.

Writes are sequential, **not atomic**. Provider checks finish before the first
write, but a database write failure can leave an incomplete owned fixture. To
recover, correct the failing condition and rerun against the same target with
the exact same `DEMO_SERVICE_DATE` (set it explicitly before the first real
run). Deterministic owned upserts fill missing records and update existing
ones without deleting or matching unrelated records. Inspect the failure and
owned fixture before rerunning; do not assume rollback. If the first run used
the default date, supply that original UTC date explicitly on the rerun.

Run the dry run first; it does not connect to MongoDB or call external
providers:

```bash
npm run seed:demo -- --dry-run
```

Dry-run reports candidate addresses only; it does not prove geocoding
precision, street-number equality, or DRIVE connectivity.

For Vercel production variables, use the exact operator pattern below. The
production dry run also requires explicit remote-target confirmation because
the target guard runs before the dry-run decision. The second command performs
the actual writes:

```bash
vercel env run -e production -- npm run seed:demo -- --dry-run --confirm-remote
vercel env run -e production -- npm run seed:demo -- --confirm-remote
```

Do not place MongoDB URIs, Google keys, or other credentials in scripts,
arguments, logs, documentation, or commits. This command is a one-off
operator action, separate from the Production build hook.

Fixture credentials:

```text
nickname: route-plan-test
password: route-plan-test-password
```

## Project information

### Main modules

- **Auth**: Login, JWT, and session verification
- **Sales**: CRUD, sale items, and individual or batch PDF printing
- **Purchases**: Purchase and purchase-item registration
- **Products**: CRUD with categories, brands, providers, and images
- **Clients**: Client management with location data
- **Users and roles**: Role permissions and authorization middleware
- **Providers, categories, brands, and cities**: Supporting catalogs
- **Logs**: Activity logging
- **Backup**: Data backup and restore
- **Dataset**: Reporting and statistics data

### Technology stack

| Category | Technology |
| --- | --- |
| Runtime | Node.js |
| Framework | Express |
| Database | MongoDB, Mongoose |
| Authentication | JWT, bcrypt |
| API transport | Express REST |
| Validation | TypeScript |
| Images | Sharp, Multer |
| PDF | PDFKit |

### Project structure

```text
src/
├── config/       # MongoDB connection
├── controllers/  # Endpoint logic
├── interfaces/   # Types and interfaces
├── middleware/   # Sessions, permissions, and uploads
├── models/       # Mongoose schemas
├── routes/       # Dynamically loaded Express routes
├── services/     # Business logic
├── socket.ts     # No-op compatibility adapter for legacy event calls
└── utils/        # JWT, bcrypt, error, and image helpers
```

## License

This project is proprietary and protected by copyright. Use, copying,
modification, or distribution without authorization is prohibited.

See [LICENSE](./LICENSE) for details.
