import RoutePlanModel from '../models/routePlan'
import { mongo } from 'mongoose'

// Keep aligned with the manual preflight's INDEX_NAME. Do not import the
// migration: its mongo-shell entry point can execute when a global db exists.
export const ASSIGNMENT_INDEX_NAME = 'routeplan_reserved_sale_ids_unique'

export interface AssignmentSnapshot {
  selectedSaleIds: unknown
}

// The implementation must query durable snapshots by selectedSaleIds, without
// date, status or driver restrictions, and return every matching snapshot.
export interface AssignmentGuard {
  readIndexes: () => Promise<unknown>
  readCollectionOptions: () => Promise<unknown>
  readAssignedSnapshots: (saleIds: readonly string[]) => Promise<AssignmentSnapshot[]>
}

export const assignmentGuard: AssignmentGuard = {
  readIndexes: async () => await RoutePlanModel.collection.listIndexes().toArray(),
  readCollectionOptions: async () => {
    const db = RoutePlanModel.db.db
    if (db === undefined) throw new Error('Database unavailable')
    return await db.collection(RoutePlanModel.collection.name).options()
  },
  readAssignedSnapshots: async (saleIds) => {
    const snapshots: AssignmentSnapshot[] = []
    for (let offset = 0; offset < saleIds.length; offset += 500) {
      const batch = saleIds.slice(offset, offset + 500)
      const remaining = new Set(batch)
      const cursor = RoutePlanModel.collection.find({ selectedSaleIds: { $in: batch } }, { projection: { selectedSaleIds: 1 }, batchSize: 500 })
      for await (const row of cursor) {
        if (!Array.isArray(row.selectedSaleIds) || row.selectedSaleIds.length === 0 || row.selectedSaleIds.some((id: unknown) => !canonical(id))) throw new AssignmentSafetyError('Assignment snapshot is malformed')
        for (const id of row.selectedSaleIds as string[]) {
          if (remaining.delete(id)) snapshots.push({ selectedSaleIds: [id] })
        }
        if (remaining.size === 0) break
      }
    }
    return snapshots
  }
}

export interface AssignmentStop {
  saleIds: readonly string[]
}

export interface AssignmentCandidate {
  saleId: string
}

export class AssignmentSafetyError extends Error {
  constructor (message: string) {
    super(message)
    this.name = 'AssignmentSafetyError'
  }
}

export class AssignmentConflictError extends Error {
  constructor () {
    super('One or more sales have already been assigned; refresh and retry')
    this.name = 'AssignmentConflictError'
  }
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const canonical = (id: unknown): id is string => typeof id === 'string' && /^[a-f0-9]{24}$/.test(id)

// This verifies the catalog, not the historical-data audit. Operators must
// audit before rollout and quiesce old/raw writers throughout and afterwards.
export async function assertAssignmentIndex (guard: AssignmentGuard): Promise<void> {
  let indexes: unknown
  let options: unknown
  try {
    ;[indexes, options] = await Promise.all([guard.readIndexes(), guard.readCollectionOptions()])
  } catch {
    throw new AssignmentSafetyError('Assignment index verification unavailable')
  }
  if (!record(options) || Object.prototype.hasOwnProperty.call(options, 'collation') || !Array.isArray(indexes)) {
    throw new AssignmentSafetyError('Assignment index or collection options are unverified')
  }
  const names = new Set<string>()
  let found = false
  for (const value of indexes as unknown[]) {
    if (!record(value) || typeof value.name !== 'string' || names.has(value.name) || !record(value.key) || Object.keys(value.key).length === 0) {
      throw new AssignmentSafetyError('Assignment index catalog is invalid')
    }
    names.add(value.name)
    if (value.name === ASSIGNMENT_INDEX_NAME) {
      const allowed = new Set(['name', 'key', 'unique', 'sparse', 'v', 'ns'])
      if (Object.keys(value).some((key) => !allowed.has(key)) || value.unique !== true || value.sparse !== true || Object.keys(value.key).length !== 1 || value.key.reservedSaleIds !== 1) {
        throw new AssignmentSafetyError('Assignment index is incompatible')
      }
      found = true
    } else if (Object.keys(value.key).some((key) => key === 'reservedSaleIds' || key.startsWith('reservedSaleIds.') || key.includes('$**'))) {
      throw new AssignmentSafetyError('Assignment index catalog is incompatible')
    }
  }
  if (!found) throw new AssignmentSafetyError('Assignment index is missing')
}

export function validateAssignmentSelection (saleIds: readonly string[], stops: readonly AssignmentStop[]): void {
  if (!Array.isArray(saleIds) || saleIds.length === 0 || saleIds.some((id) => !canonical(id)) || new Set(saleIds).size !== saleIds.length || !Array.isArray(stops) || stops.length === 0) {
    throw new AssignmentSafetyError('Invalid assignment selection')
  }
  const selected = new Set(saleIds)
  const covered = new Set<string>()
  for (const stop of stops) {
    if (!record(stop) || !Array.isArray(stop.saleIds) || stop.saleIds.length === 0) throw new AssignmentSafetyError('Invalid assignment stops')
    for (const id of stop.saleIds as unknown[]) {
      if (!canonical(id) || !selected.has(id) || covered.has(id)) throw new AssignmentSafetyError('Invalid assignment stop coverage')
      covered.add(id)
    }
  }
  if (covered.size !== selected.size) throw new AssignmentSafetyError('Invalid assignment stop coverage')
}

export async function unassignedCandidates<T extends AssignmentCandidate> (guard: AssignmentGuard, candidates: readonly T[]): Promise<T[]> {
  if (candidates.some((candidate) => !canonical(candidate.saleId))) throw new AssignmentSafetyError('Invalid candidate sale ID')
  const ids = [...new Set(candidates.map((candidate) => candidate.saleId))]
  if (ids.length === 0) return []
  const snapshots = await guard.readAssignedSnapshots(ids)
  if (!Array.isArray(snapshots)) throw new AssignmentSafetyError('Assignment snapshots are unverified')
  const assigned = new Set<string>()
  for (const snapshot of snapshots) {
    if (!record(snapshot) || !Array.isArray(snapshot.selectedSaleIds) || snapshot.selectedSaleIds.length === 0 || snapshot.selectedSaleIds.some((id: unknown) => !canonical(id))) {
      throw new AssignmentSafetyError('Assignment snapshot is malformed')
    }
    for (const id of snapshot.selectedSaleIds as string[]) assigned.add(id)
  }
  return candidates.filter((candidate) => !assigned.has(candidate.saleId))
}

export function isDuplicateIndexError (error: unknown, field: string, indexName: string): boolean {
  if (!(error instanceof mongo.MongoServerError) || error.code !== 11000) return false
  if (error.keyPattern !== undefined) return record(error.keyPattern) && Object.keys(error.keyPattern).length === 1 && error.keyPattern[field] === 1
  // Only parse the server's anchored index token, never text in a duplicate key.
  // Reject oversized or unexpected messages rather than guessing.
  if (error.message.length > 4096) return false
  const match = /^E11000 duplicate key error collection: [^\s]{1,255} index: ([^\s]{1,127}) dup key: /.exec(error.message)
  return match?.[1] === indexName
}

export function throwAssignmentWriteError (error: unknown): never {
  if (isDuplicateIndexError(error, 'reservedSaleIds', ASSIGNMENT_INDEX_NAME)) {
    throw new AssignmentConflictError()
  }
  throw error
}
