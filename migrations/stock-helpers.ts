import { createHash } from 'crypto'
import { readFile, writeFile } from 'fs/promises'
import { MongoClient, ObjectId, type ClientSession, type Db, type Document, type IndexDescription } from 'mongodb'
import { z } from 'zod'

import { MIGRATION_IDS, MigrationSafetyError, finalizeArtifact, parseMigrationArguments, printArtifact, readProof, targetFingerprint } from './phase-0-helpers'
import type { InventoryMovementType } from '../src/interfaces/stock.interface'

export const STOCK_MIGRATION_IDS = {
  PREFLIGHT: 'stock-001-preflight',
  INDEXES: 'stock-002-create-indexes',
  TEMPLATE: 'stock-003-opening-count-template',
  OPENING_COUNT: 'stock-004-apply-opening-count',
  PROJECTIONS: 'stock-005-repair-projections',
  VERIFY: 'stock-006-verify'
} as const

export const STOCK_RULES_VERSION = 'stock-migration-v1'

export interface StockMigrationOptions {
  uri: string
  environment: string
  confirmation: string
  approvalId: string
  dryRun: boolean
  input?: string
  output?: string
  approvedBy?: string
  format?: string
  rulesVersion?: string
  preflightProof?: string
  backupProof?: string
  driftFile?: string
}

export interface ApprovalMetadata {
  approvedBy: string
  approvalId: string
}

export interface OpeningCountRow {
  productId: string
  countedQuantity: number
  expiryDate: string | null
}

export interface OpeningCountEnvelope extends ApprovalMetadata {
  rows: OpeningCountRow[]
}

export interface OpeningCountGroupedTotal {
  productId: string
  countedQuantity: number
}

export interface PlannedStockMovement {
  productId: string
  expiryDate: string | null
  type: InventoryMovementType
  quantity: number
  sourceType: string
  sourceId: string
  sourceEvent: string
  operationId: string
  idempotencyKey: string
  rulesVersion: string
  createdBy: string
  reason?: string
}

export interface OpeningCountPlan {
  groupedTotals: OpeningCountGroupedTotal[]
  movements: PlannedStockMovement[]
}

export interface ProjectionRepair {
  productId: string
  physicalQuantity: number
  reason: string
}

export interface ProjectionRepairEnvelope extends ApprovalMetadata {
  repairs: ProjectionRepair[]
}

export interface ProjectionRepairPlan {
  updates: ProjectionRepair[]
  movements: PlannedStockMovement[]
}

export interface ProductTemplateSource {
  _id: ObjectId
  descripcion: string
}

export interface OpeningTemplateRow {
  productId: string
  descripcion: string
  countedQuantity: null
  expiryDate: null
}

export interface StockCollectionInventory {
  name: string
  exists: boolean
  count: number
  indexes: Document[]
}

export interface StockMissingFieldReport {
  collection: string
  field: string
  exists: boolean
  missingCount: number | null
}

export interface StockOrphanReferenceReport {
  source: string
  sourceField: string
  target: string
  targetField: string
  count: number
  references: string[]
}

export interface StockPreflightReport {
  collections: StockCollectionInventory[]
  missingFields: StockMissingFieldReport[]
  orphanReferences: StockOrphanReferenceReport[]
}

export interface StockIndexVerification {
  passed: boolean
  checked: string[]
  missingCollections: string[]
  missingIndexes: string[]
}

interface StockArtifact extends Document {
  migration: string
  status: string
  targetFingerprint: string
  generatedAt: string
}

const OPENING_COUNT_ROW_SCHEMA = z.object({
  productId: z.string().min(1),
  countedQuantity: z.number().int().nonnegative().refine(Number.isSafeInteger),
  expiryDate: z.union([z.string(), z.null()]).optional()
}).strict()

const OPENING_COUNT_ENVELOPE_SCHEMA = z.object({
  approvedBy: z.string().min(1),
  approvalId: z.string().min(1),
  rows: z.array(OPENING_COUNT_ROW_SCHEMA)
}).strict()

const PROJECTION_REPAIR_SCHEMA = z.object({
  productId: z.string().min(1),
  physicalQuantity: z.number().int().nonnegative().refine(Number.isSafeInteger),
  reason: z.string().trim().min(1).max(500)
}).strict()

const PROJECTION_REPAIR_ENVELOPE_SCHEMA = z.object({
  approvedBy: z.string().min(1),
  approvalId: z.string().min(1),
  repairs: z.array(PROJECTION_REPAIR_SCHEMA)
}).strict()

export const EXPECTED_STOCK_INDEXES: IndexDescription[] = [
  { key: { idempotencyKey: 1 }, name: 'idx_inventory_movement_idempotency_unique', unique: true },
  { key: { productId: 1, occurredAt: -1 }, name: 'idx_inventory_movement_product_occurred_at' },
  { key: { expiryBucketId: 1, occurredAt: -1 }, name: 'idx_inventory_movement_expiry_bucket_occurred_at' },
  { key: { sourceType: 1, sourceId: 1 }, name: 'idx_inventory_movement_source' },
  { key: { productId: 1, expiryDate: 1 }, name: 'idx_stock_expiry_bucket_product_expiry_unique', unique: true },
  { key: { expiryDate: 1, productId: 1 }, name: 'idx_stock_expiry_bucket_expiry_product' }
]

const INDEX_COLLECTIONS = {
  INVENTORY_MOVEMENTS: 'inventorymovements',
  EXPIRY_BUCKETS: 'stockexpirybuckets'
} as const

const EXPECTED_INDEX_COLLECTION: Record<string, string> = {
  idx_inventory_movement_idempotency_unique: INDEX_COLLECTIONS.INVENTORY_MOVEMENTS,
  idx_inventory_movement_product_occurred_at: INDEX_COLLECTIONS.INVENTORY_MOVEMENTS,
  idx_inventory_movement_expiry_bucket_occurred_at: INDEX_COLLECTIONS.INVENTORY_MOVEMENTS,
  idx_inventory_movement_source: INDEX_COLLECTIONS.INVENTORY_MOVEMENTS,
  idx_stock_expiry_bucket_product_expiry_unique: INDEX_COLLECTIONS.EXPIRY_BUCKETS,
  idx_stock_expiry_bucket_expiry_product: INDEX_COLLECTIONS.EXPIRY_BUCKETS
}

function parseFlags (argv: string[]): Map<string, string> {
  const flags = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--dry-run') continue
    if (argument === undefined || !argument.startsWith('--')) throw new MigrationSafetyError(`Unexpected argument ${argument ?? ''}`)
    const value = argv[index + 1]
    if (value === undefined || value === '' || value.startsWith('--')) throw new MigrationSafetyError(`Missing value for ${argument}`)
    if (flags.has(argument.slice(2))) throw new MigrationSafetyError(`Duplicate argument ${argument}`)
    flags.set(argument.slice(2), value)
    index += 1
  }
  return flags
}

export function parseStockMigrationArguments (argv: string[]): StockMigrationOptions {
  const base = parseMigrationArguments(argv)
  const flags = parseFlags(argv)
  return {
    uri: base.uri,
    environment: base.environment,
    confirmation: base.confirmation,
    approvalId: base.approvalId,
    dryRun: base.dryRun,
    input: flags.get('input'),
    output: flags.get('output'),
    approvedBy: flags.get('approved-by'),
    format: flags.get('format'),
    rulesVersion: flags.get('rules-version'),
    preflightProof: flags.get('preflight-proof'),
    backupProof: flags.get('backup-proof'),
    driftFile: flags.get('drift-file')
  }
}

export function parseObjectId (value: unknown, field: string): ObjectId {
  if (typeof value !== 'string' || !/^[0-9a-fA-F]{24}$/.test(value)) throw new MigrationSafetyError(`${field} must be a valid ObjectId`)
  return new ObjectId(value)
}

export function parseCivilDate (value: unknown, field = 'expiryDate'): string | null {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new MigrationSafetyError(`${field} must be a civil date in YYYY-MM-DD format`)
  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 0))
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== (month ?? 1) - 1 || date.getUTCDate() !== day) throw new MigrationSafetyError(`${field} must be a valid civil date`)
  return value
}

function formatZodError (error: z.ZodError): string {
  return error.issues.map((issue) => {
    const path = issue.path.join('.')
    return `${path === '' ? 'input' : path}: ${issue.message}`
  }).join('; ')
}

function normalizeApproval (approvedBy: string, approvalId: string): ApprovalMetadata {
  parseObjectId(approvedBy, 'approvedBy')
  if (approvalId.trim() === '') throw new MigrationSafetyError('approvalId must not be empty')
  return { approvedBy: new ObjectId(approvedBy).toHexString(), approvalId }
}

export function parseOpeningCountInput (content: string, format: 'json' | 'csv', csvApproval?: ApprovalMetadata): OpeningCountEnvelope {
  let value: unknown
  if (format === 'json') {
    try {
      value = JSON.parse(content) as unknown
    } catch {
      throw new MigrationSafetyError('Opening-count JSON is invalid')
    }
  } else {
    const records = parseCsvRecords(content)
    const header = records.shift()
    if (header === undefined || header.join(',') !== 'productId,countedQuantity,expiryDate') throw new MigrationSafetyError('Opening-count CSV headers must be productId,countedQuantity,expiryDate')
    if (csvApproval === undefined) throw new MigrationSafetyError('CSV opening counts require approvedBy and approvalId metadata')
    value = {
      ...normalizeApproval(csvApproval.approvedBy, csvApproval.approvalId),
      rows: records.map((record, index) => {
        if (record.length !== 3) throw new MigrationSafetyError(`CSV row ${index + 2} must have three columns`)
        const quantity = Number(record[1])
        if (record[1] === undefined || record[1].trim() === '' || !Number.isSafeInteger(quantity) || quantity < 0) throw new MigrationSafetyError(`CSV row ${index + 2} countedQuantity must be a non-negative integer`)
        return { productId: record[0], countedQuantity: quantity, expiryDate: record[2] === '' ? null : record[2] }
      })
    }
  }

  const result = OPENING_COUNT_ENVELOPE_SCHEMA.safeParse(value)
  if (!result.success) throw new MigrationSafetyError(formatZodError(result.error))
  const approval = normalizeApproval(result.data.approvedBy, result.data.approvalId)
  const rows: OpeningCountRow[] = result.data.rows.map((row) => ({
    productId: parseObjectId(row.productId, 'productId').toHexString(),
    countedQuantity: row.countedQuantity,
    expiryDate: parseCivilDate(row.expiryDate)
  }))
  assertNoDuplicateOpeningRows(rows)
  return { ...approval, rows }
}

function parseCsvRecords (content: string): string[][] {
  const records: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (const character of content.replace(/^\uFEFF/, '')) {
    if (character === '"') {
      quoted = !quoted
    } else if (character === ',' && !quoted) {
      row.push(field.trim())
      field = ''
    } else if ((character === '\n' || character === '\r') && !quoted) {
      if (character === '\r') continue
      row.push(field.trim())
      if (row.some((value) => value !== '')) records.push(row)
      row = []
      field = ''
    } else {
      field += character
    }
  }
  if (quoted) throw new MigrationSafetyError('Opening-count CSV has an unterminated quoted field')
  if (field !== '' || row.length > 0) {
    row.push(field.trim())
    if (row.some((value) => value !== '')) records.push(row)
  }
  return records
}

function assertNoDuplicateOpeningRows (rows: OpeningCountRow[]): void {
  const keys = new Set<string>()
  for (const row of rows) {
    const key = `${row.productId}:${row.expiryDate ?? 'NONE'}`
    if (keys.has(key)) throw new MigrationSafetyError(`Duplicate opening-count row for ${key}`)
    keys.add(key)
  }
}

export function stableIdempotencyKey (operationId: string, sourceType: string, productId: string, expiryDate: string | null): string {
  return createHash('sha256').update(`${operationId}|${sourceType}|${productId}|${expiryDate ?? 'NONE'}`).digest('hex')
}

export function buildOpeningCountPlan (envelope: OpeningCountEnvelope, rulesVersion = STOCK_RULES_VERSION): OpeningCountPlan {
  const totals = new Map<string, number>()
  for (const row of envelope.rows) totals.set(row.productId, (totals.get(row.productId) ?? 0) + row.countedQuantity)
  const groupedTotals = Array.from(totals.entries()).sort(([left], [right]) => left.localeCompare(right)).map(([productId, countedQuantity]) => ({ productId, countedQuantity }))
  const movements = envelope.rows
    .filter((row) => row.countedQuantity > 0)
    .sort((left, right) => `${left.productId}:${left.expiryDate ?? 'NONE'}`.localeCompare(`${right.productId}:${right.expiryDate ?? 'NONE'}`))
    .map((row) => ({
      productId: row.productId,
      expiryDate: row.expiryDate,
      type: 'OPENING' as InventoryMovementType,
      quantity: row.countedQuantity,
      sourceType: 'opening-count',
      sourceId: row.productId,
      sourceEvent: 'opening-count.confirmed',
      operationId: envelope.approvalId,
      idempotencyKey: stableIdempotencyKey(envelope.approvalId, 'opening-count', row.productId, row.expiryDate),
      rulesVersion,
      createdBy: envelope.approvedBy
    }))
  return { groupedTotals, movements }
}

export function parseProjectionRepairInput (content: string): ProjectionRepairEnvelope {
  let value: unknown
  try {
    value = JSON.parse(content) as unknown
  } catch {
    throw new MigrationSafetyError('Projection-repair JSON is invalid')
  }
  const result = PROJECTION_REPAIR_ENVELOPE_SCHEMA.safeParse(value)
  if (!result.success) throw new MigrationSafetyError(formatZodError(result.error))
  const approval = normalizeApproval(result.data.approvedBy, result.data.approvalId)
  const repairs = result.data.repairs.map((repair) => ({
    productId: parseObjectId(repair.productId, 'productId').toHexString(),
    physicalQuantity: repair.physicalQuantity,
    reason: repair.reason.trim()
  }))
  const ids = new Set<string>()
  for (const repair of repairs) {
    if (ids.has(repair.productId)) throw new MigrationSafetyError(`Duplicate projection repair for ${repair.productId}`)
    ids.add(repair.productId)
  }
  return { ...approval, repairs }
}

export function buildProjectionRepairPlan (envelope: ProjectionRepairEnvelope, rulesVersion = STOCK_RULES_VERSION): ProjectionRepairPlan {
  const updates = [...envelope.repairs].sort((left, right) => left.productId.localeCompare(right.productId))
  const movements = updates.filter((repair) => repair.physicalQuantity > 0).map((repair) => ({
    productId: repair.productId,
    expiryDate: null,
    type: 'PROJECTION_REPAIR' as InventoryMovementType,
    quantity: repair.physicalQuantity,
    sourceType: 'projection-repair',
    sourceId: repair.productId,
    sourceEvent: 'projection-repair.confirmed',
    operationId: envelope.approvalId,
    idempotencyKey: stableIdempotencyKey(envelope.approvalId, 'projection-repair', repair.productId, null),
    rulesVersion,
    createdBy: envelope.approvedBy,
    reason: repair.reason
  }))
  return { updates, movements }
}

export function buildOpeningTemplate (products: ProductTemplateSource[]): OpeningTemplateRow[] {
  return [...products].sort((left, right) => left._id.toHexString().localeCompare(right._id.toHexString())).map((product) => ({
    productId: product._id.toHexString(),
    descripcion: product.descripcion,
    countedQuantity: null,
    expiryDate: null
  }))
}

export async function emitJson (value: unknown, output?: string): Promise<void> {
  const serialized = `${JSON.stringify(value, null, 2)}\n`
  if (output !== undefined && output !== '') await writeFile(output, serialized, 'utf8')
  process.stdout.write(serialized)
}

export async function readInputFile (path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    throw new MigrationSafetyError(`Unable to read input file ${path}`)
  }
}

export async function assertStockMutationProofs (options: StockMigrationOptions): Promise<void> {
  if (options.preflightProof === undefined || options.preflightProof === '' || options.backupProof === undefined || options.backupProof === '') throw new MigrationSafetyError('Stock mutation requires --preflight-proof and --backup-proof')
  await readProof(options.preflightProof, STOCK_MIGRATION_IDS.PREFLIGHT, options.uri)
  const backup = await readProof(options.backupProof, MIGRATION_IDS.BACKUP, options.uri)
  if (backup.restoreVerified !== true || typeof backup.archiveHash !== 'string' || backup.archiveHash === '') throw new MigrationSafetyError('Backup proof has no verified restore and hash')
}

export function assertEnvelopeMatchesCli (envelope: ApprovalMetadata, options: StockMigrationOptions): void {
  if (envelope.approvalId !== options.approvalId) throw new MigrationSafetyError('Input approvalId must match --approval-id')
  if (options.approvedBy !== undefined && normalizeApproval(options.approvedBy, options.approvalId).approvedBy !== envelope.approvedBy) throw new MigrationSafetyError('Input approvedBy must match --approved-by')
}

const STOCK_COLLECTION_NAMES = ['products', 'sales', 'itemsales', 'buys', 'itembuys', INDEX_COLLECTIONS.INVENTORY_MOVEMENTS, INDEX_COLLECTIONS.EXPIRY_BUCKETS] as const

const STOCK_REQUIRED_FIELDS = [
  { collection: 'products', field: 'stock' },
  { collection: 'sales', field: '_id' },
  { collection: 'itemsales', field: 'idVenta' },
  { collection: 'itemsales', field: 'idProducto' },
  { collection: 'itemsales', field: 'cantidad' },
  { collection: 'buys', field: '_id' },
  { collection: 'itembuys', field: 'idCompra' },
  { collection: 'itembuys', field: 'idProducto' },
  { collection: 'itembuys', field: 'cantidad' }
] as const

const STOCK_ORPHAN_CHECKS = [
  { source: 'itemsales', sourceField: 'idVenta', target: 'sales', targetField: '_id' },
  { source: 'itemsales', sourceField: 'idProducto', target: 'products', targetField: '_id' },
  { source: 'itembuys', sourceField: 'idCompra', target: 'buys', targetField: '_id' },
  { source: 'itembuys', sourceField: 'idProducto', target: 'products', targetField: '_id' }
] as const

function mongoValuesEqual (left: unknown, right: unknown): boolean {
  if (left instanceof ObjectId && right instanceof ObjectId) return left.equals(right)
  if (left instanceof Date && right instanceof Date) return left.getTime() === right.getTime()
  return left === right
}

function valueForField (document: Document, field: string): unknown {
  return document[field]
}

function hasValue (value: unknown): boolean {
  return value !== undefined && value !== null
}

function displayReference (value: unknown): string {
  return value instanceof ObjectId ? value.toHexString() : String(value)
}

export async function collectStockPreflight (db: Db): Promise<StockPreflightReport> {
  const names = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map((entry) => entry.name))
  const collections: StockCollectionInventory[] = []
  for (const name of STOCK_COLLECTION_NAMES) {
    const exists = names.has(name)
    const collection = db.collection(name)
    collections.push({ name, exists, count: exists ? await collection.countDocuments({}) : 0, indexes: exists ? await collection.indexes() : [] })
  }

  const missingFields: StockMissingFieldReport[] = []
  for (const required of STOCK_REQUIRED_FIELDS) {
    const exists = names.has(required.collection)
    const missingCount = exists
      ? (await db.collection(required.collection).find({}).toArray()).filter((document) => !hasValue(valueForField(document, required.field))).length
      : null
    missingFields.push({ ...required, exists, missingCount })
  }

  const orphanReferences: StockOrphanReferenceReport[] = []
  for (const check of STOCK_ORPHAN_CHECKS) {
    if (!names.has(check.source) || !names.has(check.target)) continue
    const sourceDocuments = await db.collection(check.source).find({}).toArray()
    const targetDocuments = await db.collection(check.target).find({}).toArray()
    const targetValues = targetDocuments.map((document) => valueForField(document, check.targetField)).filter(hasValue)
    const orphaned = sourceDocuments
      .map((document) => valueForField(document, check.sourceField))
      .filter(hasValue)
      .filter((value) => !targetValues.some((targetValue) => mongoValuesEqual(value, targetValue)))
    orphanReferences.push({ ...check, count: orphaned.length, references: orphaned.map(displayReference).sort() })
  }

  return { collections, missingFields, orphanReferences }
}

export function buildStockMovementDocument (movement: PlannedStockMovement, now: Date, expiryBucketId?: ObjectId): Document {
  return {
    productId: new ObjectId(movement.productId),
    ...(expiryBucketId === undefined ? {} : { expiryBucketId }),
    type: movement.type,
    quantity: movement.quantity,
    occurredAt: now,
    sourceType: movement.sourceType,
    sourceId: movement.sourceId,
    sourceEvent: movement.sourceEvent,
    operationId: movement.operationId,
    idempotencyKey: movement.idempotencyKey,
    rulesVersion: movement.rulesVersion,
    ...(movement.reason === undefined ? {} : { reason: movement.reason }),
    createdBy: new ObjectId(movement.createdBy),
    createdAt: now,
    updatedAt: now
  }
}

export function movementSemanticsMatch (existing: Document, expected: Document): boolean {
  const fields = ['productId', 'expiryBucketId', 'type', 'quantity', 'sourceType', 'sourceId', 'sourceEvent', 'operationId', 'rulesVersion', 'createdBy']
  for (const field of fields) {
    if (!mongoValuesEqual(existing[field], expected[field])) return false
  }
  if (expected.reason !== undefined && !mongoValuesEqual(existing.reason, expected.reason)) return false
  return true
}

function canonicalize (value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => `${JSON.stringify(key)}:${canonicalize(entry)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export async function createStockIndexes (db: Pick<Db, 'collection'>, dryRun: boolean): Promise<{ applied: boolean, plannedIndexes: IndexDescription[] }> {
  if (!dryRun) {
    for (const index of EXPECTED_STOCK_INDEXES) {
      const collectionName = EXPECTED_INDEX_COLLECTION[String(index.name)]
      if (collectionName === undefined) throw new MigrationSafetyError(`No collection mapped for index ${String(index.name)}`)
      await db.collection(collectionName).createIndex(index.key, { name: index.name, ...(index.unique === true ? { unique: true } : {}) })
    }
  }
  return { applied: !dryRun, plannedIndexes: EXPECTED_STOCK_INDEXES.map((index) => ({ ...index, key: { ...index.key } })) }
}

export async function verifyExpectedStockIndexes (db: Db): Promise<StockIndexVerification> {
  const names = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map((entry) => entry.name))
  const missingCollections = Array.from(new Set(Object.values(EXPECTED_INDEX_COLLECTION))).filter((name) => !names.has(name))
  const missingIndexes: string[] = []
  for (const collectionName of Object.values(INDEX_COLLECTIONS)) {
    if (!names.has(collectionName)) continue
    const indexes = await db.collection(collectionName).indexes()
    for (const expected of EXPECTED_STOCK_INDEXES.filter((index) => EXPECTED_INDEX_COLLECTION[String(index.name)] === collectionName)) {
      const actual = indexes.find((index) => index.name === expected.name)
      if (actual === undefined || canonicalize(actual.key) !== canonicalize(expected.key) || Boolean(actual.unique) !== Boolean(expected.unique)) missingIndexes.push(String(expected.name))
    }
  }
  return { passed: missingCollections.length === 0 && missingIndexes.length === 0, checked: [...Object.values(INDEX_COLLECTIONS)], missingCollections, missingIndexes }
}

export async function withStockTransaction<T> (uri: string, operation: (db: Db, session: ClientSession) => Promise<T>): Promise<T> {
  const client = new MongoClient(uri)
  let session: ClientSession | undefined
  try {
    await client.connect()
    session = client.startSession()
    let result: T | undefined
    await session.withTransaction(async () => {
      result = await operation(client.db(), session as ClientSession)
    })
    if (result === undefined) throw new MigrationSafetyError('Stock transaction produced no result')
    return result
  } catch (error) {
    if (error instanceof MigrationSafetyError) throw error
    throw new MigrationSafetyError(`Unable to start or complete Stock transaction: ${error instanceof Error ? error.message : 'unknown error'}`)
  } finally {
    await session?.endSession()
    await client.close()
  }
}

export function stockArtifact (migration: string, status: string, uri: string, fields: Document = {}): StockArtifact {
  const artifact: StockArtifact = { migration, status, targetFingerprint: targetFingerprint(uri), generatedAt: new Date().toISOString(), ...fields }
  return finalizeArtifact(artifact)
}

export function printStockArtifact (migration: string, status: string, uri: string, fields: Document = {}): void {
  printArtifact(stockArtifact(migration, status, uri, fields))
}
