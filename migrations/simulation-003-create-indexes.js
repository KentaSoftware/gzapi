const { createHash } = require('crypto')
const { MongoClient } = require('mongodb')

const MIGRATION_ID = 'simulation-003-create-indexes'

const TARGETS = [
  {
    name: 'simulationruns',
    indexes: [
      { name: 'idx_simulation_run_route_created', key: { sourceRouteId: 1, createdAt: -1 }, unique: false },
      { name: 'idx_simulation_run_status_created', key: { status: 1, createdAt: -1 }, unique: false }
    ]
  },
  {
    name: 'simulationconfigversions',
    indexes: [
      { name: 'idx_simulation_config_logical_version_unique', key: { vehicleCode: 1, zoneCode: 1, 'period.from': 1, 'period.to': 1, version: 1 }, unique: true },
      { name: 'idx_simulation_config_status_period', key: { status: 1, 'period.from': 1, 'period.to': 1 }, unique: false }
    ]
  },
  {
    name: 'simulationpresetversions',
    indexes: [
      { name: 'idx_simulation_preset_version_unique', key: { name: 1, version: 1 }, unique: true },
      { name: 'idx_simulation_preset_status_created', key: { status: 1, createdAt: -1 }, unique: false }
    ]
  }
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

const normalizeKey = (key) => JSON.stringify(Object.entries(key))

const INDEX_OPTION_KEYS = ['unique', 'sparse', 'expireAfterSeconds', 'partialFilterExpression', 'collation']

const canonicalize = (value) => {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)])
    )
  }
  return value
}

const normalizeIndexOption = (key, value) => {
  if (key === 'unique' || key === 'sparse') return Boolean(value)
  if (value === undefined) return null
  return canonicalize(value)
}

const sameIndexOptions = (existing, expected) => INDEX_OPTION_KEYS.every((key) => {
  return JSON.stringify(normalizeIndexOption(key, existing[key])) === JSON.stringify(normalizeIndexOption(key, expected[key]))
})

const sameIndex = (existing, expected) => {
  if (normalizeKey(existing.key) !== normalizeKey(expected.key)) return false
  return sameIndexOptions(existing, expected)
}

const planIndexes = async (db) => {
  const existingCollections = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map((entry) => entry.name))
  const missingCollections = TARGETS.filter((target) => !existingCollections.has(target.name)).map((target) => target.name)
  if (missingCollections.length > 0) {
    throw new MigrationSafetyError(`Missing simulation collections: ${missingCollections.join(', ')}. Run the collection migration first`)
  }

  const planned = []
  const skipped = []
  const conflicts = []
  for (const target of TARGETS) {
    const collection = db.collection(target.name)
    const existing = await collection.indexes()
    for (const expected of target.indexes) {
      const current = existing.find((index) => index.name === expected.name)
      if (current === undefined) {
        planned.push({ collection: target.name, index: expected })
        continue
      }
      if (!sameIndex(current, expected)) {
        conflicts.push({ collection: target.name, index: expected.name, expected, observed: current })
        continue
      }
      skipped.push({ collection: target.name, index: expected.name })
    }
  }

  return { planned, skipped, conflicts }
}

const applyIndexes = async (db) => {
  const plan = await planIndexes(db)
  const plannedNames = plan.planned.map((entry) => ({ collection: entry.collection, index: entry.index.name }))
  if (plan.conflicts.length > 0) {
    return { created: [], skipped: plan.skipped, conflicts: plan.conflicts, plannedBeforeCreate: plannedNames }
  }

  const created = []
  for (const entry of plan.planned) {
    await db.collection(entry.collection).createIndexes([entry.index])
    created.push({ collection: entry.collection, index: entry.index.name })
  }

  return { created, skipped: plan.skipped, conflicts: [], plannedBeforeCreate: plannedNames }
}

const runMigration = async (options) => {
  if (options.dryRun) {
    printArtifact('dry-run', options, {
      plannedActions: ['create missing named indexes on the three simulation collections', 'fail on conflicting indexes without dropping or rebuilding them'],
      indexes: TARGETS,
      businessDataMutated: false
    })
    return
  }

  const client = new MongoClient(options.uri, { serverSelectionTimeoutMS: 10000 })
  try {
    await client.connect()
    const result = await applyIndexes(client.db())
    if (result.conflicts.length > 0) {
      printArtifact('failed', options, {
        ...result,
        failures: ['Existing indexes conflict with the expected simulation index definitions'],
        businessDataMutated: false
      })
      throw new MigrationSafetyError('Index migration found conflicting simulation indexes')
    }
    printArtifact('passed', options, {
      ...result,
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
