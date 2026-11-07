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

interface SimulationRouteDependencies {
  checkJwt: RequestHandler
  checkPermission: (action: string) => RequestHandler
  getConfig: () => SimulationConfiguration
  service: SimulationServiceDependencies
  runRepository: SimulationRunRepository
  demoRepository: SimulationDemoRepository
}

type InjectedSimulationRouteDependencies = Omit<SimulationRouteDependencies, 'runRepository' | 'demoRepository'> & {
  runRepository?: SimulationRunRepository
  demoRepository?: SimulationDemoRepository
}

const SIMULATION_DEPENDENCIES_LOCAL = 'simulationRouteDependencies'

const productionService = createSimulationProductionService()

const productionDependencies: SimulationRouteDependencies = {
  checkJwt: (req, res, next) => { void checkJwt(req, res, next) },
  checkPermission: (action) => (req, res, next) => { void checkPermission(action)(req, res, next) },
  getConfig: () => getSimulationConfig(),
  service: productionService,
  runRepository: createSimulationRunMongoRepository(),
  demoRepository: simulationDemoRepository
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

  const guards = (action: string): RequestHandler[] => [
    (req, res, next) => { resolveDependencies(req, dependencies).checkJwt(req, res, next) },
    (req, res, next) => { resolveDependencies(req, dependencies).checkPermission(action)(req, res, next) },
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
