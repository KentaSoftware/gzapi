import { Schema, model } from 'mongoose'

import {
  SIMULATION_ROUTE_SNAPSHOT_STATUSES,
  type SimulationSnapshotHandle,
  type SimulationSnapshotHandleVersions
} from '../interfaces/simulation.interface'
import {
  simulationRouteSnapshotSchema,
  simulationStockSnapshotSchema
} from '../schemas/simulation.schema'

// Temporary base-scenario state, not a persisted simulation run. The TTL index
// makes asynchronous cleanup possible, so this model deliberately has no delete
// prohibition like the immutable run evidence model; only updates are frozen.
const SIMULATION_SNAPSHOT_HANDLE_COLLECTION = 'simulationsnapshothandles'
const SIMULATION_SNAPSHOT_HANDLE_IMMUTABLE_MESSAGE = 'Simulation snapshot handle evidence is immutable'
const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/
const VERSION_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const TIMESTAMP_MANAGED_PATHS = new Set(['createdAt', 'updatedAt'])

const snapshotHandleVersionsSchema = new Schema<SimulationSnapshotHandleVersions>(
  {
    routeContractVersion: {
      type: String,
      required: true,
      trim: true,
      maxlength: 64,
      match: VERSION_IDENTIFIER_PATTERN,
      immutable: true
    },
    stockContractVersion: {
      type: String,
      required: true,
      trim: true,
      maxlength: 64,
      match: VERSION_IDENTIFIER_PATTERN,
      immutable: true
    },
    rulesVersion: {
      type: String,
      required: true,
      trim: true,
      maxlength: 64,
      match: VERSION_IDENTIFIER_PATTERN,
      immutable: true
    }
  },
  { _id: false, versionKey: false }
)

const simulationSnapshotHandleSchema = new Schema<SimulationSnapshotHandle>(
  {
    handleDigest: {
      type: String,
      required: true,
      trim: true,
      match: SHA256_HEX_PATTERN,
      immutable: true
    },
    actorId: {
      type: String,
      required: true,
      trim: true,
      maxlength: 128,
      immutable: true
    },
    routeSnapshot: {
      type: Schema.Types.Mixed,
      required: true,
      immutable: true,
      validate: {
        validator: (value: unknown) =>
          simulationRouteSnapshotSchema.safeParse(value).success &&
          (value as { status?: string }).status === SIMULATION_ROUTE_SNAPSHOT_STATUSES.VALIDATED,
        message: 'routeSnapshot must describe a validated route snapshot contract'
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
    versions: {
      type: snapshotHandleVersionsSchema,
      required: true,
      immutable: true,
      validate: {
        validator: function (this: SimulationSnapshotHandle, value: SimulationSnapshotHandleVersions) {
          if (value === undefined || value === null) return true
          const routeSnapshot = this.routeSnapshot
          const stockSnapshot = this.stockSnapshot
          if (routeSnapshot === undefined || stockSnapshot === undefined) return true
          return routeSnapshot.contractVersion === value.routeContractVersion &&
            stockSnapshot.contractVersion === value.stockContractVersion
        },
        message: 'declared versions must match the frozen snapshots'
      }
    },
    baseScenarioHash: {
      type: String,
      required: true,
      trim: true,
      match: SHA256_HEX_PATTERN,
      immutable: true
    },
    issuedAt: {
      type: Date,
      required: true,
      immutable: true
    },
    expiresAt: {
      type: Date,
      required: true,
      immutable: true,
      validate: {
        validator: function (this: SimulationSnapshotHandle, value: Date) {
          if (this.issuedAt === undefined) return true
          return value.getTime() > this.issuedAt.getTime()
        },
        message: 'handle expiration must follow issuance'
      }
    }
  },
  {
    collection: SIMULATION_SNAPSHOT_HANDLE_COLLECTION,
    timestamps: true,
    versionKey: false
  }
)

simulationSnapshotHandleSchema.index(
  { handleDigest: 1 },
  { name: 'idx_simulation_snapshot_handle_digest_unique', unique: true }
)
simulationSnapshotHandleSchema.index(
  { expiresAt: 1 },
  { name: 'idx_simulation_snapshot_handle_expires_ttl', expireAfterSeconds: 0 }
)

// A handle is write-once until Mongo's TTL cleanup removes it. There is no
// legitimate update path, so reject updates instead of silently stripping them.
// Deletion is deliberately left unguarded: the TTL monitor bypasses Mongoose and
// the model itself must remain able to delete expired records.
simulationSnapshotHandleSchema.pre('save', function () {
  if (this.isNew) return
  const modifiedPaths = this.modifiedPaths().filter((path) => !TIMESTAMP_MANAGED_PATHS.has(path))
  if (modifiedPaths.length > 0) throw new Error(SIMULATION_SNAPSHOT_HANDLE_IMMUTABLE_MESSAGE)
})

simulationSnapshotHandleSchema.pre(
  ['findOneAndUpdate', 'updateOne', 'updateMany', 'replaceOne', 'findOneAndReplace'],
  function () {
    throw new Error(SIMULATION_SNAPSHOT_HANDLE_IMMUTABLE_MESSAGE)
  }
)

simulationSnapshotHandleSchema.pre('bulkWrite', function () {
  throw new Error(SIMULATION_SNAPSHOT_HANDLE_IMMUTABLE_MESSAGE)
})

const SimulationSnapshotHandleModel = model<SimulationSnapshotHandle>(
  'simulationSnapshotHandle',
  simulationSnapshotHandleSchema
)

export {
  SIMULATION_SNAPSHOT_HANDLE_COLLECTION,
  simulationSnapshotHandleSchema
}
export default SimulationSnapshotHandleModel
