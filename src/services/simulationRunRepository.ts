import { Types } from 'mongoose'

import {
  SIMULATION_ERROR_CODES,
  SIMULATION_RECORD_STATUSES,
  type SimulationErrorCode,
  type SimulationRecordStatus,
  type SimulationRouteSnapshot,
  type SimulationRun,
  type SimulationStockSnapshot,
  type SimulationVariantInput,
  type SimulationVersionEvidence
} from '../interfaces/simulation.interface'
import SimulationRunModel from '../models/simulationRun'

// The HTTP surface and the repository seam expose identifier fields as strings.
// MongoDB documents keep them as ObjectIds until they are projected here.
type SimulationRunRecord = Omit<SimulationRun, 'createdBy' | 'archivedBy' | 'recalculatedFromRunId'> & {
  _id: string
  createdBy: string
  archivedBy?: string
  recalculatedFromRunId?: string
}

interface SimulationRunLifecycleUpdate {
  $set: Record<string, unknown>
  $unset?: Record<string, string>
}

interface SimulationRunMongoDriver {
  findById: (id: string) => Promise<unknown | null>
  findOneAndUpdate: (
    filter: { _id: string, status: SimulationRecordStatus },
    update: SimulationRunLifecycleUpdate
  ) => Promise<unknown | null>
}

interface SimulationRunRepository {
  findById: (id: string) => Promise<SimulationRunRecord>
  archive: (id: string, actorId: string) => Promise<SimulationRunRecord>
  restore: (id: string, actorId: string) => Promise<SimulationRunRecord>
}

interface SimulationRunRepositoryOptions {
  clock?: () => Date
}

class SimulationRunRepositoryError extends Error {
  readonly code: SimulationErrorCode

  constructor (code: SimulationErrorCode, message: string) {
    super(message)
    this.name = 'SimulationRunRepositoryError'
    this.code = code
  }
}

const RUN_ID_PATTERN = /^[a-fA-F0-9]{24}$/
const RUN_EVIDENCE_IMMUTABLE_MESSAGE = 'Simulation run evidence is immutable'
const RUN_STATUS_MESSAGE = 'Simulation run status is outside the reversible lifecycle'
const RUN_REPOSITORY_UNAVAILABLE_MESSAGE = 'Simulation run repository is unavailable'

const repositoryUnavailable = (): SimulationRunRepositoryError =>
  new SimulationRunRepositoryError(SIMULATION_ERROR_CODES.REPOSITORY_ERROR, RUN_REPOSITORY_UNAVAILABLE_MESSAGE)

const runNotFound = (): SimulationRunRepositoryError =>
  new SimulationRunRepositoryError(SIMULATION_ERROR_CODES.RUN_NOT_FOUND, 'Simulation run was not found')

const transitionInvalid = (message: string): SimulationRunRepositoryError =>
  new SimulationRunRepositoryError(SIMULATION_ERROR_CODES.RUN_TRANSITION_INVALID, message)

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isRecordStatus = (value: unknown): value is SimulationRecordStatus =>
  typeof value === 'string' &&
  Object.values(SIMULATION_RECORD_STATUSES).some((status) => status === value)

const identifierOf = (value: unknown): string | undefined => {
  if (typeof value === 'string' && value.trim() !== '') return value
  if (value instanceof Types.ObjectId) return value.toHexString()
  return undefined
}

const dateOf = (value: unknown): Date | undefined => {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value
  if (typeof value === 'string') {
    const parsed = new Date(value)
    if (!Number.isNaN(parsed.getTime())) return parsed
  }
  return undefined
}

const optionalDate = (value: unknown, present: boolean): Date | undefined => {
  if (!present) return undefined
  const parsed = dateOf(value)
  if (parsed === undefined) throw repositoryUnavailable()
  return parsed
}

const optionalIdentifier = (value: unknown, present: boolean): string | undefined => {
  if (!present) return undefined
  const identifier = identifierOf(value)
  if (identifier === undefined) throw repositoryUnavailable()
  return identifier
}

const projectRun = (value: unknown): SimulationRunRecord => {
  if (!isRecord(value)) throw repositoryUnavailable()

  const id = identifierOf(value._id)
  const createdBy = identifierOf(value.createdBy)
  const createdAt = dateOf(value.createdAt)
  const updatedAt = dateOf(value.updatedAt)
  if (
    id === undefined ||
    createdBy === undefined ||
    createdAt === undefined ||
    updatedAt === undefined ||
    !isRecordStatus(value.status) ||
    typeof value.sourceRouteId !== 'string' ||
    typeof value.baseScenarioHash !== 'string' ||
    !isRecord(value.routeSnapshot) ||
    !isRecord(value.stockSnapshot) ||
    !isRecord(value.variant) ||
    !isRecord(value.calculation) ||
    !isRecord(value.versions)
  ) {
    throw repositoryUnavailable()
  }

  const record: SimulationRunRecord = {
    _id: id,
    status: value.status,
    createdBy,
    sourceRouteId: value.sourceRouteId,
    routeSnapshot: value.routeSnapshot as unknown as SimulationRouteSnapshot,
    stockSnapshot: value.stockSnapshot as unknown as SimulationStockSnapshot,
    baseScenarioHash: value.baseScenarioHash,
    variant: value.variant as unknown as SimulationVariantInput,
    calculation: value.calculation as unknown as SimulationRun['calculation'],
    versions: value.versions as unknown as SimulationVersionEvidence,
    createdAt,
    updatedAt
  }

  const archivedAt = optionalDate(value.archivedAt, value.archivedAt !== undefined)
  if (archivedAt !== undefined) record.archivedAt = archivedAt
  const archivedBy = optionalIdentifier(value.archivedBy, value.archivedBy !== undefined)
  if (archivedBy !== undefined) record.archivedBy = archivedBy
  const recalculatedFromRunId = optionalIdentifier(
    value.recalculatedFromRunId,
    value.recalculatedFromRunId !== undefined
  )
  if (recalculatedFromRunId !== undefined) record.recalculatedFromRunId = recalculatedFromRunId

  return record
}

const normalizeRepositoryFailure = (error: unknown): SimulationRunRepositoryError => {
  if (error instanceof SimulationRunRepositoryError) return error
  const message = error instanceof Error ? error.message : ''
  if (message.includes(RUN_EVIDENCE_IMMUTABLE_MESSAGE)) {
    return new SimulationRunRepositoryError(SIMULATION_ERROR_CODES.EVIDENCE_IMMUTABLE, RUN_EVIDENCE_IMMUTABLE_MESSAGE)
  }
  if (message.includes(RUN_STATUS_MESSAGE)) {
    return new SimulationRunRepositoryError(SIMULATION_ERROR_CODES.RUN_TRANSITION_INVALID, RUN_STATUS_MESSAGE)
  }
  return repositoryUnavailable()
}

const guarded = async <T>(operation: () => Promise<T>): Promise<T> => {
  try {
    return await operation()
  } catch (error) {
    throw normalizeRepositoryFailure(error)
  }
}

const assertRunId = (id: string): void => {
  if (!RUN_ID_PATTERN.test(id)) throw runNotFound()
}

const clockNow = (clock: () => Date): Date => {
  const now = clock()
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw repositoryUnavailable()
  }
  return now
}

const mongoDriver: SimulationRunMongoDriver = {
  findById: async (id) => await SimulationRunModel.findById(id).lean().exec(),
  findOneAndUpdate: async (filter, update) => await SimulationRunModel.findOneAndUpdate(
    filter,
    update,
    { new: true }
  ).lean().exec()
}

const createSimulationRunMongoRepository = (
  driver: SimulationRunMongoDriver = mongoDriver,
  options: SimulationRunRepositoryOptions = {}
): SimulationRunRepository => {
  const clock = options.clock ?? (() => new Date())

  const failedTransition = async (id: string, message: string): Promise<never> => {
    const existing = await driver.findById(id)
    if (existing === null || existing === undefined) throw runNotFound()
    throw transitionInvalid(message)
  }

  return {
    findById: async (id) => await guarded(async () => {
      assertRunId(id)
      const found = await driver.findById(id)
      if (found === null || found === undefined) throw runNotFound()
      return projectRun(found)
    }),
    archive: async (id, actorId) => await guarded(async () => {
      assertRunId(id)
      const now = clockNow(clock)
      const updated = await driver.findOneAndUpdate(
        { _id: id, status: SIMULATION_RECORD_STATUSES.ACTIVE },
        {
          $set: {
            status: SIMULATION_RECORD_STATUSES.ARCHIVED,
            archivedAt: now,
            archivedBy: actorId
          }
        }
      )
      if (updated !== null && updated !== undefined) return projectRun(updated)
      return await failedTransition(id, 'Only active simulation runs can be archived')
    }),
    restore: async (id, _actorId) => await guarded(async () => {
      assertRunId(id)
      const updated = await driver.findOneAndUpdate(
        { _id: id, status: SIMULATION_RECORD_STATUSES.ARCHIVED },
        {
          $set: { status: SIMULATION_RECORD_STATUSES.ACTIVE },
          $unset: { archivedAt: '', archivedBy: '' }
        }
      )
      if (updated !== null && updated !== undefined) return projectRun(updated)
      return await failedTransition(id, 'Only archived simulation runs can be restored')
    })
  }
}

export {
  SimulationRunRepositoryError,
  createSimulationRunMongoRepository
}
export type {
  SimulationRunLifecycleUpdate,
  SimulationRunMongoDriver,
  SimulationRunRecord,
  SimulationRunRepository,
  SimulationRunRepositoryOptions
}
