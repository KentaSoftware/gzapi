import { connect, disconnect } from 'mongoose'
import { seedDatabase } from '../src/services/seed'
import { runProductionStartupSeed } from './demo-002-build-seed'

// Runs during the Vercel build. Fails the build when the base or demo data cannot be written.
const main = async (): Promise<void> => {
  if (process.env.VERCEL_ENV !== 'production') {
    process.stdout.write('Build seed skipped outside Production\n')
    return
  }
  const uri = process.env.MONGODB_URI?.trim()
  if (uri === undefined || uri === '') throw new Error('MONGODB_URI is required for the build seed')

  await connect(uri)
  try {
    await seedDatabase()
    const result = await runProductionStartupSeed(process.env)
    process.stdout.write(`Build seed result: ${result}\n`)
  } finally {
    await disconnect()
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Build seed failed'
  process.stderr.write(`Build seed failed: ${message.replace(/mongodb(?:\+srv)?:\/\/\S+/gi, '[redacted MongoDB target]')}\n`)
  process.exit(1)
})
