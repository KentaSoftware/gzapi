import mongoose from 'mongoose'
import { computeMatrix, computeRoute } from '../src/services/routeMatrixProvider'
import { geocode } from '../src/services/geocodingProvider'
import { assertDemoAdmin, inspectDemoFixtures, mongoDatabase, resolveServiceDate, resolveTarget, runDemoSeed } from './demo-001-seed-data'

type Environment = Record<string, string | undefined>

interface BuildSeedDependencies {
  database: typeof mongoDatabase
  inspect: typeof inspectDemoFixtures
  seed: typeof runDemoSeed
  disconnect: () => Promise<void>
}

const defaultDependencies: BuildSeedDependencies = {
  database: mongoDatabase,
  inspect: inspectDemoFixtures,
  seed: runDemoSeed,
  disconnect: async () => { await mongoose.disconnect() }
}

export const runProductionBuildSeed = async (
  environment: Environment = process.env,
  connect: (uri: string) => Promise<unknown> = async (uri) => await mongoose.connect(uri),
  dependencies: BuildSeedDependencies = defaultDependencies
): Promise<'skipped' | 'complete' | 'seeded'> => {
  if (environment.VERCEL_ENV !== 'production') return 'skipped'

  const mode = environment.DEMO_SEED_MODE
  if (mode === undefined || mode === 'disabled') return 'skipped'
  if (mode !== 'run') throw new Error('DEMO_SEED_MODE must be run or disabled in Production')

  const uri = environment.MONGODB_URI
  if (uri === undefined || uri.trim() === '') throw new Error('MONGODB_URI is required for Production demo seed')
  const expected = environment.DEMO_SEED_EXPECTED_DATABASE
  if (expected === undefined || expected.trim() === '' || expected === '(default)') {
    throw new Error('DEMO_SEED_EXPECTED_DATABASE must explicitly name the Production database')
  }
  const target = resolveTarget(uri, true)
  if (target.database !== expected) throw new Error('Production demo seed database name does not match the expected database')
  if (environment.DEMO_SERVICE_DATE === undefined || environment.DEMO_SERVICE_DATE.trim() === '') {
    throw new Error('DEMO_SERVICE_DATE is required for a stable Production demo seed')
  }
  const serviceDate = resolveServiceDate(environment.DEMO_SERVICE_DATE, new Date())

  await connect(uri)
  try {
    const database = dependencies.database()
    await assertDemoAdmin(database)
    const inventory = await dependencies.inspect(database, serviceDate)
    if (inventory.missing === 0) return 'complete'
    if (environment.GOOGLE_MAPS_SERVER_API_KEY === undefined || environment.GOOGLE_MAPS_SERVER_API_KEY.trim() === '') {
      throw new Error('GOOGLE_MAPS_SERVER_API_KEY is required when Production demo fixtures are missing')
    }
    await dependencies.seed({
      target,
      dryRun: false,
      database,
      serviceDate,
      insertOnly: true,
      providers: { geocoder: geocode, matrix: computeMatrix, route: computeRoute }
    })
    return 'seeded'
  } finally {
    await dependencies.disconnect()
  }
}

if (require.main === module) {
  void runProductionBuildSeed().then((status) => {
    process.stdout.write(`Production demo seed: ${status}\n`)
  }).catch(() => {
    process.stderr.write('Production demo seed failed; inspect configuration and provider availability without exposing credentials.\n')
    process.exitCode = 1
  })
}
