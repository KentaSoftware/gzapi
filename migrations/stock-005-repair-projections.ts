import { ObjectId, type ClientSession, type Db, type Document } from 'mongodb'

import { MigrationSafetyError } from './phase-0-helpers'
import {
  assertEnvelopeMatchesCli,
  assertStockMutationProofs,
  buildStockMovementDocument,
  buildProjectionRepairPlan,
  movementSemanticsMatch,
  parseProjectionRepairInput,
  parseStockMigrationArguments,
  printStockArtifact,
  readInputFile,
  STOCK_MIGRATION_IDS,
  withStockTransaction,
  type ProjectionRepairEnvelope,
  type ProjectionRepairPlan
} from './stock-helpers'

export interface ProjectionRepairApplyResult {
  plan: ProjectionRepairPlan
  updatedProducts: number
  insertedMovements: number
  alreadyAppliedMovements: number
}

async function assertProductsExist (db: Db, envelope: ProjectionRepairEnvelope, session: ClientSession): Promise<void> {
  const ids = envelope.repairs.map((repair) => new ObjectId(repair.productId))
  const products = await db.collection<Document>('products').find({ _id: { $in: ids } }, { session, projection: { _id: 1 } }).toArray()
  const existing = new Set(products.map((product) => String(product._id)))
  const missing = ids.map((id) => id.toHexString()).filter((id) => !existing.has(id))
  if (missing.length > 0) throw new MigrationSafetyError(`Projection repair references missing products: ${missing.join(', ')}`)
}

export async function applyProjectionRepairPlan (db: Db, session: ClientSession, envelope: ProjectionRepairEnvelope, now: Date, rulesVersion: string): Promise<ProjectionRepairApplyResult> {
  await assertProductsExist(db, envelope, session)
  const plan = buildProjectionRepairPlan(envelope, rulesVersion)
  const products = db.collection<Document>('products')
  for (const repair of plan.updates) {
    await products.updateOne({ _id: new ObjectId(repair.productId) }, { $set: { stock: repair.physicalQuantity } }, { session })
  }

  const movements = db.collection<Document>('inventorymovements')
  let insertedMovements = 0
  let alreadyAppliedMovements = 0
  for (const movement of plan.movements) {
    const document = buildStockMovementDocument(movement, now)
    const existingMovement = await movements.findOne({ idempotencyKey: movement.idempotencyKey }, { session })
    if (existingMovement !== null) {
      if (!movementSemanticsMatch(existingMovement, document)) throw new MigrationSafetyError(`Conflicting movement semantics for idempotency key ${movement.idempotencyKey}`)
      alreadyAppliedMovements += 1
      continue
    }
    await movements.insertOne(document, { session })
    insertedMovements += 1
  }
  return { plan, updatedProducts: plan.updates.length, insertedMovements, alreadyAppliedMovements }
}

export async function runRepairProjections (argv: string[]): Promise<void> {
  const options = parseStockMigrationArguments(argv)
  if (options.input === undefined || options.input === '') throw new MigrationSafetyError('Projection repair requires --input')
  const envelope = parseProjectionRepairInput(await readInputFile(options.input))
  assertEnvelopeMatchesCli(envelope, options)
  const rulesVersion = options.rulesVersion ?? 'stock-migration-v1'
  const plan = buildProjectionRepairPlan(envelope, rulesVersion)
  if (options.dryRun) {
    printStockArtifact(STOCK_MIGRATION_IDS.PROJECTIONS, 'dry-run', options.uri, { approvalId: envelope.approvalId, approvedBy: envelope.approvedBy, explicitUpdates: plan.updates, plannedMovements: plan.movements, businessDataMutated: false })
    return
  }
  await assertStockMutationProofs(options)
  const result = await withStockTransaction(options.uri, async (db, session) => await applyProjectionRepairPlan(db, session, envelope, new Date(), rulesVersion))
  printStockArtifact(STOCK_MIGRATION_IDS.PROJECTIONS, 'passed', options.uri, { approvalId: envelope.approvalId, approvedBy: envelope.approvedBy, ...result })
}

if (require.main === module) void runRepairProjections(process.argv.slice(2)).catch((error: unknown) => { process.stderr.write(`${error instanceof Error ? error.message : 'Migration failed'}\n`); process.exitCode = 1 })
