import {
  Router,
  type Request,
  type RequestHandler
} from 'express'

import { getSimulationConfig, type SimulationConfiguration } from '../config/simulation'
import {
  postBaseScenario,
  postCalculateVariant
} from '../controllers/simulation'
import { SIMULATION_ERROR_CODES } from '../interfaces/simulation.interface'
import { checkPermission } from '../middleware/checkPermission'
import { checkJwt } from '../middleware/session'
import {
  SimulationServiceError,
  type SimulationServiceDependencies
} from '../services/simulation'
import { sendErrorEnvelope } from '../utils/error.handle'

interface SimulationRouteDependencies {
  checkJwt: RequestHandler
  checkPermission: (action: string) => RequestHandler
  getConfig: () => SimulationConfiguration
  service: SimulationServiceDependencies
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
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const isRouteDependencies = (value: unknown): value is SimulationRouteDependencies =>
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
  return isRouteDependencies(injected) ? injected : fallback
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

  router.post('/base-scenarios', ...guards('simulation:write'), (req, res) => {
    void postBaseScenario(req, res, { service: resolveDependencies(req, dependencies).service })
  })

  router.post('/base-scenarios/:token/variants/calculate', ...guards('simulation:write'), (req, res) => {
    void postCalculateVariant(req, res, { service: resolveDependencies(req, dependencies).service })
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
