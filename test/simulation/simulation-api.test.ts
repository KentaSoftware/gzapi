import { expect } from 'chai'
import type { Express, RequestHandler } from 'express'
import sinon from 'sinon'
import request from 'supertest'

import { createApp } from '../../src/app'
import type { SimulationConfiguration } from '../../src/config/simulation'
import {
  SIMULATION_DATA_QUALITY,
  SIMULATION_ERROR_CODES,
  SIMULATION_RULES_PROVISIONAL_V1,
  type SimulationSnapshotHandleVersions
} from '../../src/interfaces/simulation.interface'
import {
  SimulationServiceError,
  calculateBaseScenarioHash,
  type SimulationServiceDependencies
} from '../../src/services/simulation'
import { SimulationSnapshotError } from '../../src/services/simulationSnapshotAdapter'
import { SimulationTokenError } from '../../src/services/simulationToken'
import { sendErrorEnvelope } from '../../src/utils/error.handle'
import {
  PRODUCT_ID,
  ROUTE_ID,
  USER_ID,
  validRouteSnapshot,
  validStockSnapshot
} from './fixtures'

const AUTH_HEADER = 'Bearer simulation-api-token'
const ISSUED_TOKEN = `sim2.${'a'.repeat(43)}.${'b'.repeat(43)}`
const FIXED_CLOCK = '2026-11-02T12:00:00.000Z'

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

const versions: SimulationSnapshotHandleVersions = {
  routeContractVersion: validRouteSnapshot.contractVersion,
  stockContractVersion: validStockSnapshot.contractVersion,
  rulesVersion: SIMULATION_RULES_PROVISIONAL_V1
}

const snapshots = (): { routeSnapshot: typeof validRouteSnapshot, stockSnapshot: typeof validStockSnapshot } => ({
  routeSnapshot: clone(validRouteSnapshot),
  stockSnapshot: clone(validStockSnapshot)
})

const validatedBaseScenario = (): {
  routeSnapshot: typeof validRouteSnapshot
  stockSnapshot: typeof validStockSnapshot
  versions: SimulationSnapshotHandleVersions
  baseScenarioHash: string
} => {
  const frozen = snapshots()
  return {
    ...frozen,
    versions,
    baseScenarioHash: calculateBaseScenarioHash({ ...frozen, versions })
  }
}

const serviceDependencies = (
  overrides: Partial<SimulationServiceDependencies> = {}
): SimulationServiceDependencies => ({
  loadSnapshots: async () => snapshots(),
  issueBaseScenarioToken: async () => ISSUED_TOKEN,
  verifyBaseScenarioToken: async () => validatedBaseScenario(),
  calculationParameters: {
    fuelPriceArsPerLiter: 100,
    durationCostArsPerHour: 100,
    distanceCostArsPerKm: 10
  },
  clock: () => new Date(FIXED_CLOCK),
  ...overrides
})

const simulationConfig = (enabled = true): SimulationConfiguration => ({
  enabled,
  routeContractAllowlist: [validRouteSnapshot.contractVersion],
  stockContractAllowlist: [validStockSnapshot.contractVersion]
})

const checkJwt: RequestHandler = (req, res, next) => {
  if (req.headers.authorization !== AUTH_HEADER) {
    sendErrorEnvelope(res, 401, 'AUTHENTICATION_INVALID', 'Authentication credentials are invalid')
    return
  }
  res.locals.userId = USER_ID
  next()
}

const checkPermission = (action: string): RequestHandler => (req, res, next) => {
  if (action !== 'simulation:write') {
    sendErrorEnvelope(res, 403, 'PERMISSION_DENIED', 'Permission is denied')
    return
  }
  if (req.headers['x-test-permission'] === 'deny') {
    sendErrorEnvelope(res, 403, 'PERMISSION_DENIED', 'Permission is denied')
    return
  }
  next()
}

const validVariant = (): {
  name: string
  overrides: Array<{ key: string, value: number }>
  directLoad: Array<{ productId: string, quantity: number, projectedSalesQuantity: number }>
} => ({
  name: 'Optimized',
  overrides: [],
  directLoad: [{
    productId: PRODUCT_ID,
    quantity: 20,
    projectedSalesQuantity: 20
  }]
})

describe('Simulation API', () => {
  let app: Express

  before(async () => {
    app = await createApp()
  })

  afterEach(() => {
    sinon.restore()
  })

  const configure = (options: {
    enabled?: boolean
    service?: Partial<SimulationServiceDependencies>
    getConfig?: () => SimulationConfiguration
  } = {}): void => {
    app.locals.simulationRouteDependencies = {
      checkJwt,
      checkPermission,
      getConfig: options.getConfig ?? (() => simulationConfig(options.enabled ?? true)),
      service: serviceDependencies(options.service)
    }
  }

  const post = (
    path: string,
    body: object,
    headers: Record<string, string> = {}
  ): request.Test => {
    let test = request(app).post(path).set('Authorization', AUTH_HEADER)
    for (const [key, value] of Object.entries(headers)) test = test.set(key, value)
    return test.send(body)
  }

  describe('POST /simulation/base-scenarios', () => {
    it('S-01: creates a base scenario and binds the token to the authenticated actor', async () => {
      const loadSnapshots = sinon.stub().resolves(snapshots())
      const issueBaseScenarioToken = sinon.stub().resolves(ISSUED_TOKEN)
      configure({ service: { loadSnapshots, issueBaseScenarioToken } })

      const response = await post('/simulation/base-scenarios', { routeId: ROUTE_ID })

      expect(response.status).to.equal(200)
      expect(response.body.dataQuality).to.equal(SIMULATION_DATA_QUALITY.COMPLETE)
      expect(response.body.token).to.equal(ISSUED_TOKEN)
      expect(response.body.baseScenarioHash).to.equal(validatedBaseScenario().baseScenarioHash)
      expect(response.body.versions).to.deep.equal(versions)
      expect(loadSnapshots.calledOnceWith({ routeId: ROUTE_ID })).to.equal(true)
      expect(issueBaseScenarioToken.firstCall.args[1]).to.deep.equal({ actorId: USER_ID })
    })

    it('SIMULATION_DISABLED: returns 503 with the correlation id when the flag is off', async () => {
      configure({ enabled: false })

      const response = await post('/simulation/base-scenarios', { routeId: ROUTE_ID }, {
        'x-correlation-id': 'corr-base-flag'
      })

      expect(response.status).to.equal(503)
      expect(response.body).to.deep.equal({
        code: SIMULATION_ERROR_CODES.DISABLED,
        message: 'Simulation is disabled',
        correlationId: 'corr-base-flag'
      })
      expect(response.headers['x-correlation-id']).to.equal('corr-base-flag')
    })

    it('returns 503 when the injected configuration cannot be read', async () => {
      configure({
        getConfig: () => {
          throw new Error('invalid simulation environment')
        }
      })

      const response = await post('/simulation/base-scenarios', { routeId: ROUTE_ID })

      expect(response.status).to.equal(503)
      expect(response.body.code).to.equal(SIMULATION_ERROR_CODES.CONFIGURATION_UNAVAILABLE)
    })

    it('returns 401 when authentication is missing', async () => {
      configure()

      const response = await request(app)
        .post('/simulation/base-scenarios')
        .send({ routeId: ROUTE_ID })

      expect(response.status).to.equal(401)
      expect(response.body.code).to.equal('AUTHENTICATION_INVALID')
    })

    it('returns 403 when the actor lacks simulation:write', async () => {
      configure()

      const response = await post('/simulation/base-scenarios', { routeId: ROUTE_ID }, {
        'x-test-permission': 'deny',
        'x-correlation-id': 'corr-base-permission'
      })

      expect(response.status).to.equal(403)
      expect(response.body).to.deep.equal({
        code: 'PERMISSION_DENIED',
        message: 'Permission is denied',
        correlationId: 'corr-base-permission'
      })
    })

    it('TC-030: rejects an invalid or expanded base scenario contract', async () => {
      configure()

      const invalidRoute = await post('/simulation/base-scenarios', { routeId: 'route-1' })
      const extraField = await post('/simulation/base-scenarios', { routeId: ROUTE_ID, extra: true })

      expect(invalidRoute.status).to.equal(400)
      expect(invalidRoute.body.code).to.equal(SIMULATION_ERROR_CODES.INPUT_INVALID)
      expect(extraField.status).to.equal(400)
      expect(extraField.body.code).to.equal(SIMULATION_ERROR_CODES.INPUT_INVALID)
    })

    it('FR-028: distinguishes unapproved, incompatible and incomplete contracts', async () => {
      const expectations = [
        {
          code: SIMULATION_ERROR_CODES.CONTRACT_NOT_APPROVED,
          status: 409,
          missingField: undefined
        },
        {
          code: SIMULATION_ERROR_CODES.CONTRACT_INCOMPATIBLE,
          status: 409,
          missingField: undefined
        },
        {
          code: SIMULATION_ERROR_CODES.SNAPSHOT_INCOMPLETE,
          status: 422,
          missingField: 'stops[0].saleIds'
        },
        {
          code: SIMULATION_ERROR_CODES.PRODUCER_UNAVAILABLE,
          status: 503,
          missingField: undefined
        }
      ]

      for (const expectation of expectations) {
        configure({
          service: {
            loadSnapshots: async () => {
              throw new SimulationSnapshotError(
                expectation.code,
                `${expectation.code} rejected the producer snapshot`,
                expectation.missingField
              )
            }
          }
        })

        const response = await post('/simulation/base-scenarios', { routeId: ROUTE_ID }, {
          'x-correlation-id': `corr-${expectation.code.toLowerCase()}`
        })

        expect(response.status).to.equal(expectation.status)
        expect(response.body.dataQuality).to.equal(SIMULATION_DATA_QUALITY.INCOMPLETE)
        expect(response.body.error.code).to.equal(expectation.code)
        expect(response.body.error.correlationId).to.equal(`corr-${expectation.code.toLowerCase()}`)
        if (expectation.missingField !== undefined) {
          expect(response.body.missingField).to.equal(expectation.missingField)
        }
      }
    })

    it('preserves a typed service failure from token issuance', async () => {
      const issueBaseScenarioToken = sinon.stub().rejects(new SimulationServiceError(
        SIMULATION_ERROR_CODES.REPOSITORY_ERROR,
        'The base scenario handle store is unavailable'
      ))
      configure({ service: { issueBaseScenarioToken } })

      const response = await post('/simulation/base-scenarios', { routeId: ROUTE_ID }, {
        'x-correlation-id': 'corr-base-repository'
      })

      expect(response.status).to.equal(503)
      expect(response.body).to.deep.equal({
        code: SIMULATION_ERROR_CODES.REPOSITORY_ERROR,
        message: 'The base scenario handle store is unavailable',
        correlationId: 'corr-base-repository'
      })
    })

    it('maps an invalid issued token contract to 409 without weakening the auth gate', async () => {
      const issueBaseScenarioToken = sinon.stub().rejects(new SimulationTokenError(
        SIMULATION_ERROR_CODES.TOKEN_INVALID,
        'Base scenario route contract version is not allowlisted'
      ))
      configure({ service: { issueBaseScenarioToken } })

      const response = await post('/simulation/base-scenarios', { routeId: ROUTE_ID })

      expect(response.status).to.equal(409)
      expect(response.body.code).to.equal(SIMULATION_ERROR_CODES.TOKEN_INVALID)
    })
  })

  describe('POST /simulation/base-scenarios/:token/variants/calculate', () => {
    const calculatePath = (): string => `/simulation/base-scenarios/${ISSUED_TOKEN}/variants/calculate`

    it('S-02: calculates a variant and preserves the actor-bound token lookup', async () => {
      const verifyBaseScenarioToken = sinon.stub().resolves(validatedBaseScenario())
      configure({ service: { verifyBaseScenarioToken } })

      const response = await post(calculatePath(), validVariant())

      expect(response.status).to.equal(200)
      expect(response.body.dataQuality).to.equal(SIMULATION_DATA_QUALITY.COMPLETE)
      expect(response.body.baseScenarioHash).to.equal(validatedBaseScenario().baseScenarioHash)
      expect(response.body.variantId).to.equal('Optimized')
      expect(response.body.totals).to.deep.equal({
        revenueArs: 3015,
        merchandiseCostArs: 2010,
        operatingCostArs: 825,
        marginArs: 180
      })
      expect(verifyBaseScenarioToken.calledOnceWith(ISSUED_TOKEN, { actorId: USER_ID })).to.equal(true)
    })

    it('SIMULATION_DISABLED: returns 503 when the flag is off', async () => {
      configure({ enabled: false })

      const response = await post(calculatePath(), validVariant())

      expect(response.status).to.equal(503)
      expect(response.body.code).to.equal(SIMULATION_ERROR_CODES.DISABLED)
    })

    it('returns 403 when the actor lacks simulation:write', async () => {
      configure()

      const response = await post(calculatePath(), validVariant(), { 'x-test-permission': 'deny' })

      expect(response.status).to.equal(403)
      expect(response.body.code).to.equal('PERMISSION_DENIED')
    })

    it('TC-030: rejects an invalid variant contract before token verification', async () => {
      const verifyBaseScenarioToken = sinon.stub().resolves(validatedBaseScenario())
      configure({ service: { verifyBaseScenarioToken } })

      const response = await post(calculatePath(), { name: 'Optimized', directLoad: [] })

      expect(response.status).to.equal(400)
      expect(response.body.code).to.equal(SIMULATION_ERROR_CODES.INPUT_INVALID)
      expect(verifyBaseScenarioToken.called).to.equal(false)
    })

    it('preserves unsupported provisional variant features as input errors', async () => {
      configure()

      const response = await post(calculatePath(), {
        ...validVariant(),
        presetVersionId: ROUTE_ID
      })

      expect(response.status).to.equal(400)
      expect(response.body.code).to.equal(SIMULATION_ERROR_CODES.INPUT_INVALID)
    })

    it('maps invalid, expired and other-actor tokens to 401', async () => {
      const tokenErrors = [
        new SimulationTokenError(SIMULATION_ERROR_CODES.TOKEN_INVALID, 'Base scenario handle token is malformed'),
        new SimulationTokenError(SIMULATION_ERROR_CODES.TOKEN_EXPIRED, 'Base scenario handle has expired'),
        new SimulationTokenError(SIMULATION_ERROR_CODES.TOKEN_INVALID, 'Base scenario handle is bound to a different actor')
      ]

      for (const tokenError of tokenErrors) {
        configure({
          service: {
            verifyBaseScenarioToken: async () => {
              throw tokenError
            }
          }
        })

        const response = await post(calculatePath(), validVariant(), {
          'x-correlation-id': `corr-${tokenError.code.toLowerCase()}`
        })

        expect(response.status).to.equal(401)
        expect(response.body.code).to.equal(tokenError.code)
        expect(response.body.message).to.equal(tokenError.message)
        expect(response.body.correlationId).to.equal(`corr-${tokenError.code.toLowerCase()}`)
      }
    })

    it('FR-028: returns an incomplete calculation without fabricating totals', async () => {
      configure({ service: { calculationParameters: undefined } })

      const response = await post(calculatePath(), validVariant())

      expect(response.status).to.equal(200)
      expect(response.body.dataQuality).to.equal(SIMULATION_DATA_QUALITY.INCOMPLETE)
      expect(response.body.missingFields).to.deep.equal([
        'fuelPriceArsPerLiter',
        'durationCostArsPerHour',
        'distanceCostArsPerKm'
      ])
      expect(response.body.components).to.equal(undefined)
      expect(response.body.totals).to.equal(undefined)
    })

    it('S-10: rejects direct load above availability as a rejected limit', async () => {
      configure()

      const response = await post(calculatePath(), {
        ...validVariant(),
        directLoad: [{
          productId: PRODUCT_ID,
          quantity: 21,
          projectedSalesQuantity: 20
        }]
      }, { 'x-correlation-id': 'corr-direct-load' })

      expect(response.status).to.equal(422)
      expect(response.body.code).to.equal(SIMULATION_ERROR_CODES.INPUT_INVALID)
      expect(response.body.message).to.contain('exceeds availability')
      expect(response.body.correlationId).to.equal('corr-direct-load')
    })

    it('returns 503 when the token configuration is unavailable', async () => {
      configure({
        service: {
          verifyBaseScenarioToken: async () => {
            throw new SimulationTokenError(
              SIMULATION_ERROR_CODES.CONFIGURATION_UNAVAILABLE,
              'A base scenario token secret is required'
            )
          }
        }
      })

      const response = await post(calculatePath(), validVariant())

      expect(response.status).to.equal(503)
      expect(response.body.code).to.equal(SIMULATION_ERROR_CODES.CONFIGURATION_UNAVAILABLE)
    })
  })

  describe('Simulation demo API', () => {
    it('serves paginated demo routes and the available/included product catalog without the simulation grant or feature flag', async () => {
      configure({ enabled: false })

      const routes = await request(app).get('/simulation/demo/routes?page=1').set('Authorization', AUTH_HEADER).set('x-test-permission', 'deny')
      const catalog = await request(app).get('/simulation/demo/catalog').set('Authorization', AUTH_HEADER).set('x-test-permission', 'deny')

      expect(routes.status).to.equal(200)
      expect(routes.body).to.include({ page: 1, pageSize: 5, total: 8 })
      expect(routes.body.items[0]).to.include({ id: 'R-001', zone: 'Norte' })
      expect(catalog.status).to.equal(200)
      expect(catalog.body.available).to.have.length(5)
      expect(catalog.body.included[0]).to.include({ id: 'agua-500', quantity: 40 })
    })

    it('calculates and stores a scenario in the process-local history', async () => {
      configure({ enabled: false })

      const response = await post('/simulation/demo/scenarios', {
        routeId: 'R-002',
        parameters: { fuelPricePerLiter: 1250, includeSurplus: true, generalCosts: 25000, hourlyRate: 8000 },
        products: [{ id: 'agua-500', quantity: 10 }, { id: 'gaseosa-15', quantity: 2 }]
      }, { 'x-test-permission': 'deny' })
      const history = await request(app).get('/simulation/demo/scenarios?page=1').set('Authorization', AUTH_HEADER)

      expect(response.status).to.equal(201)
      expect(response.body).to.include({
        id: 'ESC-015',
        routeId: 'R-002',
        estimatedRevenue: 17000,
        operatingCost: 84800,
        grossMargin: -67800
      })
      expect(history.status).to.equal(200)
      expect(history.body.total).to.equal(15)
      expect(history.body.items[0].id).to.equal('ESC-015')
    })

    it('returns predictable validation errors and rejects excluded cost overrides', async () => {
      configure()

      const invalidPage = await request(app).get('/simulation/demo/routes?page=0').set('Authorization', AUTH_HEADER)
      const excludedCost = await post('/simulation/demo/scenarios', {
        routeId: 'R-001',
        parameters: { fuelPricePerLiter: 1000, includeSurplus: true, generalCosts: 0, hourlyRate: 100, tollsArs: 500 },
        products: []
      })
      const unknownRoute = await post('/simulation/demo/scenarios', {
        routeId: 'missing',
        parameters: { fuelPricePerLiter: 1000, includeSurplus: true, generalCosts: 0, hourlyRate: 100 },
        products: []
      })

      expect(invalidPage.status).to.equal(400)
      expect(invalidPage.body.code).to.equal(SIMULATION_ERROR_CODES.INPUT_INVALID)
      expect(excludedCost.status).to.equal(400)
      expect(excludedCost.body.code).to.equal(SIMULATION_ERROR_CODES.INPUT_INVALID)
      expect(unknownRoute.status).to.equal(400)
      expect(unknownRoute.body.message).to.equal('Unknown route')
    })
  })
})
