import express, { type Request, type Response, type NextFunction } from 'express'
import { expect } from 'chai'
import proxyquire from 'proxyquire'
import request from 'supertest'
import {
  assignmentCollectionAdapter,
  type AssignmentCollection,
  type IndexDescription,
  type Snapshot,
  migrateAssignmentIndex
} from '../../migrations/route-plan-005-assignment-index'
import {
  createRouteAssignmentMigrationService,
  RouteAssignmentMigrationSafetyError
} from '../../src/services/routeAssignmentMigration'
import { sendErrorEnvelope } from '../../src/utils/error.handle'

const CONFIRMATION = 'CREATE_ROUTE_ASSIGNMENT_INDEX_ON_LOCAL_TEST'
const SALE_ID = '507f1f77bcf86cd799439011'

interface HarnessOptions {
  environment?: string
  host?: string
  database?: string
  snapshots?: Snapshot[]
}

const createHarness = (options: HarnessOptions = {}): {
  app: express.Express
  migrationCalls: boolean[]
  indexWrites: number[]
} => {
  const indexes: IndexDescription[] = []
  const indexWrites: number[] = []
  const migrationCalls: boolean[] = []
  const snapshots = options.snapshots ?? [{
    _id: 'snapshot-1',
    selectedSaleIds: [SALE_ID],
    stops: [{ saleId: SALE_ID }]
  }]
  const collection: AssignmentCollection = {
    find: () => ({
      async * [Symbol.asyncIterator] (): AsyncIterator<Snapshot> {
        for (const snapshot of snapshots) yield snapshot
      }
    }),
    listIndexes: () => ({ toArray: async () => indexes }),
    options: async () => ({}),
    createIndex: async (key, indexOptions) => {
      indexWrites.push(1)
      indexes.push({ key, ...indexOptions })
      return indexOptions.name
    }
  }
  const service = createRouteAssignmentMigrationService({
    getEnvironment: () => options.environment ?? 'test',
    getConnection: () => ({
      readyState: 1,
      host: options.host ?? '127.0.0.1',
      name: options.database ?? 'test'
    }),
    createAdapter: () => assignmentCollectionAdapter(collection),
    migrate: async (adapter, apply) => {
      migrationCalls.push(apply)
      return await migrateAssignmentIndex(adapter, apply)
    }
  })

  const controller = proxyquire('../../src/controllers/routePlan', {
    '../services/routeAssignmentMigration': {
      preflightAssignmentIndex: service.preflight,
      applyAssignmentIndex: service.apply,
      ROUTE_ASSIGNMENT_INDEX_CONFIRMATION: CONFIRMATION,
      RouteAssignmentMigrationSafetyError,
      '@noCallThru': true
    }
  }) as typeof import('../../src/controllers/routePlan')

  const checkJwt = (req: Request, res: Response, next: NextFunction): void => {
    if (req.headers.authorization !== 'Bearer test-token') {
      sendErrorEnvelope(res, 401, 'AUTHENTICATION_INVALID', 'Authentication credentials are invalid')
      return
    }
    ;(req as Request & { user?: { id: string, role: { name: string } } }).user = { id: 'user-1', role: { name: 'admin' } }
    next()
  }
  const checkPermission = (_permission: string, _options?: { currentRole?: boolean }) => (req: Request, res: Response, next: NextFunction): void => {
    res.locals.userId = (req as Request & { user?: { id: string } }).user?.id
    res.locals.authorizationRole = req.headers['x-test-current-role'] ?? 'admin'
    next()
  }
  const { router } = proxyquire('../../src/routes/routePlan', {
    '../controllers/routePlan': controller,
    '../middleware/session': { checkJwt, '@noCallThru': true },
    '../middleware/checkPermission': { checkPermission, '@noCallThru': true }
  }) as typeof import('../../src/routes/routePlan')

  const app = express()
  app.use(express.json())
  app.use('/routePlan', router)
  return { app, migrationCalls, indexWrites }
}

describe('route assignment index migration HTTP endpoints', () => {
  const applyPath = '/routePlan/assignment-index/apply'
  const preflightPath = '/routePlan/assignment-index/preflight'

  const authorized = (app: express.Express, path: string, body: unknown): request.Test =>
    request(app).post(path).set('Authorization', 'Bearer test-token').send(body)

  it('rejects unauthenticated requests before invoking the migration', async () => {
    const { app, migrationCalls } = createHarness()
    const response = await request(app).post(preflightPath).send({ apply: false })
    expect(response.status).to.equal(401)
    expect(migrationCalls).to.deep.equal([])
  })

  it('requires the current database-backed role to be exactly admin', async () => {
    const { app, migrationCalls } = createHarness()
    const response = await authorized(app, preflightPath, { apply: false })
      .set('x-test-current-role', 'Propietario')
    expect(response.status).to.equal(403)
    expect(migrationCalls).to.deep.equal([])
  })

  it('rejects production before invoking the migration', async () => {
    const { app, migrationCalls } = createHarness({ environment: 'production' })
    const response = await authorized(app, preflightPath, { apply: false })
    expect(response.status).to.equal(403)
    expect(migrationCalls).to.deep.equal([])
  })

  it('rejects non-loopback hosts before invoking the migration', async () => {
    const { app, migrationCalls } = createHarness({ host: 'localhost.example' })
    const response = await authorized(app, applyPath, { confirmation: CONFIRMATION })
    expect(response.status).to.equal(403)
    expect(migrationCalls).to.deep.equal([])
  })

  it('rejects databases other than test before invoking the migration', async () => {
    const { app, migrationCalls } = createHarness({ database: 'production' })
    const response = await authorized(app, applyPath, { confirmation: CONFIRMATION })
    expect(response.status).to.equal(403)
    expect(migrationCalls).to.deep.equal([])
  })

  it('rejects malformed apply confirmations before invoking the migration', async () => {
    const { app, migrationCalls } = createHarness()
    const invalidBodies = [
      { confirmation: 'CREATE_INDEX' },
      { confirmation: CONFIRMATION, apply: true },
      { confirmation: CONFIRMATION, extra: 'not-allowed' }
    ]
    for (const body of invalidBodies) {
      const response = await authorized(app, applyPath, body)
      expect(response.status).to.equal(400)
    }
    expect(migrationCalls).to.deep.equal([])
  })

  it('runs preflight without applying or writing the index', async () => {
    const { app, migrationCalls, indexWrites } = createHarness()
    const response = await authorized(app, preflightPath, { apply: false })
    expect(response.status).to.equal(200)
    expect(response.body.status).to.equal('preview')
    expect(migrationCalls).to.deep.equal([false])
    expect(indexWrites).to.deep.equal([])
  })

  it('applies a clean migration only after exact confirmation and verifies its index', async () => {
    const { app, migrationCalls, indexWrites } = createHarness()
    const response = await authorized(app, applyPath, { confirmation: CONFIRMATION })
    expect(response.status).to.equal(200)
    expect(response.body.status).to.equal('created')
    expect(migrationCalls).to.deep.equal([true])
    expect(indexWrites).to.deep.equal([1])
  })

  it('blocks malformed historical snapshots without creating an index', async () => {
    const { app, migrationCalls, indexWrites } = createHarness({
      snapshots: [{ _id: 'malformed', selectedSaleIds: ['not-an-object-id'], stops: [] }]
    })
    const response = await authorized(app, applyPath, { confirmation: CONFIRMATION })
    expect(response.status).to.equal(409)
    expect(response.body.status).to.equal('blocked')
    expect(migrationCalls).to.deep.equal([true])
    expect(indexWrites).to.deep.equal([])
  })
})
