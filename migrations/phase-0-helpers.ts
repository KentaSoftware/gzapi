import { createHash } from 'crypto'
import { readFile } from 'fs/promises'
import { spawn } from 'child_process'
import { MongoClient, type Db, type Document, type IndexDescription } from 'mongodb'

const MIGRATION_IDS = {
  PREFLIGHT: 'phase-0-001-preflight',
  BACKUP: 'phase-0-002-backup-verify',
  INDEXES: 'phase-0-003-create-commercial-fact-indexes',
  VERIFY: 'phase-0-004-verify'
} as const

const DRIFT_CLASSIFICATIONS = {
  PRESERVE: 'preserve',
  MIGRATE: 'migrate',
  REJECT: 'reject'
} as const

type DriftClassification = (typeof DRIFT_CLASSIFICATIONS)[keyof typeof DRIFT_CLASSIFICATIONS]

interface MigrationArguments {
  uri: string
  environment: string
  confirmation: string
  approvalId: string
  dryRun: boolean
  archive?: string
  restoreUri?: string
  backupId?: string
  preflightProof?: string
  backupProof?: string
  driftFile?: string
}

interface MigrationArtifact extends Document {
  migration: string
  status: string
  targetFingerprint: string
  generatedAt: string
  artifactHash?: string
}

interface CommercialFactIndexResult {
  applied: boolean
  plannedIndexes: IndexDescription[]
}

interface OrphanReference {
  source: string
  target: string
  path: string
  count: number
}

export class MigrationSafetyError extends Error {}

const expectedIndexes: IndexDescription[] = [
  { key: { type: 1, aggregateId: 1, idempotencyKey: 1 }, name: 'idx_unique_fact_idempotency', unique: true },
  { key: { aggregateId: 1, type: 1 }, name: 'idx_aggregate_type' },
  { key: { correlationId: 1 }, name: 'idx_correlation' }
]

function requiredValue (values: Map<string, string>, name: string): string {
  const value = values.get(name)
  if (value === undefined || value === '') throw new MigrationSafetyError(`Missing required --${name}`)
  return value
}

export function parseMigrationArguments (argv: string[]): MigrationArguments {
  const values = new Map<string, string>()
  let dryRun = false
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--dry-run') {
      dryRun = true
      continue
    }
    if (!argument.startsWith('--')) throw new MigrationSafetyError(`Unexpected argument ${argument}`)
    const value = argv[index + 1]
    if (value === undefined || value === '' || value.startsWith('--')) throw new MigrationSafetyError(`Missing value for ${argument}`)
    values.set(argument.slice(2), value)
    index += 1
  }

  const uri = requiredValue(values, 'uri')
  const environment = requiredValue(values, 'environment')
  const confirmation = requiredValue(values, 'confirm-target')
  const approvalId = requiredValue(values, 'approval-id')
  if (!/^mongodb(\+srv)?:\/\//.test(uri)) throw new MigrationSafetyError('Target URI must be a MongoDB URI')
  if (confirmation !== environment) throw new MigrationSafetyError('Target confirmation must exactly match --environment')
  return {
    uri,
    environment,
    confirmation,
    approvalId,
    dryRun,
    archive: values.get('archive'),
    restoreUri: values.get('restore-uri'),
    backupId: values.get('backup-id'),
    preflightProof: values.get('preflight-proof'),
    backupProof: values.get('backup-proof'),
    driftFile: values.get('drift-file')
  }
}

export function targetFingerprint (uri: string): string {
  return createHash('sha256').update(uri).digest('hex')
}

function canonicalize (value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right))
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalize(entry)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export function hashArtifact (artifact: MigrationArtifact): string {
  const { artifactHash, ...withoutHash } = artifact
  return createHash('sha256').update(canonicalize(withoutHash)).digest('hex')
}

export function finalizeArtifact<T extends MigrationArtifact> (artifact: T): T {
  return { ...artifact, artifactHash: hashArtifact(artifact) }
}

export async function readProof (filePath: string, expectedMigration: string, uri: string): Promise<MigrationArtifact> {
  let parsed: MigrationArtifact
  try {
    parsed = JSON.parse(await readFile(filePath, 'utf8')) as MigrationArtifact
  } catch {
    throw new MigrationSafetyError(`Unable to read ${expectedMigration} proof`)
  }
  if (parsed.migration !== expectedMigration || parsed.status !== 'passed') throw new MigrationSafetyError(`Invalid ${expectedMigration} proof`)
  if (parsed.targetFingerprint !== targetFingerprint(uri)) throw new MigrationSafetyError(`${expectedMigration} proof targets a different database`)
  if (parsed.artifactHash === undefined || parsed.artifactHash === '' || parsed.artifactHash !== hashArtifact(parsed)) throw new MigrationSafetyError(`Invalid ${expectedMigration} proof hash`)
  return parsed
}

async function readDriftClassifications (filePath?: string): Promise<Record<string, DriftClassification>> {
  if (filePath === undefined || filePath === '') return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(filePath, 'utf8'))
  } catch {
    throw new MigrationSafetyError('Unable to read drift classifications')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new MigrationSafetyError('Drift classifications must be an object')
  const classifications: Record<string, DriftClassification> = {}
  for (const [path, classification] of Object.entries(parsed)) {
    if (!Object.values(DRIFT_CLASSIFICATIONS).includes(classification as DriftClassification)) throw new MigrationSafetyError(`Invalid drift classification for ${path}`)
    classifications[path] = classification as DriftClassification
  }
  return classifications
}

export async function collectPreflight (db: Db, driftFile?: string): Promise<Document> {
  const inventory = await collectDatabaseInventory(db)
  const orphanReferences = await collectOrphanReferences(db)
  const classifications = await readDriftClassifications(driftFile)
  const drift = await collectGuardedDrift(db, classifications)
  const unclassified = drift.filter((entry) => entry.classification === undefined)
  if (orphanReferences.some((reference) => reference.count > 0)) throw new MigrationSafetyError('Preflight found orphaned references')
  if (unclassified.length > 0) throw new MigrationSafetyError('Preflight found unclassified drift')
  return { collections: inventory, orphanReferences, drift }
}

export async function collectDatabaseInventory (db: Db): Promise<Document[]> {
  const collections = await db.listCollections({}, { nameOnly: true }).toArray()
  const inventory: Document[] = []
  for (const collection of collections.sort((left, right) => left.name.localeCompare(right.name))) {
    const handle = db.collection(collection.name)
    inventory.push({ name: collection.name, count: await handle.countDocuments({}), indexes: await handle.indexes() })
  }
  return inventory
}

async function collectGuardedDrift (db: Db, classifications: Record<string, DriftClassification>): Promise<Document[]> {
  const drift: Document[] = []
  for (const path of ['providers.telefono', 'providers.direccion']) {
    const [collectionName, field] = path.split('.')
    const collection = db.collection(collectionName)
    const count = await collection.countDocuments({ [field ?? path]: { $exists: true } })
    if (count > 0) drift.push({ path, count, classification: classifications[path] })
  }
  const collections = await db.listCollections({}, { nameOnly: true }).toArray()
  let versionCount = 0
  for (const collection of collections) versionCount += await db.collection(collection.name).countDocuments({ __v: { $exists: true } })
  if (versionCount > 0) drift.push({ path: '__v', count: versionCount, classification: classifications.__v })
  return drift
}

async function collectOrphanReferences (db: Db): Promise<OrphanReference[]> {
  const checks = [
    { source: 'sales', target: 'users', path: 'user' },
    { source: 'sales', target: 'clients', path: 'idCliente' },
    { source: 'buys', target: 'users', path: 'user' },
    { source: 'itembuys', target: 'buys', path: 'idBuy' },
    { source: 'itembuys', target: 'products', path: 'idProducto' }
  ]
  const names = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map((collection) => collection.name))
  const results: OrphanReference[] = []
  for (const check of checks) {
    if (!names.has(check.source) || !names.has(check.target)) continue
    const orphaned = await db.collection(check.source).aggregate([
      { $match: { [check.path]: { $exists: true, $ne: null } } },
      { $lookup: { from: check.target, localField: check.path, foreignField: '_id', as: 'target' } },
      { $match: { target: { $eq: [] } } },
      { $count: 'count' }
    ]).toArray()
    results.push({ ...check, count: orphaned[0]?.count ?? 0 })
  }
  return results
}

export async function runCreateCommercialFactIndexes (db: Pick<Db, 'collection'>, dryRun: boolean): Promise<CommercialFactIndexResult> {
  if (!dryRun) {
    const collection = db.collection('commercialfacts')
    for (const index of expectedIndexes) {
      const options = index.unique === true ? { name: index.name, unique: true } : { name: index.name }
      await collection.createIndex(index.key, options)
    }
  }
  return { applied: !dryRun, plannedIndexes: expectedIndexes }
}

export async function verifyCommercialFactIndexes (db: Db): Promise<void> {
  const indexes = await db.collection('commercialfacts').indexes()
  for (const expected of expectedIndexes) {
    const actual = indexes.find((index) => index.name === expected.name)
    if (actual === undefined || canonicalize(actual.key) !== canonicalize(expected.key) || Boolean(actual.unique) !== Boolean(expected.unique)) {
      throw new MigrationSafetyError(`Missing or incompatible index ${String(expected.name)}`)
    }
  }
}

export async function withTargetDatabase<T> (uri: string, operation: (db: Db) => Promise<T>): Promise<T> {
  const client = new MongoClient(uri)
  try {
    await client.connect()
    return await operation(client.db())
  } finally {
    await client.close()
  }
}

export async function runDatabaseTool (tool: 'mongodump' | 'mongorestore', args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(tool, args, { stdio: 'ignore', windowsHide: true })
    child.once('error', () => reject(new MigrationSafetyError(`${tool} is unavailable`)))
    child.once('exit', (code) => code === 0 ? resolve() : reject(new MigrationSafetyError(`${tool} failed`)))
  })
}

export function printArtifact (artifact: MigrationArtifact): void {
  process.stdout.write(`${JSON.stringify(finalizeArtifact(artifact))}\n`)
}

export { MIGRATION_IDS }
