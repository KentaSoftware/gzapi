import type {
  SimulationSnapshotHandle,
  SimulationSnapshotHandleRepository
} from '../interfaces/simulation.interface'
import SimulationSnapshotHandleModel from '../models/simulationSnapshotHandle'

interface SimulationSnapshotHandleMongoDriver {
  insert: (record: SimulationSnapshotHandle) => Promise<void>
  findByHandleDigest: (handleDigest: string) => Promise<unknown | null>
}

// Lean reads always carry Mongo bookkeeping (`_id`, timestamps and any driver
// internals). Only the declared domain record may reach the strict token schema,
// so the repository projects exactly those fields instead of widening validation.
const SNAPSHOT_HANDLE_FIELDS = [
  'handleDigest',
  'actorId',
  'routeSnapshot',
  'stockSnapshot',
  'versions',
  'baseScenarioHash',
  'issuedAt',
  'expiresAt'
] as const

const projectSnapshotHandle = (value: unknown): unknown | null => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const projected: Record<string, unknown> = {}
  for (const field of SNAPSHOT_HANDLE_FIELDS) {
    projected[field] = record[field]
  }
  return projected
}

const mongoDriver: SimulationSnapshotHandleMongoDriver = {
  insert: async (record) => {
    await SimulationSnapshotHandleModel.create([record])
  },
  findByHandleDigest: async (handleDigest) => {
    return await SimulationSnapshotHandleModel.findOne({ handleDigest }).lean().exec()
  }
}

// The driver seam keeps repository tests deterministic and offline while the
// default path remains the Mongoose model used by the application.
const createSimulationSnapshotHandleMongoRepository = (
  driver: SimulationSnapshotHandleMongoDriver = mongoDriver
): SimulationSnapshotHandleRepository => ({
  insert: async (record) => {
    await driver.insert(record)
  },
  findByHandleDigest: async (handleDigest) => {
    const found = await driver.findByHandleDigest(handleDigest)
    return projectSnapshotHandle(found)
  }
})

export {
  createSimulationSnapshotHandleMongoRepository
}
export type {
  SimulationSnapshotHandleMongoDriver
}
