import { type Db, type Document } from 'mongodb'

import { MigrationSafetyError, withTargetDatabase } from './phase-0-helpers'
import { assertStockMutationProofs, parseStockMigrationArguments, printStockArtifact, STOCK_MIGRATION_IDS, verifyExpectedStockIndexes } from './stock-helpers'

export interface StockInvariantVerification {
  passed: boolean
  failures: string[]
  productsChecked: number
  movementsChecked: number
  bucketsChecked: number
}

function isNonNegativeInteger (value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isPositiveInteger (value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

export async function verifyStockProjectionInvariants (db: Db): Promise<StockInvariantVerification> {
  const names = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map((entry) => entry.name))
  const required = ['products', 'inventorymovements', 'stockexpirybuckets']
  const failures = required.filter((name) => !names.has(name)).map((name) => `Missing collection ${name}`)
  if (failures.length > 0) return { passed: false, failures, productsChecked: 0, movementsChecked: 0, bucketsChecked: 0 }

  const products = await db.collection<Document>('products').find({}, { projection: { _id: 1, stock: 1, inventory: 1 } }).toArray()
  const productIds = new Set(products.map((product) => String(product._id)))
  for (const product of products) {
    if (!isNonNegativeInteger(product.stock)) failures.push(`Product ${String(product._id)} has an invalid physical stock projection`)
  }

  const movements = await db.collection<Document>('inventorymovements').find({}, { projection: { productId: 1, quantity: 1, idempotencyKey: 1 } }).toArray()
  const idempotencyKeys = new Set<string>()
  for (const movement of movements) {
    if (!isPositiveInteger(movement.quantity)) failures.push(`Movement ${String(movement._id)} has a non-positive quantity`)
    const productId = String(movement.productId)
    if (!productIds.has(productId)) failures.push(`Movement ${String(movement._id)} references missing product ${productId}`)
    const key = String(movement.idempotencyKey)
    if (idempotencyKeys.has(key)) failures.push(`Duplicate movement idempotency key ${key}`)
    idempotencyKeys.add(key)
  }

  const buckets = await db.collection<Document>('stockexpirybuckets').find({}, { projection: { productId: 1, receivedQuantity: 1, availableQuantity: 1, committedQuantity: 1 } }).toArray()
  const bucketReceivedTotals = new Map<string, number>()
  for (const bucket of buckets) {
    const received = bucket.receivedQuantity
    const available = bucket.availableQuantity
    const committed = bucket.committedQuantity
    if (!isNonNegativeInteger(received) || !isNonNegativeInteger(available) || !isNonNegativeInteger(committed) || Number(available) + Number(committed) > Number(received)) failures.push(`Expiry bucket ${String(bucket._id)} has invalid quantity invariants`)
    const productId = String(bucket.productId)
    if (!productIds.has(productId)) failures.push(`Expiry bucket ${String(bucket._id)} references missing product ${productId}`)
    if (isNonNegativeInteger(received)) bucketReceivedTotals.set(productId, (bucketReceivedTotals.get(productId) ?? 0) + received)
  }

  for (const product of products) {
    if (product.inventory?.expiryTracking !== 'TRACKED') continue
    const bucketTotal = bucketReceivedTotals.get(String(product._id)) ?? 0
    if (bucketTotal !== product.stock) failures.push(`Product ${String(product._id)} has stock ${String(product.stock)} but tracked expiry buckets total ${bucketTotal}`)
  }

  return { passed: failures.length === 0, failures, productsChecked: products.length, movementsChecked: movements.length, bucketsChecked: buckets.length }
}

export async function runStockVerification (argv: string[]): Promise<void> {
  const options = parseStockMigrationArguments(argv)
  if (options.dryRun) {
    printStockArtifact(STOCK_MIGRATION_IDS.VERIFY, 'dry-run', options.uri, { plannedActions: ['verify Stock collections', 'verify expected Stock indexes', 'verify product physical projections', 'verify ledger references and quantities'], businessDataMutated: false })
    return
  }
  await assertStockMutationProofs(options)
  const result = await withTargetDatabase(options.uri, async (db) => {
    const indexes = await verifyExpectedStockIndexes(db)
    const invariants = await verifyStockProjectionInvariants(db)
    return { indexes, invariants }
  })
  const failures = result.indexes.missingCollections.concat(result.indexes.missingIndexes, result.invariants.failures)
  const passed = result.indexes.passed && result.invariants.passed
  printStockArtifact(STOCK_MIGRATION_IDS.VERIFY, passed ? 'passed' : 'failed', options.uri, { passed, failures, indexes: result.indexes, invariants: result.invariants, businessDataMutated: false })
  if (!passed) throw new MigrationSafetyError(`Stock verification failed: ${failures.join(', ')}`)
}

if (require.main === module) void runStockVerification(process.argv.slice(2)).catch((error: unknown) => { process.stderr.write(`${error instanceof Error ? error.message : 'Migration failed'}\n`); process.exitCode = 1 })
