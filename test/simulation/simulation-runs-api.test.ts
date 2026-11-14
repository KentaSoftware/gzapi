import { expect } from 'chai'
import type { Express, RequestHandler } from 'express'
import request from 'supertest'

import { createApp } from '../../src/app'
import { readSimulationConfig } from '../../src/config/simulation'
import {
  SIMULATION_ERROR_CODES,
  SIMULATION_RECORD_STATUSES
} from '../../src/interfaces/simulation.interface'
import {
  SimulationRunRepositoryError,
  createSimulationRunMongoRepository,
  type SimulationRunMongoDriver,
  type SimulationRunRecord,
  type SimulationRunRepository
} from '../../src/services/simulationRunRepository'
import type { SimulationServiceDependencies } from '../../src/services/simulation'
import { sendErrorEnvelope } from '../../src/utils/error.handle'
import {
  BASE_HASH,
  CAPTURED_AT,
  ROUTE_ID,
  USER_ID,
  validCalculation,
  validRouteSnapshot,
  validStockSnapshot,
  validVariant
} from './fixtures'

const AUTH_HEADER = 'Bearer simulation-runs-api-token'
const RUN_ID = '507f1f77bcf86cd799439016'
const ARCHIVED_AT = '2026-11-02T10:00:00.000Z'

const clone = <T>(value: T): T => structuredClone(value)

const runRecord = (overrides: Partial<SimulationRunRecord> = {}): SimulationRunRecord => ({
  _id: RUN_ID,
  status: SIMULATION_RECORD_STATUSES.ACTIVE,
  createdBy: USER_ID,
  sourceRouteId: ROUTE_ID,
  routeSnapshot: clone(validRouteSnapshot),
  stockSnapshot: clone(validStockSnapshot),
  baseScenarioHash: BASE_HASH,
  variant: clone(validVariant),
  calculation: clone(validCalculation),
  versions: {
    rulesVersion: 'simulation-rules-v1',
    configurationVersion: 'config-1',
    routeContractVersion: validRouteSnapshot.contractVersion,
    stockContractVersion: validStockSnapshot.contractVersion,
    calculatedAt: new Date(CAPTURED_AT),
    correlationId: 'correlation-1'
  },
  createdAt: new Date(CAPTURED_AT),
  updatedAt: new Date(CAPTURED_AT),
  ...overrides
})

const notFound = (): SimulationRunRepositoryError =>
  new SimulationRunRepositoryError(SIMULATION_ERROR_CODES.RUN_NOT_FOUND, 'Simulation run was not found')

const transitionInvalid = (): SimulationRunRepositoryError =>
  new SimulationRunRepositoryError(
    SIMULATION_ERROR_CODES.RUN_TRANSITION_INVALID,
    'Simulation run transition is invalid'
  )

class FakeRunRepository implements SimulationRunRepository {
  readonly records = new Map<string, SimulationRunRecord>()
  readonly calls: string[] = []
  failure?: SimulationRunRepositoryError

  constructor (records: SimulationRunRecord[] = []) {
    for (const record of records) this.records.set(record._id, clone(record))
  }

  async findById (id: string): Promise<SimulationRunRecord> {
    this.calls.push(`findById:${id}`)
    this.throwIfFailed()
    const record = this.records.get(id)
    if (record === undefined) throw notFound()
    return clone(record)
  }

  async archive (id: string, actorId: string): Promise<SimulationRunRecord> {
    this.calls.push(`archive:${id}:${actorId}`)
    this.throwIfFailed()
    const record = this.records.get(id)
    if (record === undefined) throw notFound()
    if (record.status !== SIMULATION_RECORD_STATUSES.ACTIVE) throw transitionInvalid()
    const archived: SimulationRunRecord = {
      ...record,
      status: SIMULATION_RECORD_STATUSES.ARCHIVED,
      archivedAt: new Date(ARCHIVED_AT),
      archivedBy: actorId,
      updatedAt: new Date(ARCHIVED_AT)
    }
    this.records.set(id, archived)
    return clone(archived)
  }

  async restore (id: string, actorId: string): Promise<SimulationRunRecord> {
    this.calls.push(`restore:${id}:${actorId}`)
    this.throwIfFailed()
    const record = this.records.get(id)
    if (record === undefined) throw notFound()
    if (record.status !== SIMULATION_RECORD_STATUSES.ARCHIVED) throw transitionInvalid()
    const { archivedAt: _archivedAt, archivedBy: _archivedBy, ...rest } = record
    const restored: SimulationRunRecord = {
      ...rest,
      status: SIMULATION_RECORD_STATUSES.ACTIVE,
      updatedAt: new Date(ARCHIVED_AT)
    }
    this.records.set(id, restored)
    return clone(restored)
  }

  private throwIfFailed (): void {
    if (this.failure !== undefined) throw this.failure
  }
}

class InMemoryRunDriver implements SimulationRunMongoDriver {
  readonly records = new Map<string, unknown>()
  readonly updates: Array<{
    filter: { _id: string, status: string }
    update: {
      $set?: Record<string, unknown>
      $unset?: Record<string, unknown>
    }
  }> = []

  failure?: Error

  async findById (id: string): Promise<unknown | null> {
    if (this.failure !== undefined) throw this.failure
    return this.records.get(id) ?? null
  }

  async findOneAndUpdate (
    filter: { _id: string, status: string },
    update: { $set?: Record<string, unknown>, $unset?: Record<string, unknown> }
  ): Promise<unknown | null> {
    this.updates.push({ filter: clone(filter), update: clone(update) })
    if (this.failure !== undefined) throw this.failure
    const record = this.records.get(filter._id)
    if (record === undefined || typeof record !== 'object' || record === null) return null
    const current = record as Record<string, unknown>
    if (current.status !== filter.status) return null
    const next = { ...current, ...(update.$set ?? {}) }
    for (const path of Object.keys(update.$unset ?? {})) Reflect.deleteProperty(next, path)
    this.records.set(filter._id, next)
    return next
  }
}

const service: SimulationServiceDependencies = {
  loadSnapshots: async () => { throw new Error('Snapshot loading is not part of this contract') },
  issueBaseScenarioToken: async () => { throw new Error('Token issuance is not part of this contract') },
  verifyBaseScenarioToken: async () => { throw new Error('Token verification is not part of this contract') }
}

const requestedPermissions: string[] = []

const checkJwt: RequestHandler = (req, res, next) => {
  if (req.headers.authorization !== AUTH_HEADER) {
    sendErrorEnvelope(res, 401, 'AUTHENTICATION_INVALID', 'Authentication credentials are invalid')
    return
  }
  res.locals.userId = USER_ID
  next()
}

const checkPermission = (action: string): RequestHandler => (req, res, next) => {
  requestedPermissions.push(action)
  if (req.headers['x-test-permission'] === 'deny') {
    sendErrorEnvelope(res, 403, 'PERMISSION_DENIED', 'Permission is denied')
    return
  }
  next()
}

const expectFrozenEvidenceUnchanged = (body: Record<string, unknown>, record: SimulationRunRecord): void => {
  expect(body.routeSnapshot).to.deep.equal(JSON.parse(JSON.stringify(record.routeSnapshot)))
  expect(body.stockSnapshot).to.deep.equal(JSON.parse(JSON.stringify(record.stockSnapshot)))
  expect(body.variant).to.deep.equal(JSON.parse(JSON.stringify(record.variant)))
  expect(body.calculation).to.deep.equal(JSON.parse(JSON.stringify(record.calculation)))
  expect(body.versions).to.deep.equal(JSON.parse(JSON.stringify(record.versions)))
  expect(body.baseScenarioHash).to.equal(record.baseScenarioHash)
}

describe('Simulation runs API', () => {
  let app: Express

  before(async () => {
    app = await createApp()
  })

  afterEach(() => {
    requestedPermissions.length = 0
  })

  const configure = (options: {
    repository?: FakeRunRepository
  } = {}): FakeRunRepository => {
    const runRepository = options.repository ?? new FakeRunRepository()
    app.locals.simulationRouteDependencies = {
      checkJwt,
      checkPermission,
      getConfig: () => readSimulationConfig({ SIMULATION_ENABLED: 'false' }),
      service,
      runRepository
    }
    return runRepository
  }

  const authenticatedGet = (path: string, headers: Record<string, string> = {}): request.Test => {
    let test = request(app).get(path).set('Authorization', AUTH_HEADER)
    for (const [key, value] of Object.entries(headers)) test = test.set(key, value)
    return test
  }

  const authenticatedPost = (path: string, headers: Record<string, string> = {}): request.Test => {
    let test = request(app).post(path).set('Authorization', AUTH_HEADER)
    for (const [key, value] of Object.entries(headers)) test = test.set(key, value)
    return test
  }

  describe('GET /simulation/runs/:id', () => {
    it('S-04: returns the stored immutable run without recalculating it', async () => {
      const record = runRecord()
      const repository = configure({ repository: new FakeRunRepository([record]) })

      const response = await authenticatedGet(`/simulation/runs/${RUN_ID}`)

      expect(response.status).to.equal(200)
      expect(response.body).to.deep.equal(JSON.parse(JSON.stringify(record)))
      expect(repository.calls).to.deep.equal([`findById:${RUN_ID}`])
      expect(requestedPermissions).to.deep.equal(['simulation:read'])
    })

    it('returns a run when the retired flag is false', async () => {
      configure({ repository: new FakeRunRepository([runRecord()]) })

      const response = await authenticatedGet(`/simulation/runs/${RUN_ID}`, {
        'x-correlation-id': 'corr-run-detail-flag'
      })

      expect(response.status).to.equal(200)
      expect(response.body._id).to.equal(RUN_ID)
      expect(response.headers['x-correlation-id']).to.equal('corr-run-detail-flag')
    })

    it('returns 401 when authentication is missing', async () => {
      configure()

      const response = await request(app).get(`/simulation/runs/${RUN_ID}`)

      expect(response.status).to.equal(401)
      expect(response.body.code).to.equal('AUTHENTICATION_INVALID')
      expect(requestedPermissions).to.deep.equal([])
    })

    it('returns 403 when the actor lacks simulation:read', async () => {
      configure()

      const response = await authenticatedGet(`/simulation/runs/${RUN_ID}`, {
        'x-test-permission': 'deny',
        'x-correlation-id': 'corr-run-detail-permission'
      })

      expect(response.status).to.equal(403)
      expect(response.body).to.deep.equal({
        code: 'PERMISSION_DENIED',
        message: 'Permission is denied',
        correlationId: 'corr-run-detail-permission'
      })
    })

    it('returns 404 with the correlation id when the run does not exist', async () => {
      configure()

      const response = await authenticatedGet(`/simulation/runs/${RUN_ID}`, {
        'x-correlation-id': 'corr-run-detail-missing'
      })

      expect(response.status).to.equal(404)
      expect(response.body).to.deep.equal({
        code: SIMULATION_ERROR_CODES.RUN_NOT_FOUND,
        message: 'Simulation run was not found',
        correlationId: 'corr-run-detail-missing'
      })
    })
  })

  describe('POST /simulation/runs/:id/archive', () => {
    it('S-14: archives an active run and preserves its frozen evidence', async () => {
      const record = runRecord()
      const repository = configure({ repository: new FakeRunRepository([record]) })

      const response = await authenticatedPost(`/simulation/runs/${RUN_ID}/archive`)

      expect(response.status).to.equal(200)
      expect(response.body.status).to.equal(SIMULATION_RECORD_STATUSES.ARCHIVED)
      expect(response.body.archivedBy).to.equal(USER_ID)
      expect(response.body.archivedAt).to.equal(ARCHIVED_AT)
      expectFrozenEvidenceUnchanged(response.body, record)
      expect(repository.calls).to.deep.equal([`archive:${RUN_ID}:${USER_ID}`])
      expect(requestedPermissions).to.deep.equal(['simulation:write'])
      expect(repository.records.get(RUN_ID)?.status).to.equal(SIMULATION_RECORD_STATUSES.ARCHIVED)
    })

    it('returns 409 SIMULATION_RUN_TRANSITION_INVALID for an archived run', async () => {
      const record = runRecord({ status: SIMULATION_RECORD_STATUSES.ARCHIVED, archivedAt: new Date(ARCHIVED_AT), archivedBy: USER_ID })
      configure({ repository: new FakeRunRepository([record]) })

      const response = await authenticatedPost(`/simulation/runs/${RUN_ID}/archive`, {
        'x-correlation-id': 'corr-run-archive-transition'
      })

      expect(response.status).to.equal(409)
      expect(response.body).to.deep.equal({
        code: SIMULATION_ERROR_CODES.RUN_TRANSITION_INVALID,
        message: 'Simulation run transition is invalid',
        correlationId: 'corr-run-archive-transition'
      })
    })

    it('returns 409 SIMULATION_EVIDENCE_IMMUTABLE when frozen evidence mutation is rejected', async () => {
      const repository = configure({ repository: new FakeRunRepository([runRecord()]) })
      repository.failure = new SimulationRunRepositoryError(
        SIMULATION_ERROR_CODES.EVIDENCE_IMMUTABLE,
        'Simulation run evidence is immutable'
      )

      const response = await authenticatedPost(`/simulation/runs/${RUN_ID}/archive`, {
        'x-correlation-id': 'corr-run-archive-immutable'
      })

      expect(response.status).to.equal(409)
      expect(response.body).to.deep.equal({
        code: SIMULATION_ERROR_CODES.EVIDENCE_IMMUTABLE,
        message: 'Simulation run evidence is immutable',
        correlationId: 'corr-run-archive-immutable'
      })
    })

    it('returns 503 SIMULATION_REPOSITORY_ERROR when the repository fails', async () => {
      const repository = configure({ repository: new FakeRunRepository([runRecord()]) })
      repository.failure = new SimulationRunRepositoryError(
        SIMULATION_ERROR_CODES.REPOSITORY_ERROR,
        'Simulation run repository is unavailable'
      )

      const response = await authenticatedPost(`/simulation/runs/${RUN_ID}/archive`, {
        'x-correlation-id': 'corr-run-archive-repository'
      })

      expect(response.status).to.equal(503)
      expect(response.body).to.deep.equal({
        code: SIMULATION_ERROR_CODES.REPOSITORY_ERROR,
        message: 'Simulation run repository is unavailable',
        correlationId: 'corr-run-archive-repository'
      })
    })

    it('returns 403 when the actor lacks simulation:write', async () => {
      configure()

      const response = await authenticatedPost(`/simulation/runs/${RUN_ID}/archive`, {
        'x-test-permission': 'deny'
      })

      expect(response.status).to.equal(403)
      expect(response.body.code).to.equal('PERMISSION_DENIED')
    })
  })

  describe('POST /simulation/runs/:id/restore', () => {
    it('S-14: restores an archived run without altering its frozen evidence', async () => {
      const record = runRecord({
        status: SIMULATION_RECORD_STATUSES.ARCHIVED,
        archivedAt: new Date(ARCHIVED_AT),
        archivedBy: USER_ID
      })
      const repository = configure({ repository: new FakeRunRepository([record]) })

      const response = await authenticatedPost(`/simulation/runs/${RUN_ID}/restore`)

      expect(response.status).to.equal(200)
      expect(response.body.status).to.equal(SIMULATION_RECORD_STATUSES.ACTIVE)
      expect(response.body.archivedAt).to.equal(undefined)
      expect(response.body.archivedBy).to.equal(undefined)
      expectFrozenEvidenceUnchanged(response.body, record)
      expect(repository.calls).to.deep.equal([`restore:${RUN_ID}:${USER_ID}`])
      expect(requestedPermissions).to.deep.equal(['simulation:write'])
    })

    it('returns 409 SIMULATION_RUN_TRANSITION_INVALID for an active run', async () => {
      configure({ repository: new FakeRunRepository([runRecord()]) })

      const response = await authenticatedPost(`/simulation/runs/${RUN_ID}/restore`, {
        'x-correlation-id': 'corr-run-restore-transition'
      })

      expect(response.status).to.equal(409)
      expect(response.body.code).to.equal(SIMULATION_ERROR_CODES.RUN_TRANSITION_INVALID)
      expect(response.body.correlationId).to.equal('corr-run-restore-transition')
    })

    it('returns 404 when the run does not exist', async () => {
      configure()

      const response = await authenticatedPost(`/simulation/runs/${RUN_ID}/restore`)

      expect(response.status).to.equal(404)
      expect(response.body.code).to.equal(SIMULATION_ERROR_CODES.RUN_NOT_FOUND)
    })
  })
})

describe('Simulation runs repository', () => {
  const driverRecord = (overrides: Partial<SimulationRunRecord> = {}): Record<string, unknown> => ({
    ...runRecord(overrides),
    __v: 0
  })

  it('TC-012: projects stored Mongo bookkeeping back to the declared run record', async () => {
    const driver = new InMemoryRunDriver()
    driver.records.set(RUN_ID, driverRecord())
    const repository = createSimulationRunMongoRepository(driver)

    const found = await repository.findById(RUN_ID)

    expect(found).to.deep.equal(runRecord())
    expect(found).to.not.have.property('__v')
  })

  it('FR-043: archives only an active run and records the lifecycle actor and timestamp', async () => {
    const driver = new InMemoryRunDriver()
    driver.records.set(RUN_ID, driverRecord())
    const repository = createSimulationRunMongoRepository(driver, {
      clock: () => new Date(ARCHIVED_AT)
    })

    const archived = await repository.archive(RUN_ID, USER_ID)

    expect(archived.status).to.equal(SIMULATION_RECORD_STATUSES.ARCHIVED)
    expect(archived.archivedBy).to.equal(USER_ID)
    expect(archived.archivedAt).to.deep.equal(new Date(ARCHIVED_AT))
    expect(driver.updates).to.have.length(1)
    expect(driver.updates[0].filter).to.deep.equal({ _id: RUN_ID, status: SIMULATION_RECORD_STATUSES.ACTIVE })
    expect(driver.updates[0].update.$set).to.deep.equal({
      status: SIMULATION_RECORD_STATUSES.ARCHIVED,
      archivedAt: new Date(ARCHIVED_AT),
      archivedBy: USER_ID
    })
    expect(driver.updates[0].update.$unset).to.equal(undefined)
  })

  it('FR-044: restores only an archived run and clears only lifecycle archive fields', async () => {
    const driver = new InMemoryRunDriver()
    driver.records.set(RUN_ID, driverRecord({
      status: SIMULATION_RECORD_STATUSES.ARCHIVED,
      archivedAt: new Date(ARCHIVED_AT),
      archivedBy: USER_ID
    }))
    const repository = createSimulationRunMongoRepository(driver, {
      clock: () => new Date(ARCHIVED_AT)
    })

    const restored = await repository.restore(RUN_ID, USER_ID)

    expect(restored.status).to.equal(SIMULATION_RECORD_STATUSES.ACTIVE)
    expect(restored.archivedAt).to.equal(undefined)
    expect(restored.archivedBy).to.equal(undefined)
    expect(driver.updates[0].filter).to.deep.equal({ _id: RUN_ID, status: SIMULATION_RECORD_STATUSES.ARCHIVED })
    expect(driver.updates[0].update.$set).to.deep.equal({ status: SIMULATION_RECORD_STATUSES.ACTIVE })
    expect(driver.updates[0].update.$unset).to.deep.equal({ archivedAt: '', archivedBy: '' })
  })

  it('returns typed not-found and illegal-transition errors without touching other runs', async () => {
    const driver = new InMemoryRunDriver()
    const repository = createSimulationRunMongoRepository(driver)
    const archivedRecord = driverRecord({
      status: SIMULATION_RECORD_STATUSES.ARCHIVED,
      archivedAt: new Date(ARCHIVED_AT),
      archivedBy: USER_ID
    })
    driver.records.set(RUN_ID, archivedRecord)

    let missing: unknown
    try {
      await repository.findById('507f1f77bcf86cd799439099')
    } catch (error) {
      missing = error
    }
    expect(missing).to.be.instanceOf(SimulationRunRepositoryError)
    expect((missing as SimulationRunRepositoryError).code).to.equal(SIMULATION_ERROR_CODES.RUN_NOT_FOUND)

    let illegal: unknown
    try {
      await repository.archive(RUN_ID, USER_ID)
    } catch (error) {
      illegal = error
    }
    expect(illegal).to.be.instanceOf(SimulationRunRepositoryError)
    expect((illegal as SimulationRunRepositoryError).code).to.equal(SIMULATION_ERROR_CODES.RUN_TRANSITION_INVALID)
    expect(driver.records.get(RUN_ID)).to.deep.equal(archivedRecord)
  })

  it('rejects a malformed run id as not found before any driver lookup', async () => {
    const driver = new InMemoryRunDriver()
    const repository = createSimulationRunMongoRepository(driver)

    let failure: unknown
    try {
      await repository.findById('not-a-run-id')
    } catch (error) {
      failure = error
    }

    expect(failure).to.be.instanceOf(SimulationRunRepositoryError)
    expect((failure as SimulationRunRepositoryError).code).to.equal(SIMULATION_ERROR_CODES.RUN_NOT_FOUND)
    expect(driver.updates).to.have.length(0)
  })

  it('maps model evidence guards to SIMULATION_EVIDENCE_IMMUTABLE', async () => {
    const driver = new InMemoryRunDriver()
    driver.records.set(RUN_ID, driverRecord())
    driver.failure = new Error('Simulation run evidence is immutable')
    const repository = createSimulationRunMongoRepository(driver)

    let failure: unknown
    try {
      await repository.archive(RUN_ID, USER_ID)
    } catch (error) {
      failure = error
    }

    expect(failure).to.be.instanceOf(SimulationRunRepositoryError)
    expect((failure as SimulationRunRepositoryError).code).to.equal(SIMULATION_ERROR_CODES.EVIDENCE_IMMUTABLE)
  })

  it('maps unexpected driver failures to SIMULATION_REPOSITORY_ERROR', async () => {
    const driver = new InMemoryRunDriver()
    driver.failure = new Error('connection lost')
    const repository = createSimulationRunMongoRepository(driver)

    let failure: unknown
    try {
      await repository.findById(RUN_ID)
    } catch (error) {
      failure = error
    }

    expect(failure).to.be.instanceOf(SimulationRunRepositoryError)
    expect((failure as SimulationRunRepositoryError).code).to.equal(SIMULATION_ERROR_CODES.REPOSITORY_ERROR)
  })
})
