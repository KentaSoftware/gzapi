// Manual preflight only. No connection, CLI, startup hook, or document writes.
// Quiesce all old/raw writers throughout audit, index creation and rollout.
// This helper does not implement the runtime historical-assignment gate.
export const INDEX_NAME = 'routeplan_reserved_sale_ids_unique'

export interface Snapshot {
  _id: unknown
  selectedSaleIds?: unknown
  reservedSaleIds?: unknown
  stops?: unknown
}

export interface IndexDescription {
  name?: unknown
  key?: unknown
  [option: string]: unknown
}

export interface AssignmentIndexAdapter {
  // Must stream all snapshots, with no filtering or pagination limit.
  readSnapshots: () => AsyncIterable<Snapshot>
  readIndexes: () => Promise<IndexDescription[]>
  readCollectionOptions: () => Promise<unknown>
  createIndex: () => Promise<void>
}

interface SnapshotProjection {
  _id: 1
  selectedSaleIds: 1
  reservedSaleIds: 1
  stops: 1
}

export interface AssignmentCollection {
  find: (filter: Record<string, never>, options: { projection: SnapshotProjection }) => AsyncIterable<Snapshot>
  listIndexes: () => { toArray: () => Promise<IndexDescription[]> }
  options: () => Promise<unknown>
  createIndex: (key: { reservedSaleIds: 1 }, options: { name: string, unique: true, sparse: true }) => Promise<unknown>
}

export function assignmentCollectionAdapter (collection: AssignmentCollection): AssignmentIndexAdapter {
  return {
    readSnapshots: () => collection.find({}, { projection: { _id: 1, selectedSaleIds: 1, reservedSaleIds: 1, stops: 1 } }),
    readIndexes: async () => await collection.listIndexes().toArray(),
    readCollectionOptions: async () => await collection.options(),
    createIndex: async () => { await collection.createIndex({ reservedSaleIds: 1 }, { name: INDEX_NAME, unique: true, sparse: true }) }
  }
}

export interface AssignmentAudit {
  clean: boolean
  snapshots: number
  invalidSelected: number
  invalidStops: number
  unexpectedReserved: number
}

function record (value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function canonical (value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{24}$/.test(value)
}

function canonicalSet (value: unknown): Set<string> | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined
  const ids = new Set<string>()
  for (const id of value as unknown[]) {
    if (!canonical(id) || ids.has(id)) return undefined
    ids.add(id)
  }
  return ids
}

function validStops (value: unknown, selected: Set<string> | undefined): boolean {
  if (!Array.isArray(value) || value.length === 0) return false
  const ids = new Set<string>()
  for (const stop of value as unknown[]) {
    if (!record(stop)) return false
    const hasSingle = Object.prototype.hasOwnProperty.call(stop, 'saleId')
    const hasGroup = Object.prototype.hasOwnProperty.call(stop, 'saleIds')
    if (hasSingle === hasGroup) return false
    const group = canonicalSet(hasSingle ? [stop.saleId] : stop.saleIds)
    if (group === undefined) return false
    for (const id of group) {
      if (ids.has(id)) return false
      ids.add(id)
    }
  }
  return selected !== undefined && ids.size === selected.size && [...ids].every((id) => selected.has(id))
}

// Memory is bounded by one snapshot, not by the total number of sales.
// Cross-snapshot historical duplicates are deliberately neither stored nor blocked.
export async function auditAssignments (snapshots: AsyncIterable<Snapshot>): Promise<AssignmentAudit> {
  const audit: AssignmentAudit = { clean: true, snapshots: 0, invalidSelected: 0, invalidStops: 0, unexpectedReserved: 0 }
  for await (const snapshot of snapshots) {
    audit.snapshots++
    const selected = canonicalSet(snapshot.selectedSaleIds)
    if (selected === undefined) audit.invalidSelected++
    if (!validStops(snapshot.stops, selected)) audit.invalidStops++
    // This pre-rollout helper cannot classify existing reservations as safe.
    if (Object.prototype.hasOwnProperty.call(snapshot, 'reservedSaleIds')) audit.unexpectedReserved++
  }
  audit.clean = audit.invalidSelected === 0 && audit.invalidStops === 0 && audit.unexpectedReserved === 0
  return audit
}

function compatibleIndex (index: IndexDescription): boolean {
  const allowed = new Set(['name', 'key', 'unique', 'sparse', 'v', 'ns'])
  if (Object.keys(index).some((option) => !allowed.has(option))) return false
  if (index.name !== INDEX_NAME || index.unique !== true || index.sparse !== true || !record(index.key)) return false
  return Object.keys(index.key).length === 1 && index.key.reservedSaleIds === 1
}

function catalogState (indexes: IndexDescription[]): { compatible: boolean, exists: boolean } {
  let exists = false
  const names = new Set<string>()
  for (const index of indexes) {
    if (!record(index) || typeof index.name !== 'string' || names.has(index.name) || !record(index.key) || Object.keys(index.key).length === 0) return { compatible: false, exists: false }
    names.add(index.name)
    if (index.name === INDEX_NAME) {
      if (!compatibleIndex(index)) return { compatible: false, exists: false }
      exists = true
    } else if (Object.keys(index.key).some((key) => key === 'reservedSaleIds' || key.startsWith('reservedSaleIds.') || key.includes('$**'))) {
      return { compatible: false, exists: false }
    }
  }
  return { compatible: true, exists }
}

const STATUS = { PREVIEW: 'preview', BLOCKED: 'blocked', CREATED: 'created', EXISTING: 'existing' } as const
type MigrationStatus = (typeof STATUS)[keyof typeof STATUS]

export interface MigrationResult {
  status: MigrationStatus
  audit: AssignmentAudit
  incompatibleCatalog: boolean
}

// Supply only a local, explicitly authorized adapter. This module cannot
// determine whether a supplied adapter connects to a remote or production DB.
export async function migrateAssignmentIndex (adapter: AssignmentIndexAdapter, apply = false): Promise<MigrationResult> {
  const audit = await auditAssignments(adapter.readSnapshots())
  const options = await adapter.readCollectionOptions()
  const catalog = catalogState(await adapter.readIndexes())
  // Reject any explicit collection collation, including simple, conservatively.
  const incompatibleCatalog = !record(options) || Object.prototype.hasOwnProperty.call(options, 'collation') || !catalog.compatible
  if (!audit.clean || incompatibleCatalog) return { status: STATUS.BLOCKED, audit, incompatibleCatalog }
  if (catalog.exists) return { status: STATUS.EXISTING, audit, incompatibleCatalog }
  if (!apply) return { status: STATUS.PREVIEW, audit, incompatibleCatalog }
  await adapter.createIndex()
  const verifiedOptions = await adapter.readCollectionOptions()
  const verified = catalogState(await adapter.readIndexes())
  if (!record(verifiedOptions) || Object.prototype.hasOwnProperty.call(verifiedOptions, 'collation') || !verified.compatible || !verified.exists) throw new Error('Assignment index verification failed')
  return { status: STATUS.CREATED, audit, incompatibleCatalog }
}
