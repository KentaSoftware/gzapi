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

Both the server (`npm run dev`, or `npm run build` then `npm start`) and the
serverless handler initialize the named unique sparse `routeplans.reservedSaleIds`
index after connecting and before seeding or serving requests. Initialization
fails closed on conflicting indexes, duplicate indexed values, unsupported
collection options, or an unverifiable catalog. It never drops indexes or
rewrites documents. Startup requires permission to inspect and create indexes.

**Production rollout:** Creating the index is not a historical-data audit.
Sparse indexes exclude old snapshots without `reservedSaleIds`, and cannot
prevent legacy or raw writers from omitting it. Before deploying, back up and
audit existing route snapshots and duplicate assignments, reconcile problems
under an approved procedure, and quiesce old/raw writers during and after the
cutover. Inspect null, empty, malformed or mismatched reservation fields as well
as index and collection options. Do not automatically backfill or delete data
to resolve failures. Index builds can affect availability and need an approved
maintenance plan; test against a representative copy first.

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

The startup seed also initializes the independent demo fixtures described below.

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

## Demo-data seed at startup

After base roles, simulation and admin initialization, startup inserts missing
independent demo fixtures: seven categories, nine brands, six providers, three
delivery zones, one vehicle, one depot routing configuration, and one cashflow
configuration. The simulation demo is one document in `simulationdemofixtures`
with embedded routes, catalog and scenarios.

Startup does not seed demo clients, products, sales, purchases, expenses, route
plans, their item records or product inventory fixtures. It does not delete
previously seeded records; existing data remains in the database. No Google
provider calls are needed to prepare the retained fixtures.

Inventory checks deterministic IDs and ownership before insert-only repair;
existing owned records are not overwritten, and identity collisions fail closed.
Reads and writes are bounded to 16 and eight concurrent operations respectively.
Writes are not transactional, so a failed initialization may leave partial fixtures
and a subsequent startup can retry. Vercel returns a generic initialization error
and retries on a later request. Simulation demo requests do not seed fixtures.

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
