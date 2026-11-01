import { Schema, model, type UpdateQuery } from 'mongoose'

import {
  SIMULATION_RECORD_STATUSES,
  type SimulationConfigVersion,
  type SimulationPeriod
} from '../interfaces/simulation.interface'
import { simulationNumericRecordSchema } from '../schemas/simulation.schema'

const CONFIG_IMMUTABLE_MESSAGE = 'Simulation configuration versions are immutable'
const TIMESTAMP_MANAGED_PATHS = new Set(['createdAt', 'updatedAt'])
const CONFIG_MUTABLE_PATHS = new Set(['status', 'archivedAt', 'archivedBy'])
const CONFIG_UNSETTABLE_PATHS = new Set(['archivedAt', 'archivedBy'])
const LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._-]*$/
const BOUNDED_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/

interface MutationOptions {
  timestamps?: boolean
  overwriteImmutable?: boolean
}

const isBoundedNumericRecord = (value: unknown, requireEntry: boolean): boolean => {
  if (!simulationNumericRecordSchema.safeParse(value).success) return false
  return !requireEntry || Object.keys(value as Record<string, unknown>).length > 0
}

const periodSchema = new Schema<SimulationPeriod>(
  {
    from: { type: Date, required: true },
    to: { type: Date, required: true }
  },
  { _id: false, versionKey: false }
)

periodSchema.pre('validate', function () {
  if (this.from instanceof Date && this.to instanceof Date && this.from.getTime() > this.to.getTime()) {
    this.invalidate('from', 'period.from must not be after period.to')
  }
})

const simulationConfigVersionSchema = new Schema<SimulationConfigVersion>(
  {
    version: {
      type: Number,
      required: true,
      min: 1,
      validate: { validator: Number.isSafeInteger, message: 'version must be a safe integer' },
      immutable: true
    },
    vehicleCode: { type: String, required: true, trim: true, maxlength: 64, match: LABEL_PATTERN, immutable: true },
    zoneCode: { type: String, required: true, trim: true, maxlength: 64, match: LABEL_PATTERN, immutable: true },
    period: { type: periodSchema, required: true, immutable: true },
    values: {
      type: Schema.Types.Mixed,
      required: true,
      immutable: true,
      validate: {
        validator: (value: unknown) => isBoundedNumericRecord(value, true),
        message: 'values must be a non-empty record of bounded non-negative numbers'
      }
    },
    limits: {
      type: Schema.Types.Mixed,
      required: true,
      immutable: true,
      validate: {
        validator: (value: unknown) => isBoundedNumericRecord(value, false),
        message: 'limits must be a record of bounded non-negative numbers'
      }
    },
    reason: { type: String, required: true, trim: true, maxlength: 500, immutable: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'user', required: true, immutable: true },
    approvedBy: { type: Schema.Types.ObjectId, ref: 'user', required: true, immutable: true },
    approvalId: { type: String, required: true, trim: true, maxlength: 128, match: BOUNDED_IDENTIFIER_PATTERN, immutable: true },
    approvedAt: { type: Date, required: true, immutable: true },
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

simulationConfigVersionSchema.index(
  { vehicleCode: 1, zoneCode: 1, 'period.from': 1, 'period.to': 1, version: 1 },
  { unique: true, name: 'idx_simulation_config_logical_version_unique' }
)
simulationConfigVersionSchema.index(
  { status: 1, 'period.from': 1, 'period.to': 1 },
  { name: 'idx_simulation_config_status_period' }
)

const assertAllowedUpdate = (update: unknown): void => {
  if (update === null || typeof update !== 'object' || Array.isArray(update)) {
    throw new Error(CONFIG_IMMUTABLE_MESSAGE)
  }

  const operators = Object.keys(update)
  if (operators.length === 0 || operators.some((operator) => !operator.startsWith('$'))) {
    throw new Error(CONFIG_IMMUTABLE_MESSAGE)
  }

  for (const operator of operators) {
    if (operator !== '$set' && operator !== '$unset') throw new Error(CONFIG_IMMUTABLE_MESSAGE)
    const payload = (update as Record<string, unknown>)[operator]
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error(CONFIG_IMMUTABLE_MESSAGE)
    }
    const allowedPaths = operator === '$set' ? CONFIG_MUTABLE_PATHS : CONFIG_UNSETTABLE_PATHS
    for (const path of Object.keys(payload)) {
      if (!allowedPaths.has(path)) throw new Error(CONFIG_IMMUTABLE_MESSAGE)
    }
  }
}

const assertConfigVersionUpdateAllowed = (update: unknown): void => {
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

simulationConfigVersionSchema.pre('save', function () {
  if (this.isNew) return
  const modifiedPaths = this.modifiedPaths().filter((path) => !TIMESTAMP_MANAGED_PATHS.has(path))
  for (const path of modifiedPaths) {
    if (!CONFIG_MUTABLE_PATHS.has(path)) throw new Error(CONFIG_IMMUTABLE_MESSAGE)
  }
})

simulationConfigVersionSchema.pre(['findOneAndUpdate', 'updateOne', 'updateMany', 'replaceOne', 'findOneAndReplace'], function () {
  const options = {
    ...(this.getOptions() as MutationOptions),
    ...((this as unknown as { _mongooseOptions?: MutationOptions })._mongooseOptions ?? {})
  }
  if (options.overwriteImmutable === true) throw new Error(CONFIG_IMMUTABLE_MESSAGE)
  if (options.timestamps === false) {
    this.setUpdate(withoutTimestampFields(this.getUpdate()) as UpdateQuery<SimulationConfigVersion>)
  }
  assertConfigVersionUpdateAllowed(withoutTimestampFields(this.getUpdate()))
})

simulationConfigVersionSchema.pre(['deleteOne', 'deleteMany', 'findOneAndDelete'], function () {
  throw new Error(CONFIG_IMMUTABLE_MESSAGE)
})

const SimulationConfigVersionModel = model<SimulationConfigVersion>('simulationConfigVersion', simulationConfigVersionSchema)

export {
  simulationConfigVersionSchema,
  assertConfigVersionUpdateAllowed
}
export default SimulationConfigVersionModel
