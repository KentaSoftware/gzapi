import { ObjectId, type ClientSession, type Db, type Document } from 'mongodb'

import { MigrationSafetyError } from './phase-0-helpers'
import {
  assertEnvelopeMatchesCli,
  assertStockMutationProofs,
  buildStockMovementDocument,
  buildOpeningCountPlan,
  movementSemanticsMatch,
  parseOpeningCountInput,
  parseStockMigrationArguments,
  printStockArtifact,
  readInputFile,
  STOCK_MIGRATION_IDS,
  withStockTransaction,
  type OpeningCountEnvelope,
  type OpeningCountPlan,
  type StockMigrationOptions
} from './stock-helpers'

export interface OpeningCountApplyResult {
  plan: OpeningCountPlan
  updatedProducts: number
  upsertedBuckets: number
  insertedMovements: number
  alreadyAppliedMovements: number
}

function toExpiryDate (expiryDate: string): Date {
  return new Date(`${expiryDate}T00:00:00.000Z`)
}

async function assertProductsExist (db: Db, envelope: OpeningCountEnvelope, session: ClientSession): Promise<void> {
  const ids = envelope.rows.map((row) => new ObjectId(row.productId))
  const products = await db.collection<Document>('products').find({ _id: { $in: ids } }, { session, projection: { _id: 1 } }).toArray()
  const existing = new Set(products.map((product) => String(product._id)))
  const missing = ids.map((id) => id.toHexString()).filter((id) => !existing.has(id))
  if (missing.length > 0) throw new MigrationSafetyError(`Opening-count references missing products: ${missing.join(', ')}`)
}

export async function applyOpeningCountPlan (db: Db, session: ClientSession, envelope: OpeningCountEnvelope, now: Date, rulesVersion: string): Promise<OpeningCountApplyResult> {
  await assertProductsExist(db, envelope, session)
  const plan = buildOpeningCountPlan(envelope, rulesVersion)
  const bucketCollection = db.collection<Document>('stockexpirybuckets')
  const movementCollection = db.collection<Document>('inventorymovements')
  let upsertedBuckets = 0
  let alreadyAppliedMovements = 0

  const affectedProductIds = plan.groupedTotals.map((total) => new ObjectId(total.productId))
  const existingBuckets = await bucketCollection.find({ productId: { $in: affectedProductIds } }, { session }).toArray()
  for (const bucket of existingBuckets) {
    if (bucket.committedQuantity !== undefined && bucket.committedQuantity !== null && Number(bucket.committedQuantity) !== 0) {
      const expiry = bucket.expiryDate instanceof Date ? bucket.expiryDate.toISOString() : 'unknown expiry'
      throw new MigrationSafetyError(`Opening count cannot overwrite committed quantity for ${String(bucket.productId)} at ${expiry}`)
    }
  }

  for (const bucket of existingBuckets) {
    const bucketFilter = bucket._id === undefined
      ? { productId: bucket.productId, expiryDate: bucket.expiryDate }
      : { _id: bucket._id }
    await bucketCollection.updateOne(bucketFilter, { $set: { receivedQuantity: 0, availableQuantity: 0, committedQuantity: 0, updatedAt: now } }, { session })
  }

  for (const row of envelope.rows) {
    if (row.expiryDate === null) continue
    const bucketFilter = { productId: new ObjectId(row.productId), expiryDate: toExpiryDate(row.expiryDate) }
    const existingBucket = await bucketCollection.findOne(bucketFilter, { session, projection: { committedQuantity: 1 } })
    if (existingBucket !== null && existingBucket.committedQuantity !== 0) throw new MigrationSafetyError(`Opening count cannot overwrite committed quantity for ${row.productId} at ${row.expiryDate}`)
    const result = await bucketCollection.updateOne(
      bucketFilter,
      {
        $set: { receivedQuantity: row.countedQuantity, availableQuantity: row.countedQuantity, updatedAt: now },
        $setOnInsert: { committedQuantity: 0, createdAt: now }
      },
      { upsert: true, session }
    )
    if (result.upsertedCount === 1) upsertedBuckets += 1
  }

  for (const total of plan.groupedTotals) {
    await db.collection<Document>('products').updateOne(
      { _id: new ObjectId(total.productId) },
      {
        $set: {
          stock: total.countedQuantity,
          'inventory.baselineStatus': 'RECONCILED',
          'inventory.lastReconciledAt': now,
          'inventory.lastReconciledBy': new ObjectId(envelope.approvedBy)
        }
      },
      { session }
    )
  }

  let insertedMovements = 0
  for (const movement of plan.movements) {
    let expiryBucketId: ObjectId | undefined
    if (movement.expiryDate !== null) {
      const bucket = await bucketCollection.findOne({ productId: new ObjectId(movement.productId), expiryDate: toExpiryDate(movement.expiryDate) }, { session, projection: { _id: 1 } })
      if (bucket?._id === undefined) throw new MigrationSafetyError(`Unable to resolve expiry bucket for ${movement.productId}`)
      expiryBucketId = bucket._id
    }
    const document = buildStockMovementDocument(movement, now, expiryBucketId)
    const existingMovement = await movementCollection.findOne({ idempotencyKey: movement.idempotencyKey }, { session })
    if (existingMovement !== null) {
      if (!movementSemanticsMatch(existingMovement, document)) throw new MigrationSafetyError(`Conflicting movement semantics for idempotency key ${movement.idempotencyKey}`)
      alreadyAppliedMovements += 1
      continue
    }
    await movementCollection.insertOne(document, { session })
    insertedMovements += 1
  }
  return { plan, updatedProducts: plan.groupedTotals.length, upsertedBuckets, insertedMovements, alreadyAppliedMovements }
}

function inputFormat (options: StockMigrationOptions): 'json' | 'csv' {
  if (options.format === 'json' || options.format === 'csv') return options.format
  return options.input?.toLowerCase().endsWith('.csv') === true ? 'csv' : 'json'
}

export async function runApplyOpeningCount (argv: string[]): Promise<void> {
  const options = parseStockMigrationArguments(argv)
  if (options.input === undefined || options.input === '') throw new MigrationSafetyError('Opening-count application requires --input')
  const content = await readInputFile(options.input)
  const format = inputFormat(options)
  const envelope = parseOpeningCountInput(format === 'csv' ? content : content, format, format === 'csv' ? (options.approvedBy === undefined ? undefined : { approvedBy: options.approvedBy, approvalId: options.approvalId }) : undefined)
  assertEnvelopeMatchesCli(envelope, options)
  const rulesVersion = options.rulesVersion ?? 'stock-migration-v1'
  const plan = buildOpeningCountPlan(envelope, rulesVersion)
  if (options.dryRun) {
    printStockArtifact(STOCK_MIGRATION_IDS.OPENING_COUNT, 'dry-run', options.uri, { approvalId: envelope.approvalId, approvedBy: envelope.approvedBy, groupedTotals: plan.groupedTotals, plannedMovements: plan.movements, businessDataMutated: false })
    return
  }
  await assertStockMutationProofs(options)
  const result = await withStockTransaction(options.uri, async (db, session) => await applyOpeningCountPlan(db, session, envelope, new Date(), rulesVersion))
  printStockArtifact(STOCK_MIGRATION_IDS.OPENING_COUNT, 'passed', options.uri, { approvalId: envelope.approvalId, approvedBy: envelope.approvedBy, ...result })
}

if (require.main === module) void runApplyOpeningCount(process.argv.slice(2)).catch((error: unknown) => { process.stderr.write(`${error instanceof Error ? error.message : 'Migration failed'}\n`); process.exitCode = 1 })
