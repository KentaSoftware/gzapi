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

The optional provider and integration variables are `DOCUMENT_AI_URL`,
`DOCUMENT_AI_TIMEOUT`, `DOCUMENT_AI_DEBUG`, `BACKUP_URI`, `USER`, and `PASS`.
Upload settings can also be customized with `UPLOAD_MAX_SIZE` and
`UPLOAD_ALLOWED_MIMES`. Socket.IO is not part of this Vercel deployment; REST
call sites retain a no-op compatibility event adapter.

## Production and build commands

```bash
npm run build  # Compile TypeScript into dist/
npm start      # Start the compiled server
npm run lint   # Run the TypeScript lint checks
npm test       # Run the Mocha test suite
```

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
