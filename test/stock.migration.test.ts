import { expect } from 'chai'
import { ObjectId, type ClientSession, type Db, type Document } from 'mongodb'
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { resolve } from 'path'

import packageJson from '../package.json'

import { EXPECTED_STOCK_INDEXES, parseStockMigrationArguments, parseOpeningCountInput, buildOpeningCountPlan, buildOpeningTemplate, parseProjectionRepairInput, buildProjectionRepairPlan, stockArtifact, assertStockMutationProofs, collectStockPreflight, createStockIndexes, type StockMigrationOptions } from '../migrations/stock-helpers'
import { applyOpeningCountPlan, runApplyOpeningCount } from '../migrations/stock-004-apply-opening-count'
import { applyProjectionRepairPlan, runRepairProjections } from '../migrations/stock-005-repair-projections'
import { runStockIndexes } from '../migrations/stock-002-create-indexes'
import { runStockPreflight } from '../migrations/stock-001-preflight'
import { runOpeningCountTemplate } from '../migrations/stock-003-opening-count-template'
import { runStockVerification, verifyStockProjectionInvariants } from '../migrations/stock-006-verify'

const PRODUCT_ID = new ObjectId().toHexString()
const ACTOR_ID = new ObjectId().toHexString()

const STOCK_MIGRATION_SCRIPTS = {
  'migration:stock:preflight': 'migrations/stock-001-preflight.ts',
  'migration:stock:indexes': 'migrations/stock-002-create-indexes.ts',
  'migration:stock:opening-template': 'migrations/stock-003-opening-count-template.ts',
  'migration:stock:opening-count': 'migrations/stock-004-apply-opening-count.ts',
  'migration:stock:repair-projections': 'migrations/stock-005-repair-projections.ts',
  'migration:stock:verify': 'migrations/stock-006-verify.ts'
} as const

type FakeDocument = Document & { _id?: ObjectId }

function sameValue (left: unknown, right: unknown): boolean {
  if (left instanceof ObjectId && right instanceof ObjectId) return left.equals(right)
  if (left instanceof Date && right instanceof Date) return left.getTime() === right.getTime()
  return left === right
}

function matches (document: FakeDocument, filter: Document): boolean {
  return Object.entries(filter).every(([field, expected]) => {
    const actual = document[field]
    if (expected !== null && typeof expected === 'object' && '$in' in expected) {
      const values = expected.$in
      return Array.isArray(values) && values.some((value) => sameValue(actual, value))
    }
    return sameValue(actual, expected)
  })
}

class CollectionDouble {
  readonly docs: FakeDocument[]
  readonly indexList: Document[]
  readonly indexCalls: Array<{ keys: Document, options: Document }> = []
  updateCalls = 0
  insertCalls = 0

  constructor (docs: FakeDocument[] = [], indexes: Document[] = []) {
    this.docs = docs
    this.indexList = indexes
  }

  async countDocuments (): Promise<number> {
    return this.docs.length
  }

  async indexes (): Promise<Document[]> {
    return this.indexList
  }

  find (filter: Document): { toArray: () => Promise<FakeDocument[]> } {
    return { toArray: async () => this.docs.filter((document) => matches(document, filter)) }
  }

  async findOne (filter: Document): Promise<FakeDocument | null> {
    return this.docs.find((document) => matches(document, filter)) ?? null
  }

  async updateOne (filter: Document, update: Document): Promise<{ upsertedCount: number }> {
    this.updateCalls += 1
    const document = this.docs.find((entry) => matches(entry, filter))
    if (document === undefined) {
      const inserted: FakeDocument = { _id: new ObjectId(), ...filter }
      const setOnInsert = update.$setOnInsert
      if (setOnInsert !== null && typeof setOnInsert === 'object') Object.assign(inserted, setOnInsert)
      const set = update.$set
      if (set !== null && typeof set === 'object') Object.assign(inserted, set)
      this.docs.push(inserted)
      return { upsertedCount: 1 }
    }
    const set = update.$set
    if (set !== null && typeof set === 'object') Object.assign(document, set)
    return { upsertedCount: 0 }
  }

  async insertOne (document: Document): Promise<void> {
    this.insertCalls += 1
    this.docs.push({ ...document })
  }

  async createIndex (keys: Document, options: Document): Promise<string> {
    this.indexCalls.push({ keys, options })
    return String(options.name ?? '')
  }
}

function fakeDb (collections: Record<string, CollectionDouble>): Db {
  return {
    listCollections: () => ({ toArray: async () => Object.keys(collections).map((name) => ({ name })) }),
    collection: (name: string) => collections[name]
  } as unknown as Db
}

function sessionDouble (): ClientSession {
  return Object.create(null)
}

describe('Stock migration — safety and planning', () => {
  it('exposes every Stock migration entrypoint through the repository runner', () => {
    for (const [scriptName, entrypoint] of Object.entries(STOCK_MIGRATION_SCRIPTS)) {
      const script = packageJson.scripts[scriptName]
      expect(script).to.equal(`node -r ts-node/register ${entrypoint}`)
      expect(script).to.not.match(/--uri|--environment|--approval-id|--preflight-proof|--backup-proof|mongodb:\/\//)
    }
  })

  it('documents npm argument forwarding without embedding target credentials', async () => {
    const readme = await readFile(resolve(__dirname, '../README.md'), 'utf8')
    const sectionStart = readme.indexOf('## Stock migration commands')
    expect(sectionStart).to.be.greaterThan(-1)
    const sectionEnd = readme.indexOf('\n## ', sectionStart + 1)
    const section = readme.slice(sectionStart, sectionEnd === -1 ? undefined : sectionEnd)

    for (const scriptName of Object.keys(STOCK_MIGRATION_SCRIPTS)) expect(section).to.include(`npm run ${scriptName} --`)
    expect(section).to.include('$MONGODB_URI')
    expect(section).to.include('$STOCK_APPROVAL_ID')
    expect(section).to.not.match(/mongodb:\/\/|password|JWT_SECRET|--proof\s+[^<$\s]+/i)
  })

  it('requires explicit target confirmation and approval arguments', () => {
    expect(() => parseStockMigrationArguments(['--uri', 'mongodb://localhost/stock', '--environment', 'test', '--confirm-target', 'prod', '--approval-id', 'approval'])).to.throw('Target confirmation')
    expect(() => parseStockMigrationArguments(['--uri', 'mongodb://localhost/stock', '--environment', 'test', '--confirm-target', 'test'])).to.throw('Missing required --approval-id')
  })

  it('parses dry-run arguments without requiring a database connection', () => {
    const options = parseStockMigrationArguments([
      '--dry-run', '--uri', 'mongodb://localhost/stock', '--environment', 'test',
      '--confirm-target', 'test', '--approval-id', 'approval-1'
    ])
    expect(options.dryRun).to.equal(true)
    expect(options.uri).to.equal('mongodb://localhost/stock')
  })

  it('runs opening-count dry-run without proofs or a database connection', async () => {
    const directory = await mkdtemp(`${tmpdir()}\\stock-migration-`)
    const input = `${directory}\\opening.json`
    await writeFile(input, JSON.stringify({ approvedBy: ACTOR_ID, approvalId: 'approval-1', rows: [{ productId: PRODUCT_ID, countedQuantity: 2, expiryDate: null }] }), 'utf8')
    try {
      await runApplyOpeningCount(['--dry-run', '--uri', 'mongodb://unused/stock', '--environment', 'test', '--confirm-target', 'test', '--approval-id', 'approval-1', '--input', input])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('finalizes structured artifacts with their requested status', () => {
    const artifact = stockArtifact('stock-006-verify', 'failed', 'mongodb://unused/stock', { failures: ['missing collection'] })
    expect(artifact.status).to.equal('failed')
    expect(artifact.artifactHash).to.be.a('string')
  })

  it('fails closed before a live mutation when proofs are missing', async () => {
    const options: StockMigrationOptions = { uri: 'mongodb://unused/stock', environment: 'test', confirmation: 'test', approvalId: 'approval-1', dryRun: false }
    try {
      await assertStockMutationProofs(options)
      expect.fail('expected missing proof rejection')
    } catch (error: unknown) {
      expect(error).to.have.property('message', 'Stock mutation requires --preflight-proof and --backup-proof')
    }
  })

  it('keeps every proof-gated Stock entrypoint fail-closed when proofs are missing', async () => {
    const directory = await mkdtemp(`${tmpdir()}\\stock-migration-proof-gates-`)
    const openingInput = `${directory}\\opening.json`
    const repairInput = `${directory}\\repair.json`
    await writeFile(openingInput, JSON.stringify({ approvedBy: ACTOR_ID, approvalId: 'approval-1', rows: [{ productId: PRODUCT_ID, countedQuantity: 2, expiryDate: null }] }), 'utf8')
    await writeFile(repairInput, JSON.stringify({ approvedBy: ACTOR_ID, approvalId: 'approval-1', repairs: [{ productId: PRODUCT_ID, physicalQuantity: 2, reason: 'Cycle count' }] }), 'utf8')
    const args = ['--uri', 'mongodb://unused/stock', '--environment', 'test', '--confirm-target', 'test', '--approval-id', 'approval-1']
    try {
      const expectedMessage = 'Stock mutation requires --preflight-proof and --backup-proof'
      await expectRejected(runStockIndexes(args), expectedMessage)
      await expectRejected(runApplyOpeningCount([...args, '--input', openingInput]), expectedMessage)
      await expectRejected(runRepairProjections([...args, '--input', repairInput]), expectedMessage)
      await expectRejected(runStockVerification(args), expectedMessage)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('keeps every Stock dry-run entrypoint non-mutating and database-free', async () => {
    const directory = await mkdtemp(`${tmpdir()}\\stock-migration-dry-run-`)
    const openingInput = `${directory}\\opening.json`
    const repairInput = `${directory}\\repair.json`
    await writeFile(openingInput, JSON.stringify({ approvedBy: ACTOR_ID, approvalId: 'approval-1', rows: [{ productId: PRODUCT_ID, countedQuantity: 2, expiryDate: null }] }), 'utf8')
    await writeFile(repairInput, JSON.stringify({ approvedBy: ACTOR_ID, approvalId: 'approval-1', repairs: [{ productId: PRODUCT_ID, physicalQuantity: 2, reason: 'Cycle count' }] }), 'utf8')
    const args = ['--dry-run', '--uri', 'mongodb://unused/stock', '--environment', 'test', '--confirm-target', 'test', '--approval-id', 'approval-1']
    try {
      await runStockPreflight(args)
      await runStockIndexes(args)
      await runOpeningCountTemplate(args)
      await runApplyOpeningCount([...args, '--input', openingInput])
      await runRepairProjections([...args, '--input', repairInput])
      await runStockVerification(args)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('defines the complete guarded Stock index set', () => {
    expect(EXPECTED_STOCK_INDEXES).to.have.length(6)
    expect(EXPECTED_STOCK_INDEXES).to.deep.include({ key: { idempotencyKey: 1 }, name: 'idx_inventory_movement_idempotency_unique', unique: true })
    expect(EXPECTED_STOCK_INDEXES).to.deep.include({ key: { productId: 1, occurredAt: -1 }, name: 'idx_inventory_movement_product_occurred_at' })
    expect(EXPECTED_STOCK_INDEXES).to.deep.include({ key: { expiryBucketId: 1, occurredAt: -1 }, name: 'idx_inventory_movement_expiry_bucket_occurred_at' })
    expect(EXPECTED_STOCK_INDEXES).to.deep.include({ key: { sourceType: 1, sourceId: 1 }, name: 'idx_inventory_movement_source' })
    expect(EXPECTED_STOCK_INDEXES).to.deep.include({ key: { productId: 1, expiryDate: 1 }, name: 'idx_stock_expiry_bucket_product_expiry_unique', unique: true })
    expect(EXPECTED_STOCK_INDEXES).to.deep.include({ key: { expiryDate: 1, productId: 1 }, name: 'idx_stock_expiry_bucket_expiry_product' })
  })

  it('keeps index dry-runs write-free and maps every applied index deterministically', async () => {
    const inventoryMovements = new CollectionDouble()
    const expiryBuckets = new CollectionDouble()
    const db = fakeDb({ inventorymovements: inventoryMovements, stockexpirybuckets: expiryBuckets })

    const firstPlan = await createStockIndexes(db, true)
    const secondPlan = await createStockIndexes(db, true)

    expect(firstPlan.applied).to.equal(false)
    expect(firstPlan).to.deep.equal(secondPlan)
    expect(inventoryMovements.indexCalls).to.deep.equal([])
    expect(expiryBuckets.indexCalls).to.deep.equal([])

    const applied = await createStockIndexes(db, false)

    expect(applied.applied).to.equal(true)
    expect(inventoryMovements.indexCalls).to.deep.equal([
      { keys: { idempotencyKey: 1 }, options: { name: 'idx_inventory_movement_idempotency_unique', unique: true } },
      { keys: { productId: 1, occurredAt: -1 }, options: { name: 'idx_inventory_movement_product_occurred_at' } },
      { keys: { expiryBucketId: 1, occurredAt: -1 }, options: { name: 'idx_inventory_movement_expiry_bucket_occurred_at' } },
      { keys: { sourceType: 1, sourceId: 1 }, options: { name: 'idx_inventory_movement_source' } }
    ])
    expect(expiryBuckets.indexCalls).to.deep.equal([
      { keys: { productId: 1, expiryDate: 1 }, options: { name: 'idx_stock_expiry_bucket_product_expiry_unique', unique: true } },
      { keys: { expiryDate: 1, productId: 1 }, options: { name: 'idx_stock_expiry_bucket_expiry_product' } }
    ])
  })

  it('fails tracked product verification when bucket receipts do not match stock', async () => {
    const productId = new ObjectId(PRODUCT_ID)
    const result = await verifyStockProjectionInvariants(fakeDb({
      products: new CollectionDouble([{ _id: productId, stock: 5, inventory: { expiryTracking: 'TRACKED' } }]),
      inventorymovements: new CollectionDouble(),
      stockexpirybuckets: new CollectionDouble([{ productId, receivedQuantity: 3, availableQuantity: 3, committedQuantity: 0 }])
    }))

    expect(result.passed).to.equal(false)
    expect(result.failures).to.include(`Product ${PRODUCT_ID} has stock 5 but tracked expiry buckets total 3`)
  })

  it('rejects duplicate opening rows and invalid civil dates', () => {
    const input = JSON.stringify({
      approvedBy: ACTOR_ID,
      approvalId: 'approval-1',
      rows: [
        { productId: PRODUCT_ID, countedQuantity: 4, expiryDate: '2026-12-01' },
        { productId: PRODUCT_ID, countedQuantity: 2, expiryDate: '2026-12-01' }
      ]
    })
    expect(() => parseOpeningCountInput(input, 'json')).to.throw('Duplicate')
    expect(() => parseOpeningCountInput(JSON.stringify({ approvedBy: ACTOR_ID, approvalId: 'approval-1', rows: [{ productId: PRODUCT_ID, countedQuantity: 1, expiryDate: '2026-02-30' }] }), 'json')).to.throw('civil date')
  })

  it('builds deterministic grouped opening plans and skips zero movements', () => {
    const envelope = parseOpeningCountInput(JSON.stringify({
      approvedBy: ACTOR_ID,
      approvalId: 'approval-1',
      rows: [
        { productId: PRODUCT_ID, countedQuantity: 0, expiryDate: '2026-11-01' },
        { productId: PRODUCT_ID, countedQuantity: 4, expiryDate: '2026-12-01' },
        { productId: PRODUCT_ID, countedQuantity: 3, expiryDate: null }
      ]
    }), 'json')
    const plan = buildOpeningCountPlan(envelope)
    expect(plan.groupedTotals).to.deep.equal([{ productId: PRODUCT_ID, countedQuantity: 7 }])
    expect(plan.movements).to.have.length(2)
    expect(plan.movements[0]?.idempotencyKey).to.not.equal(plan.movements[1]?.idempotencyKey)
    expect(plan.movements.map((movement) => movement.quantity)).to.deep.equal([4, 3])
  })

  it('builds a sorted read-only product template', () => {
    expect(buildOpeningTemplate([
      { _id: new ObjectId('000000000000000000000002'), descripcion: 'B' },
      { _id: new ObjectId('000000000000000000000001'), descripcion: 'A' }
    ])).to.deep.equal([
      { productId: '000000000000000000000001', descripcion: 'A', countedQuantity: null, expiryDate: null },
      { productId: '000000000000000000000002', descripcion: 'B', countedQuantity: null, expiryDate: null }
    ])
  })

  it('parses explicit projection repairs and creates only positive repair movements', () => {
    const envelope = parseProjectionRepairInput(JSON.stringify({
      approvedBy: ACTOR_ID,
      approvalId: 'repair-1',
      repairs: [
        { productId: PRODUCT_ID, physicalQuantity: 0, reason: 'No stock observed' },
        { productId: new ObjectId().toHexString(), physicalQuantity: 8, reason: 'Cycle count' }
      ]
    }))
    const plan = buildProjectionRepairPlan(envelope)
    expect(plan.movements).to.have.length(1)
    expect(plan.movements[0]?.type).to.equal('PROJECTION_REPAIR')
    expect(plan.updates).to.have.length(2)
  })

  it('reports every Stock source collection, missing fields, indexes, and orphan references', async () => {
    const saleId = new ObjectId()
    const productId = new ObjectId()
    const collections = {
      products: new CollectionDouble([{ _id: productId }], [{ name: '_id_', key: { _id: 1 } }]),
      sales: new CollectionDouble([{ _id: saleId }]),
      itemsales: new CollectionDouble([{ idVenta: new ObjectId(), idProducto: new ObjectId(), cantidad: 1 }]),
      inventorymovements: new CollectionDouble([], [{ name: 'movement-index', key: { idempotencyKey: 1 } }])
    }

    const report = await collectStockPreflight(fakeDb(collections))

    expect(report.collections.map((collection) => collection.name)).to.deep.equal([
      'products', 'sales', 'itemsales', 'buys', 'itembuys', 'inventorymovements', 'stockexpirybuckets'
    ])
    expect(report.collections.find((collection) => collection.name === 'buys')).to.deep.include({ exists: false, count: 0, indexes: [] })
    expect(report.collections.find((collection) => collection.name === 'products')?.indexes).to.deep.equal([{ name: '_id_', key: { _id: 1 } }])
    expect(report.missingFields).to.deep.include.members([
      { collection: 'products', field: 'stock', exists: true, missingCount: 1 },
      { collection: 'itemsales', field: 'idProducto', exists: true, missingCount: 0 },
      { collection: 'buys', field: '_id', exists: false, missingCount: null }
    ])
    expect(report.orphanReferences.some((reference) => reference.source === 'itemsales' && reference.sourceField === 'idVenta' && reference.target === 'sales' && reference.targetField === '_id' && reference.count === 1)).to.equal(true)
    expect(report.orphanReferences.some((reference) => reference.source === 'itemsales' && reference.sourceField === 'idProducto' && reference.target === 'products' && reference.targetField === '_id' && reference.count === 1)).to.equal(true)
  })

  it('zeros stale uncommitted buckets, preserves bucket identities, and counts idempotent retries', async () => {
    const productId = new ObjectId(PRODUCT_ID)
    const staleBucketId = new ObjectId()
    const collections = {
      products: new CollectionDouble([{ _id: productId }]),
      stockexpirybuckets: new CollectionDouble([
        { _id: staleBucketId, productId, expiryDate: new Date('2026-01-01T00:00:00.000Z'), receivedQuantity: 8, availableQuantity: 5, committedQuantity: 0 }
      ]),
      inventorymovements: new CollectionDouble()
    }
    const envelope = parseOpeningCountInput(JSON.stringify({
      approvedBy: ACTOR_ID,
      approvalId: 'opening-retry',
      rows: [
        { productId: PRODUCT_ID, countedQuantity: 3, expiryDate: '2026-12-01' },
        { productId: PRODUCT_ID, countedQuantity: 2, expiryDate: null }
      ]
    }), 'json')
    const db = fakeDb(collections)

    const first = await applyOpeningCountPlan(db, sessionDouble(), envelope, new Date('2026-10-15T00:00:00.000Z'), 'stock-migration-v1')
    const second = await applyOpeningCountPlan(db, sessionDouble(), envelope, new Date('2026-10-15T00:00:00.000Z'), 'stock-migration-v1')

    expect(first.insertedMovements).to.equal(2)
    expect(first.alreadyAppliedMovements).to.equal(0)
    expect(second.insertedMovements).to.equal(0)
    expect(second.alreadyAppliedMovements).to.equal(2)
    expect(collections.products.docs[0]?.stock).to.equal(5)
    expect(collections.stockexpirybuckets.docs.find((bucket) => bucket._id?.equals(staleBucketId))).to.deep.include({ receivedQuantity: 0, availableQuantity: 0, committedQuantity: 0 })
    expect(collections.stockexpirybuckets.docs.filter((bucket) => bucket.expiryDate instanceof Date && bucket.expiryDate.toISOString().startsWith('2026-12-01'))).to.have.length(1)
  })

  it('rejects commitments in an omitted bucket before any opening write', async () => {
    const productId = new ObjectId(PRODUCT_ID)
    const buckets = new CollectionDouble([{ productId, expiryDate: new Date('2026-01-01T00:00:00.000Z'), receivedQuantity: 4, availableQuantity: 3, committedQuantity: 1 }])
    const products = new CollectionDouble([{ _id: productId }])
    const db = fakeDb({ products, stockexpirybuckets: buckets, inventorymovements: new CollectionDouble() })
    const envelope = parseOpeningCountInput(JSON.stringify({ approvedBy: ACTOR_ID, approvalId: 'blocked-opening', rows: [{ productId: PRODUCT_ID, countedQuantity: 2, expiryDate: null }] }), 'json')

    await expectRejected(applyOpeningCountPlan(db, sessionDouble(), envelope, new Date(), 'stock-migration-v1'), 'Opening count cannot overwrite committed quantity')
    expect(products.updateCalls).to.equal(0)
    expect(buckets.updateCalls).to.equal(0)
  })

  it('rejects a conflicting idempotency key instead of inserting a different movement', async () => {
    const productId = new ObjectId(PRODUCT_ID)
    const envelope = parseProjectionRepairInput(JSON.stringify({ approvedBy: ACTOR_ID, approvalId: 'repair-conflict', repairs: [{ productId: PRODUCT_ID, physicalQuantity: 4, reason: 'Cycle count' }] }))
    const plan = buildProjectionRepairPlan(envelope)
    const movements = new CollectionDouble([{ idempotencyKey: plan.movements[0]?.idempotencyKey, productId, type: 'PROJECTION_REPAIR', quantity: 99, sourceType: 'projection-repair', sourceId: PRODUCT_ID, sourceEvent: 'projection-repair.confirmed', operationId: 'repair-conflict', rulesVersion: 'stock-migration-v1', createdBy: new ObjectId(ACTOR_ID), reason: 'Cycle count' }])
    const db = fakeDb({ products: new CollectionDouble([{ _id: productId }]), inventorymovements: movements })

    await expectRejected(applyProjectionRepairPlan(db, sessionDouble(), envelope, new Date(), 'stock-migration-v1'), 'idempotency key')
    expect(movements.insertCalls).to.equal(0)
  })

  it('counts a matching projection-repair retry as already applied', async () => {
    const productId = new ObjectId(PRODUCT_ID)
    const envelope = parseProjectionRepairInput(JSON.stringify({ approvedBy: ACTOR_ID, approvalId: 'repair-retry', repairs: [{ productId: PRODUCT_ID, physicalQuantity: 4, reason: 'Cycle count' }] }))
    const plan = buildProjectionRepairPlan(envelope)
    const movements = new CollectionDouble([{
      idempotencyKey: plan.movements[0]?.idempotencyKey,
      productId,
      type: 'PROJECTION_REPAIR',
      quantity: 4,
      sourceType: 'projection-repair',
      sourceId: PRODUCT_ID,
      sourceEvent: 'projection-repair.confirmed',
      operationId: 'repair-retry',
      rulesVersion: 'stock-migration-v1',
      createdBy: new ObjectId(ACTOR_ID),
      reason: 'Cycle count'
    }])
    const db = fakeDb({ products: new CollectionDouble([{ _id: productId }]), inventorymovements: movements })

    const result = await applyProjectionRepairPlan(db, sessionDouble(), envelope, new Date(), 'stock-migration-v1')

    expect(result.insertedMovements).to.equal(0)
    expect(result.alreadyAppliedMovements).to.equal(1)
    expect(movements.insertCalls).to.equal(0)
  })
})

async function expectRejected (promise: Promise<unknown>, message: string): Promise<void> {
  try {
    await promise
    expect.fail(`expected rejection containing ${message}`)
  } catch (error: unknown) {
    expect(error).to.have.property('message').that.includes(message)
  }
}
