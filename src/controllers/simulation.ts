import type { Request, Response } from 'express'

import {
  SIMULATION_DATA_QUALITY,
  SIMULATION_ERROR_CODES,
  type SimulationBaseScenarioResult,
  type SimulationErrorCode
} from '../interfaces/simulation.interface'
import {
  simulationBaseScenarioInputSchema,
  simulationVariantInputSchema
} from '../schemas/simulation.schema'
import {
  SimulationServiceError,
  calculateVariant,
  createBaseScenario,
  getSimulationDemoCatalog,
  getSimulationDemoRoutes,
  getSimulationDemoScenarios,
  getSimulationDemoScenarioDetail,
  simulateDemoScenario,
  type SimulationDemoProduct,
  type SimulationDemoRunInput,
  type SimulationServiceDependencies
} from '../services/simulation'
import {
  SimulationRunRepositoryError,
  type SimulationRunRepository
} from '../services/simulationRunRepository'
import { sendErrorEnvelope } from '../utils/error.handle'
import { simulationDemoRepository, type SimulationDemoRepository } from '../models/simulationDemoFixture'

interface SimulationControllerDependencies {
  service: SimulationServiceDependencies
  runRepository: SimulationRunRepository
  demoRepository: SimulationDemoRepository
}

const statusForSimulationError = (
  code: SimulationErrorCode,
  field?: string,
  invalidTokenStatus: 401 | 409 = 401
): number => {
  switch (code) {
    case SIMULATION_ERROR_CODES.INPUT_INVALID:
      return field === 'directLoad' ? 422 : 400
    case SIMULATION_ERROR_CODES.TOKEN_INVALID:
      return invalidTokenStatus
    case SIMULATION_ERROR_CODES.TOKEN_EXPIRED:
      return 401
    case SIMULATION_ERROR_CODES.CONTRACT_NOT_APPROVED:
    case SIMULATION_ERROR_CODES.CONTRACT_INCOMPATIBLE:
    case SIMULATION_ERROR_CODES.BASE_SCENARIO_INVALID:
    case SIMULATION_ERROR_CODES.RUN_TRANSITION_INVALID:
    case SIMULATION_ERROR_CODES.EVIDENCE_IMMUTABLE:
      return 409
    case SIMULATION_ERROR_CODES.SNAPSHOT_INCOMPLETE:
      return 422
    case SIMULATION_ERROR_CODES.RUN_NOT_FOUND:
      return 404
    case SIMULATION_ERROR_CODES.DISABLED:
    case SIMULATION_ERROR_CODES.CONFIGURATION_UNAVAILABLE:
    case SIMULATION_ERROR_CODES.PRODUCER_UNAVAILABLE:
    case SIMULATION_ERROR_CODES.REPOSITORY_ERROR:
      return 503
    default:
      return 503
  }
}

const actorIdOf = (res: Response): string | undefined => {
  const actorId: unknown = res.locals.userId
  return typeof actorId === 'string' && actorId.trim() !== '' ? actorId : undefined
}

const sendBaseScenarioResult = (res: Response, result: SimulationBaseScenarioResult): void => {
  if (result.dataQuality === SIMULATION_DATA_QUALITY.COMPLETE) {
    res.status(200).send(result)
    return
  }

  const correlationId: unknown = res.locals.correlationId
  const body = typeof correlationId === 'string'
    ? { ...result, error: { ...result.error, correlationId } }
    : result

  res.status(statusForSimulationError(result.error.code)).send(body)
}

const handleSimulationFailure = (
  res: Response,
  error: unknown,
  invalidTokenStatus: 401 | 409 = 401
): void => {
  if (error instanceof SimulationServiceError) {
    sendErrorEnvelope(
      res,
      statusForSimulationError(error.code, error.field, invalidTokenStatus),
      error.code,
      error.message
    )
    return
  }

  sendErrorEnvelope(res, 503, SIMULATION_ERROR_CODES.CONFIGURATION_UNAVAILABLE, 'Simulation request is unavailable')
}

const handleRunFailure = (res: Response, error: unknown): void => {
  if (error instanceof SimulationRunRepositoryError) {
    sendErrorEnvelope(res, statusForSimulationError(error.code), error.code, error.message)
    return
  }

  sendErrorEnvelope(
    res,
    503,
    SIMULATION_ERROR_CODES.REPOSITORY_ERROR,
    'Simulation run repository is unavailable'
  )
}

const demoInputError = (res: Response, message: string): void => {
  sendErrorEnvelope(res, 400, SIMULATION_ERROR_CODES.INPUT_INVALID, message)
}

const demoPage = (value: unknown): number | undefined => {
  if (value === undefined) return 1
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) return undefined
  const page = Number(value)
  return Number.isSafeInteger(page) ? page : undefined
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const hasOnlyKeys = (value: Record<string, unknown>, allowed: readonly string[]): boolean =>
  Object.keys(value).every((key) => allowed.includes(key))

const getDemoRoutes = async (req: Request, res: Response, repository: SimulationDemoRepository = simulationDemoRepository): Promise<void> => {
  const page = demoPage(req.query.page)
  if (page === undefined) {
    demoInputError(res, 'page must be a positive integer')
    return
  }
  res.status(200).send(await getSimulationDemoRoutes(page, repository))
}

const getDemoCatalog = async (_req: Request, res: Response, repository: SimulationDemoRepository = simulationDemoRepository): Promise<void> => {
  res.status(200).send(await getSimulationDemoCatalog(repository))
}

const getDemoScenarios = async (req: Request, res: Response, repository: SimulationDemoRepository = simulationDemoRepository): Promise<void> => {
  const page = demoPage(req.query.page)
  if (page === undefined) {
    demoInputError(res, 'page must be a positive integer')
    return
  }
  res.status(200).send(await getSimulationDemoScenarios(page, repository))
}

const getDemoScenarioDetail = async (req: Request, res: Response, repository: SimulationDemoRepository = simulationDemoRepository): Promise<void> => {
  const detail = await getSimulationDemoScenarioDetail(req.params.scenarioId, repository)
  if (detail === null) {
    sendErrorEnvelope(res, 404, SIMULATION_ERROR_CODES.RUN_NOT_FOUND, 'Simulation demo scenario was not found')
    return
  }
  res.status(200).send(detail)
}

const postDemoScenario = async (req: Request, res: Response, repository: SimulationDemoRepository = simulationDemoRepository): Promise<void> => {
  const body: unknown = req.body
  if (!isRecord(body) || !hasOnlyKeys(body, ['routeId', 'parameters', 'products']) ||
      typeof body.routeId !== 'string' || !isRecord(body.parameters) ||
      !hasOnlyKeys(body.parameters, ['fuelPricePerLiter', 'includeSurplus', 'generalCosts', 'hourlyRate']) ||
      typeof body.parameters.includeSurplus !== 'boolean' || !Array.isArray(body.products)) {
    demoInputError(res, 'scenario input has an invalid shape')
    return
  }

  const parameters = body.parameters
  const numericParameters = ['fuelPricePerLiter', 'generalCosts', 'hourlyRate'] as const
  if (numericParameters.some((key) => typeof parameters[key] !== 'number' ||
      !Number.isFinite(parameters[key]) || parameters[key] < 0)) {
    demoInputError(res, 'scenario parameters must be finite non-negative numbers')
    return
  }

  const catalog = await getSimulationDemoCatalog(repository)
  const products: SimulationDemoRunInput['products'] = []
  const seen = new Set<string>()
  for (const value of body.products) {
    if (!isRecord(value) || !hasOnlyKeys(value, ['id', 'quantity']) || typeof value.id !== 'string' ||
        typeof value.quantity !== 'number' || !Number.isFinite(value.quantity) || value.quantity < 0 || seen.has(value.id)) {
      demoInputError(res, 'products must contain unique product ids and non-negative quantities')
      return
    }
    const product: SimulationDemoProduct | undefined = catalog.available.find((entry) => entry.id === value.id)
    if (product === undefined || value.quantity > product.stock) {
      demoInputError(res, 'product is unknown or quantity exceeds available stock')
      return
    }
    seen.add(value.id)
    products.push({ ...product, quantity: value.quantity })
  }

  const input: SimulationDemoRunInput = {
    routeId: body.routeId,
    parameters: {
      fuelPricePerLiter: parameters.fuelPricePerLiter as number,
      includeSurplus: parameters.includeSurplus as boolean,
      generalCosts: parameters.generalCosts as number,
      hourlyRate: parameters.hourlyRate as number
    },
    products
  }
  try {
    res.status(201).send(await simulateDemoScenario(input, new Date(), repository))
  } catch (error) {
    if (error instanceof SimulationServiceError && error.code === SIMULATION_ERROR_CODES.INPUT_INVALID) {
      demoInputError(res, error.message)
      return
    }
    const correlationId: unknown = res.locals.correlationId
    console.log(JSON.stringify({
      event: 'simulation_demo_scenario_failed',
      correlationId: typeof correlationId === 'string' ? correlationId : undefined,
      operation: 'create_scenario'
    }))
    sendErrorEnvelope(res, 503, SIMULATION_ERROR_CODES.REPOSITORY_ERROR, 'Simulation demo repository is unavailable')
  }
}

const postBaseScenario = async (
  req: Request,
  res: Response,
  dependencies: SimulationControllerDependencies
): Promise<void> => {
  const actorId = actorIdOf(res)
  if (actorId === undefined) {
    sendErrorEnvelope(res, 401, 'AUTHENTICATION_INVALID', 'Authentication credentials are invalid')
    return
  }

  const input = simulationBaseScenarioInputSchema.safeParse(req.body)
  if (!input.success) {
    sendErrorEnvelope(res, 400, SIMULATION_ERROR_CODES.INPUT_INVALID, 'Base scenario input is invalid')
    return
  }

  try {
    const result = await createBaseScenario(input.data, { actorId }, dependencies.service)
    sendBaseScenarioResult(res, result)
  } catch (error) {
    handleSimulationFailure(res, error, 409)
  }
}

const postCalculateVariant = async (
  req: Request,
  res: Response,
  dependencies: SimulationControllerDependencies
): Promise<void> => {
  const actorId = actorIdOf(res)
  if (actorId === undefined) {
    sendErrorEnvelope(res, 401, 'AUTHENTICATION_INVALID', 'Authentication credentials are invalid')
    return
  }

  const input = simulationVariantInputSchema.safeParse(req.body)
  if (!input.success) {
    sendErrorEnvelope(res, 400, SIMULATION_ERROR_CODES.INPUT_INVALID, 'Variant input is invalid')
    return
  }

  try {
    const result = await calculateVariant(req.params.token, input.data, { actorId }, dependencies.service)
    res.status(200).send(result)
  } catch (error) {
    handleSimulationFailure(res, error)
  }
}

const getRun = async (
  req: Request,
  res: Response,
  dependencies: SimulationControllerDependencies
): Promise<void> => {
  const actorId = actorIdOf(res)
  if (actorId === undefined) {
    sendErrorEnvelope(res, 401, 'AUTHENTICATION_INVALID', 'Authentication credentials are invalid')
    return
  }

  try {
    const run = await dependencies.runRepository.findById(req.params.id)
    res.status(200).send(run)
  } catch (error) {
    handleRunFailure(res, error)
  }
}

const postArchiveRun = async (
  req: Request,
  res: Response,
  dependencies: SimulationControllerDependencies
): Promise<void> => {
  const actorId = actorIdOf(res)
  if (actorId === undefined) {
    sendErrorEnvelope(res, 401, 'AUTHENTICATION_INVALID', 'Authentication credentials are invalid')
    return
  }

  try {
    const run = await dependencies.runRepository.archive(req.params.id, actorId)
    res.status(200).send(run)
  } catch (error) {
    handleRunFailure(res, error)
  }
}

const postRestoreRun = async (
  req: Request,
  res: Response,
  dependencies: SimulationControllerDependencies
): Promise<void> => {
  const actorId = actorIdOf(res)
  if (actorId === undefined) {
    sendErrorEnvelope(res, 401, 'AUTHENTICATION_INVALID', 'Authentication credentials are invalid')
    return
  }

  try {
    const run = await dependencies.runRepository.restore(req.params.id, actorId)
    res.status(200).send(run)
  } catch (error) {
    handleRunFailure(res, error)
  }
}

export { getDemoCatalog, getDemoRoutes, getDemoScenarios, getDemoScenarioDetail, getRun, postArchiveRun, postBaseScenario, postCalculateVariant, postDemoScenario, postRestoreRun }
export type { SimulationControllerDependencies }
