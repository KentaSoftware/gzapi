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
  type SimulationServiceDependencies
} from '../services/simulation'
import {
  SimulationRunRepositoryError,
  type SimulationRunRepository
} from '../services/simulationRunRepository'
import { sendErrorEnvelope } from '../utils/error.handle'

interface SimulationControllerDependencies {
  service: SimulationServiceDependencies
  runRepository: SimulationRunRepository
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

export { getRun, postArchiveRun, postBaseScenario, postCalculateVariant, postRestoreRun }
export type { SimulationControllerDependencies }
