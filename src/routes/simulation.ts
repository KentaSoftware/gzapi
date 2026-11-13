import {
  Router,
  type Request,
  type Response,
  type RequestHandler
} from 'express'

import { getSimulationConfig, type SimulationConfiguration } from '../config/simulation'
import {
  getRun,
  getDemoCatalog,
  getDemoRoutes,
  getDemoScenarios,
  getDemoScenarioDetail,
  postArchiveRun,
  postBaseScenario,
  postCalculateVariant,
  postDemoScenario,
  postRestoreRun
} from '../controllers/simulation'
import { SIMULATION_ERROR_CODES } from '../interfaces/simulation.interface'
import { checkPermission } from '../middleware/checkPermission'
import { checkJwt } from '../middleware/session'
import type { SimulationServiceDependencies } from '../services/simulation'
import { createSimulationProductionService } from '../services/simulationProductionProducers'
import {
  createSimulationRunMongoRepository,
  type SimulationRunRepository
} from '../services/simulationRunRepository'
import { sendErrorEnvelope } from '../utils/error.handle'
import { simulationDemoRepository, type SimulationDemoRepository } from '../models/simulationDemoFixture'
import { listRouteCatalog, listRouteOptions, createRealRouteScenario, getRealRouteScenario, listRealRouteScenarios, RealRouteScenarioError } from '../services/routeSimulation'
import { realRouteScenarioInputSchema } from '../schemas/simulation.schema'

interface SimulationRouteDependencies {
  checkJwt: RequestHandler
  checkPermission: (action: string, options?: { currentRole?: boolean }) => RequestHandler
  getConfig: () => SimulationConfiguration
  service: SimulationServiceDependencies
  runRepository: SimulationRunRepository
  demoRepository: SimulationDemoRepository
  routeOptions: typeof listRouteOptions
  routeCatalog: typeof listRouteCatalog
  routeScenarioList: typeof listRealRouteScenarios
}

type InjectedSimulationRouteDependencies = Omit<SimulationRouteDependencies, 'runRepository' | 'demoRepository' | 'routeOptions' | 'routeCatalog'> & {
  runRepository?: SimulationRunRepository
  demoRepository?: SimulationDemoRepository
  routeOptions?: typeof listRouteOptions
  routeCatalog?: typeof listRouteCatalog
  routeScenarioList?: typeof listRealRouteScenarios
}

const SIMULATION_DEPENDENCIES_LOCAL = 'simulationRouteDependencies'

const productionService = createSimulationProductionService()

const productionDependencies: SimulationRouteDependencies = {
  checkJwt: (req, res, next) => { void checkJwt(req, res, next) },
  checkPermission: (action, options) => (req, res, next) => { void checkPermission(action, options)(req, res, next) },
  getConfig: () => getSimulationConfig(),
  service: productionService,
  runRepository: createSimulationRunMongoRepository(),
  demoRepository: simulationDemoRepository,
  routeOptions: listRouteOptions,
  routeCatalog: listRouteCatalog,
  routeScenarioList: listRealRouteScenarios
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const isRouteDependencies = (value: unknown): value is InjectedSimulationRouteDependencies =>
  isRecord(value) &&
  typeof value.checkJwt === 'function' &&
  typeof value.checkPermission === 'function' &&
  typeof value.getConfig === 'function' &&
  isRecord(value.service)

const resolveDependencies = (
  req: Request,
  fallback: SimulationRouteDependencies
): SimulationRouteDependencies => {
  const injected: unknown = req.app.locals[SIMULATION_DEPENDENCIES_LOCAL]
  if (!isRouteDependencies(injected)) return fallback
  return {
    ...fallback,
    ...injected,
    runRepository: injected.runRepository ?? fallback.runRepository,
    demoRepository: injected.demoRepository ?? fallback.demoRepository
  }
}

const simulationEnabledGuard = (fallback: SimulationRouteDependencies): RequestHandler => (req, res, next) => {
  let configuration: SimulationConfiguration
  try {
    configuration = resolveDependencies(req, fallback).getConfig()
  } catch {
    sendErrorEnvelope(res, 503, SIMULATION_ERROR_CODES.CONFIGURATION_UNAVAILABLE, 'Simulation configuration is unavailable')
    return
  }

  if (!configuration.enabled) {
    sendErrorEnvelope(res, 503, SIMULATION_ERROR_CODES.DISABLED, 'Simulation is disabled')
    return
  }

  next()
}

const createSimulationRouter = (
  dependencies: SimulationRouteDependencies = productionDependencies
): Router => {
  const router = Router()

  const guards = (action: string, currentRole = false): RequestHandler[] => [
    (req, res, next) => { resolveDependencies(req, dependencies).checkJwt(req, res, next) },
    (req, res, next) => { resolveDependencies(req, dependencies).checkPermission(action, currentRole ? { currentRole: true } : undefined)(req, res, next) },
    simulationEnabledGuard(dependencies)
  ]

  const controllerDependencies = (req: Request): {
    service: SimulationServiceDependencies
    runRepository: SimulationRunRepository
    demoRepository: SimulationDemoRepository
  } => {
    const resolved = resolveDependencies(req, dependencies)
    return {
      service: resolved.service,
      runRepository: resolved.runRepository,
      demoRepository: resolved.demoRepository
    }
  }

  // The thesis/demo endpoints use fixture data and deliberately bypass the
  // production simulation grant and feature-flag gates. JWT authentication is
  // retained to match the frontend's normal API client session behavior.
  const demoGuards: RequestHandler[] = [
    (req, res, next) => { resolveDependencies(req, dependencies).checkJwt(req, res, next) }
  ]

  const demoRouteHandler = (
    operation: string,
    handler: (req: Request, res: Response, repository: SimulationDemoRepository) => Promise<void>
  ): RequestHandler => (req, res) => {
    void handler(req, res, resolveDependencies(req, dependencies).demoRepository).catch(() => {
      const correlationId: unknown = res.locals.correlationId
      console.log(JSON.stringify({
        event: 'simulation_demo_request_failed',
        correlationId: typeof correlationId === 'string' ? correlationId : undefined,
        operation
      }))
      sendErrorEnvelope(
        res,
        503,
        SIMULATION_ERROR_CODES.REPOSITORY_ERROR,
        'Simulation demo repository is unavailable'
      )
    })
  }

  router.get('/demo/routes', ...demoGuards, demoRouteHandler('read_routes', getDemoRoutes))
  router.get('/demo/catalog', ...demoGuards, demoRouteHandler('read_catalog', getDemoCatalog))
  router.get('/demo/scenarios', ...demoGuards, demoRouteHandler('read_scenarios', getDemoScenarios))
  router.get('/demo/scenarios/:scenarioId', ...demoGuards, demoRouteHandler('read_scenario_detail', getDemoScenarioDetail))
  router.post('/demo/scenarios', ...demoGuards, demoRouteHandler('create_scenario', postDemoScenario))

  router.post('/base-scenarios', ...guards('simulation:write'), (req, res) => {
    void postBaseScenario(req, res, controllerDependencies(req))
  })

  router.post('/route-scenarios', ...guards('simulation:write', true), (req, res) => {
    const role: unknown = res.locals.authorizationRole
    const actor: unknown = res.locals.userId
    if (typeof actor !== 'string' || actor.trim() === '') {
      sendErrorEnvelope(res, 401, 'AUTHENTICATION_INVALID', 'Authentication credentials are invalid')
      return
    }
    if (typeof role !== 'string' || role.trim() === '') {
      sendErrorEnvelope(res, 403, 'PERMISSION_DENIED', 'Permission is denied')
      return
    }
    const input = realRouteScenarioInputSchema.safeParse(req.body)
    if (!input.success) {
      sendErrorEnvelope(res, 400, SIMULATION_ERROR_CODES.INPUT_INVALID, 'Scenario input is invalid')
      return
    }
    const scope = role === 'Repartidor' ? { kind: 'driver' as const, userId: actor } : { kind: 'global' as const }
    void createRealRouteScenario(input.data, scope).then((scenario) => { res.status(201).send(scenario) }).catch((error: unknown) => {
      if (error instanceof RealRouteScenarioError) {
        const missing = error.message === 'Route not found or not visible'
        sendErrorEnvelope(res, missing ? 404 : 422, missing ? 'ROUTE_NOT_FOUND' : 'SCENARIO_DATA_INVALID', missing ? 'Route not found or not visible' : 'Scenario data is unavailable')
        return
      }
      sendErrorEnvelope(res, 503, SIMULATION_ERROR_CODES.REPOSITORY_ERROR, 'Scenario repository is unavailable')
    })
  })

  router.get('/route-scenarios', ...guards('simulation:read', true), (req, res) => {
    const role: unknown = res.locals.authorizationRole
    const actor: unknown = res.locals.userId
    if (typeof actor !== 'string' || actor.trim() === '') {
      sendErrorEnvelope(res, 401, 'AUTHENTICATION_INVALID', 'Authentication credentials are invalid')
      return
    }
    if (typeof role !== 'string' || role.trim() === '') {
      sendErrorEnvelope(res, 403, 'PERMISSION_DENIED', 'Permission is denied')
      return
    }
    const rawPage: unknown = req.query.page
    const page = rawPage === undefined ? 1 : typeof rawPage === 'string' && /^[1-9]\d*$/.test(rawPage) ? Number(rawPage) : Number.NaN
    if (!Number.isSafeInteger(page) || page < 1) {
      sendErrorEnvelope(res, 400, SIMULATION_ERROR_CODES.INPUT_INVALID, 'Scenario history page is invalid')
      return
    }
    const scope = role === 'Repartidor' ? { kind: 'driver' as const, userId: actor } : { kind: 'global' as const }
    void resolveDependencies(req, dependencies).routeScenarioList(page, scope).then((history) => {
      res.send(history)
    }).catch(() => {
      sendErrorEnvelope(res, 503, SIMULATION_ERROR_CODES.REPOSITORY_ERROR, 'Scenario history is unavailable')
    })
  })

  router.get('/route-scenarios/:id', ...guards('simulation:read', true), (req, res) => {
    const role: unknown = res.locals.authorizationRole
    const actor: unknown = res.locals.userId
    if (typeof actor !== 'string' || actor.trim() === '') {
      sendErrorEnvelope(res, 401, 'AUTHENTICATION_INVALID', 'Authentication credentials are invalid')
      return
    }
    if (typeof role !== 'string' || role.trim() === '') {
      sendErrorEnvelope(res, 403, 'PERMISSION_DENIED', 'Permission is denied')
      return
    }
    const scope = role === 'Repartidor' ? { kind: 'driver' as const, userId: actor } : { kind: 'global' as const }
    void getRealRouteScenario(req.params.id, scope).then((scenario) => {
      if (scenario === null) {
        sendErrorEnvelope(res, 404, 'SCENARIO_NOT_FOUND', 'Scenario not found or not visible')
        return
      }
      res.send(scenario)
    }).catch(() => { sendErrorEnvelope(res, 503, SIMULATION_ERROR_CODES.REPOSITORY_ERROR, 'Scenario repository is unavailable') })
  })

  router.get('/route-catalog', ...guards('simulation:read', true), (req, res) => {
    const cursor: unknown = req.query.cursor
    if (cursor !== undefined && (typeof cursor !== 'string' || !/^[a-fA-F0-9]{24}$/.test(cursor))) {
      sendErrorEnvelope(res, 400, 'INVALID_ROUTE_CURSOR', 'Route cursor is invalid')
      return
    }
    void resolveDependencies(req, dependencies).routeCatalog(cursor)
      .then((catalog) => { res.send(catalog) })
      .catch(() => { sendErrorEnvelope(res, 503, SIMULATION_ERROR_CODES.REPOSITORY_ERROR, 'Route catalog is unavailable') })
  })

  router.get('/routes', ...guards('simulation:read', true), (req, res) => {
    const role: unknown = res.locals.authorizationRole
    const userId: unknown = res.locals.userId
    if (typeof role !== 'string' || role === '' || (role === 'Repartidor' && (typeof userId !== 'string' || userId === ''))) {
      sendErrorEnvelope(res, 403, 'PERMISSION_DENIED', 'Permission is denied')
      return
    }
    const cursor: unknown = req.query.cursor
    if (cursor !== undefined && (typeof cursor !== 'string' || !/^[a-fA-F0-9]{24}$/.test(cursor))) {
      sendErrorEnvelope(res, 400, 'INVALID_ROUTE_CURSOR', 'Route cursor is invalid')
      return
    }
    void resolveDependencies(req, dependencies).routeOptions(role === 'Repartidor' ? String(userId) : undefined, cursor)
      .then((options) => { res.send(options) })
      .catch(() => { sendErrorEnvelope(res, 503, SIMULATION_ERROR_CODES.REPOSITORY_ERROR, 'Route options are unavailable') })
  })

  router.post('/base-scenarios/:token/variants/calculate', ...guards('simulation:write'), (req, res) => {
    void postCalculateVariant(req, res, controllerDependencies(req))
  })

  router.get('/runs/:id', ...guards('simulation:read'), (req, res) => {
    void getRun(req, res, controllerDependencies(req))
  })

  router.post('/runs/:id/archive', ...guards('simulation:write'), (req, res) => {
    void postArchiveRun(req, res, controllerDependencies(req))
  })

  router.post('/runs/:id/restore', ...guards('simulation:write'), (req, res) => {
    void postRestoreRun(req, res, controllerDependencies(req))
  })

  return router
}

const router = createSimulationRouter()

export {
  SIMULATION_DEPENDENCIES_LOCAL,
  createSimulationRouter,
  router
}
export type { SimulationRouteDependencies }
