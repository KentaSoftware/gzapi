import { computeMatrix, computeRoute } from '../src/services/routeMatrixProvider'
import { geocode } from '../src/services/geocodingProvider'
import { assertDemoAdmin, inspectDemoFixtures, mongoDatabase, resolveServiceDate, resolveTarget, runDemoSeed } from './demo-001-seed-data'

type Environment = Record<string, string | undefined>

interface StartupSeedDependencies {
  database: typeof mongoDatabase
  inspect: typeof inspectDemoFixtures
  seed: typeof runDemoSeed
}

const defaultDependencies: StartupSeedDependencies = {
  database: mongoDatabase,
  inspect: inspectDemoFixtures,
  seed: runDemoSeed
}

// Stable across cold starts: the six-month fixture window does not follow today's date.
// Changing this anchor intentionally creates a new set of deterministic monthly IDs.
export const DEMO_STARTUP_SERVICE_DATE = '2026-10-21'

/** Runs only after the base seed has ensured the admin on the existing connection. */
export const runProductionStartupSeed = async (
  environment: Environment = process.env,
  dependencies: StartupSeedDependencies = defaultDependencies
): Promise<'skipped' | 'complete' | 'seeded'> => {
  if (environment.VERCEL_ENV !== 'production' || environment.NODE_ENV === 'test') return 'skipped'

  const uri = environment.MONGODB_URI
  if (uri === undefined || uri.trim() === '') throw new Error('MONGODB_URI is required for Production demo seed')
  const target = resolveTarget(uri.trim(), true)
  if (target.database === '(default)') throw new Error('Production demo seed requires an explicit database in MONGODB_URI')
  const serviceDate = resolveServiceDate(DEMO_STARTUP_SERVICE_DATE, new Date())

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
}
