import {
  Router,
  type Request,
  type RequestHandler
} from 'express'

import { getSimulationConfig, type SimulationConfiguration } from '../config/simulation'
import {
  getRun,
  getDemoCatalog,
  getDemoRoutes,
  getDemoScenarios,
  postArchiveRun,
  postBaseScenario,
  postCalculateVariant,
  postDemoScenario,
  postRestoreRun
} from '../controllers/simulation'
import { SIMULATION_ERROR_CODES } from '../interfaces/simulation.interface'
import { checkPermission } from '../middleware/checkPermission'
import { checkJwt } from '../middleware/session'
import {
  SimulationServiceError,
  type SimulationServiceDependencies
} from '../services/simulation'
import {
  createSimulationRunMongoRepository,
  type SimulationRunRepository
} from '../services/simulationRunRepository'
import { sendErrorEnvelope } from '../utils/error.handle'

interface SimulationRouteDependencies {
  checkJwt: RequestHandler
  checkPermission: (action: string) => RequestHandler
  getConfig: () => SimulationConfiguration
  service: SimulationServiceDependencies
  runRepository: SimulationRunRepository
}

type InjectedSimulationRouteDependencies = Omit<SimulationRouteDependencies, 'runRepository'> & {
  runRepository?: SimulationRunRepository
}

const SIMULATION_DEPENDENCIES_LOCAL = 'simulationRouteDependencies'

const unavailableService = async (): Promise<never> => {
  throw new SimulationServiceError(
    SIMULATION_ERROR_CODES.CONFIGURATION_UNAVAILABLE,
    'Simulation producer and token configuration are not available'
  )
}

const productionDependencies: SimulationRouteDependencies = {
  checkJwt: (req, res, next) => { void checkJwt(req, res, next) },
  checkPermission: (action) => (req, res, next) => { void checkPermission(action)(req, res, next) },
  getConfig: () => getSimulationConfig(),
  service: {
    loadSnapshots: unavailableService,
    issueBaseScenarioToken: unavailableService,
    verifyBaseScenarioToken: unavailableService
  },
  runRepository: createSimulationRunMongoRepository()
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
    runRepository: injected.runRepository ?? fallback.runRepository
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
  } => {
    const resolved = resolveDependencies(req, dependencies)
    return {
      service: resolved.service,
      runRepository: resolved.runRepository
    }
  }

  // The thesis/demo endpoints use fixture data and deliberately bypass the
  // production simulation grant and feature-flag gates. JWT authentication is
  // retained to match the frontend's normal API client session behavior.
  const demoGuards: RequestHandler[] = [
    (req, res, next) => { resolveDependencies(req, dependencies).checkJwt(req, res, next) }
  ]

  router.get('/demo/routes', ...demoGuards, (req, res) => { getDemoRoutes(req, res) })
  router.get('/demo/catalog', ...demoGuards, (req, res) => { getDemoCatalog(req, res) })
  router.get('/demo/scenarios', ...demoGuards, (req, res) => { getDemoScenarios(req, res) })
  router.post('/demo/scenarios', ...demoGuards, (req, res) => { postDemoScenario(req, res) })

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
