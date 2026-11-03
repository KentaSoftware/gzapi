import { Schema, model, type UpdateQuery } from 'mongoose'

import {
  SIMULATION_RECORD_STATUSES,
  type SimulationPresetVersion
} from '../interfaces/simulation.interface'
import { presetDefinitionSchema } from '../schemas/simulation.schema'

const PRESET_IMMUTABLE_MESSAGE = 'Simulation preset versions are immutable'
const TIMESTAMP_MANAGED_PATHS = new Set(['createdAt', 'updatedAt'])
const PRESET_MUTABLE_PATHS = new Set(['status', 'archivedAt', 'archivedBy'])
const PRESET_UNSETTABLE_PATHS = new Set(['archivedAt', 'archivedBy'])
const PRESET_STATUS_VALUES: ReadonlySet<unknown> = new Set(Object.values(SIMULATION_RECORD_STATUSES))
const PRESET_STATUS_MESSAGE = `Simulation preset status must be one of: ${Object.values(SIMULATION_RECORD_STATUSES).join(', ')}`
const LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._-]*$/

interface MutationOptions {
  timestamps?: boolean
  overwriteImmutable?: boolean
}

const isPresetDefinition = (value: unknown): boolean => presetDefinitionSchema.safeParse(value).success

const simulationPresetVersionSchema = new Schema<SimulationPresetVersion>(
  {
    name: { type: String, required: true, trim: true, maxlength: 64, match: LABEL_PATTERN, immutable: true },
    version: {
      type: Number,
      required: true,
      min: 1,
      validate: { validator: Number.isSafeInteger, message: 'version must be a safe integer' },
      immutable: true
    },
    definition: {
      type: Schema.Types.Mixed,
      required: true,
      immutable: true,
      validate: {
        validator: isPresetDefinition,
        message: 'definition must contain overrides and direct load arrays'
      }
    },
    reason: { type: String, required: true, trim: true, maxlength: 500, immutable: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'user', required: true, immutable: true },
    status: {
      type: String,
      enum: Object.values(SIMULATION_RECORD_STATUSES),
      required: true
    },
    archivedAt: { type: Date, required: false },
    archivedBy: { type: Schema.Types.ObjectId, ref: 'user', required: false }
  },
  {
    timestamps: true,
    versionKey: false
  }
)

simulationPresetVersionSchema.index(
  { name: 1, version: 1 },
  { unique: true, name: 'idx_simulation_preset_version_unique' }
)
simulationPresetVersionSchema.index(
  { status: 1, createdAt: -1 },
  { name: 'idx_simulation_preset_status_created' }
)

const assertAllowedUpdate = (update: unknown): void => {
  if (update === null || typeof update !== 'object' || Array.isArray(update)) {
    throw new Error(PRESET_IMMUTABLE_MESSAGE)
  }

  const operators = Object.keys(update)
  if (operators.length === 0 || operators.some((operator) => !operator.startsWith('$'))) {
    throw new Error(PRESET_IMMUTABLE_MESSAGE)
  }

  for (const operator of operators) {
    if (operator !== '$set' && operator !== '$unset') throw new Error(PRESET_IMMUTABLE_MESSAGE)
    const payload = (update as Record<string, unknown>)[operator]
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error(PRESET_IMMUTABLE_MESSAGE)
    }
    const allowedPaths = operator === '$set' ? PRESET_MUTABLE_PATHS : PRESET_UNSETTABLE_PATHS
    const payloadRecord = payload as Record<string, unknown>
    for (const path of Object.keys(payload)) {
      if (!allowedPaths.has(path)) throw new Error(PRESET_IMMUTABLE_MESSAGE)
    }
    if (operator === '$set' && 'status' in payloadRecord && !PRESET_STATUS_VALUES.has(payloadRecord.status)) {
      throw new Error(PRESET_STATUS_MESSAGE)
    }
  }
}

const assertPresetVersionUpdateAllowed = (update: unknown): void => {
  assertAllowedUpdate(update)
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

simulationPresetVersionSchema.pre('save', function () {
  if (this.isNew) return
  const modifiedPaths = this.modifiedPaths().filter((path) => !TIMESTAMP_MANAGED_PATHS.has(path))
  for (const path of modifiedPaths) {
    if (!PRESET_MUTABLE_PATHS.has(path)) throw new Error(PRESET_IMMUTABLE_MESSAGE)
  }
})

simulationPresetVersionSchema.pre(['findOneAndUpdate', 'updateOne', 'updateMany', 'replaceOne', 'findOneAndReplace'], function () {
  const options = {
    ...(this.getOptions() as MutationOptions),
    ...((this as unknown as { _mongooseOptions?: MutationOptions })._mongooseOptions ?? {})
  }
  if (options.overwriteImmutable === true) throw new Error(PRESET_IMMUTABLE_MESSAGE)
  if (options.timestamps === false) {
    this.setUpdate(withoutTimestampFields(this.getUpdate()) as UpdateQuery<SimulationPresetVersion>)
  }
  assertPresetVersionUpdateAllowed(withoutTimestampFields(this.getUpdate()))
})

simulationPresetVersionSchema.pre(['deleteOne', 'deleteMany', 'findOneAndDelete'], function () {
  throw new Error(PRESET_IMMUTABLE_MESSAGE)
})

const SimulationPresetVersionModel = model<SimulationPresetVersion>('simulationPresetVersion', simulationPresetVersionSchema)

export {
  simulationPresetVersionSchema,
  assertPresetVersionUpdateAllowed
}
export default SimulationPresetVersionModel
