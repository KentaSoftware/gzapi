const { createHash } = require('crypto')
const { MongoClient } = require('mongodb')

const MIGRATION_ID = 'simulation-002-create-collections'

const TARGET_COLLECTIONS = [
  'simulationruns',
  'simulationconfigversions',
  'simulationpresetversions'
]

const PROTECTED_COLLECTIONS = [
  'sales',
  'itemsales',
  'buys',
  'itembuys',
  'products',
  'inventorymovements',
  'stockexpirybuckets',
  'routeplans',
  'routeplanoperationals',
  'expenses',
  'cashflowconfigs'
]

class MigrationSafetyError extends Error {}

const requiredValue = (values, name) => {
  const value = values.get(name)
  if (value === undefined || value === '') throw new MigrationSafetyError(`Missing required --${name}`)
  return value
}

const parseArguments = (argv) => {
  const values = new Map()
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
  return { uri, environment, confirmation, approvalId, dryRun }
}

const targetFingerprint = (uri) => createHash('sha256').update(uri).digest('hex')

const printArtifact = (status, options, details) => {
  process.stdout.write(`${JSON.stringify({
    migration: MIGRATION_ID,
    status,
    generatedAt: new Date().toISOString(),
    targetFingerprint: targetFingerprint(options.uri),
    environment: options.environment,
    approvalId: options.approvalId,
    ...details
  }, null, 2)}\n`)
}

const createCollections = async (db) => {
  const existing = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map((entry) => entry.name))
  const created = []
  const skipped = []
  for (const name of TARGET_COLLECTIONS) {
    if (PROTECTED_COLLECTIONS.includes(name)) throw new MigrationSafetyError(`Refusing to create protected collection ${name}`)
    if (existing.has(name)) {
      skipped.push(name)
      continue
    }
    await db.createCollection(name)
    created.push(name)
  }
  return { created, skipped, existingCollectionsUnchanged: skipped }
}

const runMigration = async (options) => {
  if (options.dryRun) {
    printArtifact('dry-run', options, {
      plannedActions: ['create missing simulation collections', 'leave existing collections and all protected collections untouched'],
      targets: TARGET_COLLECTIONS,
      businessDataMutated: false
    })
    return
  }

  const client = new MongoClient(options.uri, { serverSelectionTimeoutMS: 10000 })
  try {
    await client.connect()
    const result = await createCollections(client.db())
    printArtifact('passed', options, {
      ...result,
      protectedCollectionsTargeted: [],
      businessDataMutated: false
    })
  } finally {
    await client.close()
  }
}

if (require.main === module) {
  runMigration(parseArguments(process.argv.slice(2))).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'Migration failed'}\n`)
    process.exitCode = 1
  })
}
