const BACKFILL_ACTOR = 'route-plan-004-backfill'
const DEFAULT_BATCH_SIZE = 100
const OPERATIONAL_STATUSES = ['PENDING', 'IN_PROGRESS', 'COMPLETED'] as const

type LegacyOperationalStatus = (typeof OPERATIONAL_STATUSES)[number]

export interface LegacySale {
  _id: unknown
  delivery?: { status?: string }
  updatedAt?: Date | number
}

export interface LegacySnapshot {
  _id: unknown
  selectedSaleIds?: string[]
  audit?: { createdAt?: Date }
}

export interface LegacyOperationalProjection {
  snapshotId: string
  status: LegacyOperationalStatus
  sourceDeliveryVersion: number
  assignments: Record<string, never>
  history: Array<{
    status: LegacyOperationalStatus
    changedBy: string
    changedAt: Date
    version: number
  }>
  version: number
  updatedBy: string
  stale: false
}

interface MongoCursor<T> {
  sort: (keys: Record<string, number>) => MongoCursor<T>
  limit: (value: number) => MongoCursor<T>
  toArray: () => Promise<T[]>
}

interface MongoCollection {
  find: (filter: Record<string, unknown>, projection?: Record<string, number>) => MongoCursor<LegacySnapshot> | MongoCursor<LegacySale>
  updateOne: (filter: Record<string, unknown>, update: Record<string, unknown>, options: { upsert: boolean }) => Promise<unknown>
}

export interface BackfillDatabase {
  getCollection: (name: string) => MongoCollection
}

export interface BackfillOptions {
  batchSize?: number
  checkpoint?: unknown
  now?: Date
}

export interface BackfillResult {
  processed: number
  checkpoint: unknown | null
  complete: boolean
}

declare const db: BackfillDatabase
declare const ObjectId: { new (value: string): unknown }

const isOperationalStatus = (value: string | undefined): value is LegacyOperationalStatus =>
  value !== undefined && (OPERATIONAL_STATUSES as readonly string[]).includes(value)

const toDeliveryVersion = (sale: LegacySale): number => {
  if (sale.updatedAt instanceof Date) return sale.updatedAt.getTime()
  if (typeof sale.updatedAt === 'number' && Number.isFinite(sale.updatedAt)) return sale.updatedAt
  return 0
}

export const resolveLegacyOperationalStatus = (snapshot: LegacySnapshot, sales: LegacySale[]): LegacyOperationalStatus => {
  const saleIds = snapshot.selectedSaleIds ?? []
  const saleById = new Map(sales.map((sale) => [String(sale._id), sale]))
  const statuses = saleIds.map((saleId) => saleById.get(saleId)?.delivery?.status)

  // Missing sales or delivery facts are not evidence that a route completed.
  if (saleIds.length === 0 || statuses.some((status) => !isOperationalStatus(status))) return 'PENDING'
  if (statuses.every((status) => status === 'COMPLETED')) return 'COMPLETED'
  if (statuses.some((status) => status === 'COMPLETED')) return 'IN_PROGRESS'
  return 'PENDING'
}

export const buildLegacyOperationalProjection = (
  snapshot: LegacySnapshot,
  sales: LegacySale[],
  now: Date = new Date()
): LegacyOperationalProjection => {
  const status = resolveLegacyOperationalStatus(snapshot, sales)
  const createdAt = snapshot.audit?.createdAt ?? now
  const sourceDeliveryVersion = sales.reduce((latest, sale) => Math.max(latest, toDeliveryVersion(sale)), 0)

  return {
    snapshotId: String(snapshot._id),
    status,
    sourceDeliveryVersion,
    assignments: {},
    history: [{ status, changedBy: BACKFILL_ACTOR, changedAt: createdAt, version: 1 }],
    version: 1,
    updatedBy: BACKFILL_ACTOR,
    stale: false
  }
}

export const getNextBackfillCheckpoint = (snapshots: ReadonlyArray<{ _id: unknown }>): unknown | null =>
  snapshots.length === 0 ? null : snapshots[snapshots.length - 1]._id

const asDatabaseId = (value: string): unknown => {
  if (typeof ObjectId !== 'undefined' && /^[a-f\d]{24}$/i.test(value)) return new ObjectId(value)
  return value
}

export const runRouteDashboardBackfill = async (
  database: BackfillDatabase,
  options: BackfillOptions = {}
): Promise<BackfillResult> => {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE
  if (!Number.isInteger(batchSize) || batchSize < 1) throw new RangeError('batchSize must be a positive integer')

  const snapshotsCollection = database.getCollection('routeplans')
  const operationalsCollection = database.getCollection('routeplanoperationals')
  const snapshots = await snapshotsCollection
    .find(options.checkpoint === undefined ? {} : { _id: { $gt: options.checkpoint } })
    .sort({ _id: 1 })
    .limit(batchSize)
    .toArray() as LegacySnapshot[]

  for (const snapshot of snapshots) {
    const selectedSaleIds = snapshot.selectedSaleIds ?? []
    const sales = selectedSaleIds.length === 0
      ? []
      : await database.getCollection('sales')
        .find({ _id: { $in: selectedSaleIds.map(asDatabaseId) } })
        .toArray() as LegacySale[]
    const projection = buildLegacyOperationalProjection(snapshot, sales, options.now)

    // setOnInsert makes the migration resumable and protects operational history
    // or later assignments if the migration is rerun after a partial checkpoint.
    await operationalsCollection.updateOne(
      { snapshotId: projection.snapshotId },
      { $setOnInsert: projection },
      { upsert: true }
    )
  }

  const checkpoint = getNextBackfillCheckpoint(snapshots)
  return { processed: snapshots.length, checkpoint, complete: snapshots.length < batchSize }
}

if (typeof db !== 'undefined') {
  void runRouteDashboardBackfill(db)
}
