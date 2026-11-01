import { Schema, model, type UpdateQuery } from 'mongoose'

import {
  SIMULATION_RECORD_STATUSES,
  type SimulationRun,
  type SimulationVersionEvidence
} from '../interfaces/simulation.interface'
import {
  simulationCalculationResultSchema,
  simulationRouteSnapshotSchema,
  simulationStockSnapshotSchema,
  simulationVariantInputSchema
} from '../schemas/simulation.schema'

const RUN_IMMUTABLE_MESSAGE = 'Simulation run evidence is immutable'
const TIMESTAMP_MANAGED_PATHS = new Set(['createdAt', 'updatedAt'])
const RUN_MUTABLE_PATHS = new Set(['status', 'archivedAt', 'archivedBy'])
const RUN_UNSETTABLE_PATHS = new Set(['archivedAt', 'archivedBy'])

interface MutationOptions {
  timestamps?: boolean
  overwriteImmutable?: boolean
}

const versionEvidenceSchema = new Schema<SimulationVersionEvidence>(
  {
    rulesVersion: { type: String, required: true, trim: true, maxlength: 64 },
    configurationVersion: { type: String, required: true, trim: true, maxlength: 64 },
    configurationVersionId: { type: Schema.Types.ObjectId, ref: 'simulationConfigVersion', required: false },
    presetVersion: { type: String, required: false, trim: true, maxlength: 64 },
    routeContractVersion: { type: String, required: true, trim: true, maxlength: 64 },
    stockContractVersion: { type: String, required: true, trim: true, maxlength: 64 },
    calculatedAt: { type: Date, required: true },
    correlationId: { type: String, required: false, trim: true, maxlength: 128 }
  },
  { _id: false, versionKey: false }
)

const simulationRunSchema = new Schema<SimulationRun>(
  {
    status: {
      type: String,
      enum: Object.values(SIMULATION_RECORD_STATUSES),
      required: true
    },
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: 'user',
      required: true,
      immutable: true
    },
    archivedAt: {
      type: Date,
      required: false
    },
    archivedBy: {
      type: Schema.Types.ObjectId,
      ref: 'user',
      required: false
    },
    sourceRouteId: {
      type: String,
      required: true,
      trim: true,
      maxlength: 64,
      immutable: true
    },
    routeSnapshot: {
      type: Schema.Types.Mixed,
      required: true,
      immutable: true,
      validate: {
        validator: (value: unknown) => simulationRouteSnapshotSchema.safeParse(value).success,
        message: 'routeSnapshot must match the validated route snapshot contract'
      }
    },
    stockSnapshot: {
      type: Schema.Types.Mixed,
      required: true,
      immutable: true,
      validate: {
        validator: (value: unknown) => simulationStockSnapshotSchema.safeParse(value).success,
        message: 'stockSnapshot must match the validated stock snapshot contract'
      }
    },
    baseScenarioHash: {
      type: String,
      required: true,
      trim: true,
      match: /^[a-f0-9]{64}$/,
      immutable: true
    },
    variant: {
      type: Schema.Types.Mixed,
      required: true,
      immutable: true,
      validate: {
        validator: (value: unknown) => simulationVariantInputSchema.safeParse(value).success,
        message: 'variant must match the validated variant input contract'
      }
    },
    calculation: {
      type: Schema.Types.Mixed,
      required: true,
      immutable: true,
      validate: {
        validator: (value: unknown) => simulationCalculationResultSchema.safeParse(value).success,
        message: 'calculation must match the validated calculation result contract'
      }
    },
    versions: {
      type: versionEvidenceSchema,
      required: true,
      immutable: true
    },
    recalculatedFromRunId: {
      type: Schema.Types.ObjectId,
      ref: 'simulationRun',
      required: false,
      immutable: true
    }
  },
  {
    timestamps: true,
    versionKey: false
  }
)

simulationRunSchema.index(
  { sourceRouteId: 1, createdAt: -1 },
  { name: 'idx_simulation_run_route_created' }
)
simulationRunSchema.index(
  { status: 1, createdAt: -1 },
  { name: 'idx_simulation_run_status_created' }
)

const assertAllowedUpdate = (
  update: unknown,
  mutablePaths: Set<string>,
  unsettablePaths: Set<string>
): void => {
  if (update === null || typeof update !== 'object' || Array.isArray(update)) {
    throw new Error(RUN_IMMUTABLE_MESSAGE)
  }

  const operators = Object.keys(update)
  if (operators.length === 0 || operators.some((operator) => !operator.startsWith('$'))) {
    throw new Error(RUN_IMMUTABLE_MESSAGE)
  }

  for (const operator of operators) {
    if (operator !== '$set' && operator !== '$unset') throw new Error(RUN_IMMUTABLE_MESSAGE)
    const payload = (update as Record<string, unknown>)[operator]
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error(RUN_IMMUTABLE_MESSAGE)
    }
    const allowedPaths = operator === '$set' ? mutablePaths : unsettablePaths
    for (const path of Object.keys(payload)) {
      if (!allowedPaths.has(path)) throw new Error(RUN_IMMUTABLE_MESSAGE)
    }
  }
}

const assertRunUpdateAllowed = (update: unknown): void => {
  assertAllowedUpdate(update, RUN_MUTABLE_PATHS, RUN_UNSETTABLE_PATHS)
}

const assertRunDocumentTransitionAllowed = (isNew: boolean, modifiedPaths: string[]): void => {
  if (isNew) return
  for (const path of modifiedPaths) {
    if (!RUN_MUTABLE_PATHS.has(path)) throw new Error(RUN_IMMUTABLE_MESSAGE)
  }
}

const withoutTimestampFields = (update: unknown): unknown => {
  if (update === null || typeof update !== 'object' || Array.isArray(update)) return update
  const sanitizedEntries: Array<[string, unknown]> = []
  for (const [operator, payload] of Object.entries(update as Record<string, unknown>)) {
    if ((operator === '$set' || operator === '$setOnInsert') && payload !== null && typeof payload === 'object' && !Array.isArray(payload)) {
      const entries = Object.entries(payload as Record<string, unknown>)
        .filter(([path]) => !TIMESTAMP_MANAGED_PATHS.has(path))
      if (entries.length > 0) sanitizedEntries.push([operator, Object.fromEntries(entries)])
      continue
    }
    sanitizedEntries.push([operator, payload])
  }
  return Object.fromEntries(sanitizedEntries)
}

simulationRunSchema.pre('save', function () {
  const modifiedPaths = this.modifiedPaths().filter((path) => !TIMESTAMP_MANAGED_PATHS.has(path))
  assertRunDocumentTransitionAllowed(this.isNew, modifiedPaths)
})

simulationRunSchema.pre(['findOneAndUpdate', 'updateOne', 'updateMany', 'replaceOne', 'findOneAndReplace'], function () {
  const options = {
    ...(this.getOptions() as MutationOptions),
    ...((this as unknown as { _mongooseOptions?: MutationOptions })._mongooseOptions ?? {})
  }
  if (options.overwriteImmutable === true) throw new Error(RUN_IMMUTABLE_MESSAGE)
  if (options.timestamps === false) {
    this.setUpdate(withoutTimestampFields(this.getUpdate()) as UpdateQuery<SimulationRun>)
  }
  assertRunUpdateAllowed(withoutTimestampFields(this.getUpdate()))
})

simulationRunSchema.pre(['deleteOne', 'deleteMany', 'findOneAndDelete'], function () {
  throw new Error(RUN_IMMUTABLE_MESSAGE)
})

const SimulationRunModel = model<SimulationRun>('simulationRun', simulationRunSchema)

export {
  simulationRunSchema,
  assertRunUpdateAllowed,
  assertRunDocumentTransitionAllowed
}
export default SimulationRunModel
