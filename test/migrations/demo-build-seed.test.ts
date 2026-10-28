import { expect } from 'chai'
import { runProductionBuildSeed } from '../../migrations/demo-002-build-seed'
import type { DemoDatabase } from '../../migrations/demo-001-seed-data'
import { Types } from 'mongoose'

const production = {
  VERCEL_ENV: 'production',
  DEMO_SEED_MODE: 'run',
  MONGODB_URI: 'mongodb://127.0.0.1:27017/demo',
  DEMO_SEED_EXPECTED_DATABASE: 'demo',
  DEMO_SERVICE_DATE: '2026-10-21',
  GOOGLE_MAPS_SERVER_API_KEY: 'offline-test-placeholder'
}

const databaseWithAdmin = (present: boolean): DemoDatabase => ({
  collection: () => ({
    findOne: async () => present ? { _id: new Types.ObjectId('507f1f77bcf86cd799439011') } : null,
    updateOne: async () => { throw new Error('Unexpected database write') }
  })
})

describe('demo seed production build', () => {
  it('does not open a connection outside Production', async () => {
    let calls = 0
    for (const stage of [undefined, 'preview', 'development']) {
      const result = await runProductionBuildSeed({ VERCEL_ENV: stage, DEMO_SEED_MODE: 'run' }, async () => {
        calls += 1
        throw new Error('Unexpected connection')
      })
      expect(result).to.equal('skipped')
    }
    expect(calls).to.equal(0)
  })

  it('skips Production with no mode or disabled mode before requiring URI or Google credentials', async () => {
    let calls = 0
    for (const mode of [undefined, 'disabled']) {
      const result = await runProductionBuildSeed({ VERCEL_ENV: 'production', DEMO_SEED_MODE: mode }, async () => {
        calls += 1
        throw new Error('Unexpected connection')
      })
      expect(result).to.equal('skipped')
    }
    expect(calls).to.equal(0)
  })

  it('rejects unexpected Production modes without connecting or seeding', async () => {
    let calls = 0
    for (const mode of ['', 'RUN', 'enabled', ' run ']) {
      try {
        await runProductionBuildSeed({ VERCEL_ENV: 'production', DEMO_SEED_MODE: mode }, async () => { calls += 1 })
        expect.fail('Expected invalid mode failure')
      } catch (error) {
        expect((error as Error).message).to.contain('DEMO_SEED_MODE')
      }
    }
    expect(calls).to.equal(0)
  })

  it('skips Preview even with run mode and missing credentials', async () => {
    let calls = 0
    expect(await runProductionBuildSeed({ VERCEL_ENV: 'preview', DEMO_SEED_MODE: 'run' }, async () => { calls += 1 })).to.equal('skipped')
    expect(calls).to.equal(0)
  })

  it('rejects missing configuration before connecting in Production', async () => {
    let calls = 0
    try {
      await runProductionBuildSeed({ VERCEL_ENV: 'production', DEMO_SEED_MODE: 'run' }, async () => { calls += 1 })
      expect.fail('Expected missing target failure')
    } catch (error) {
      expect((error as Error).message).to.contain('MONGODB_URI')
    }
    expect(calls).to.equal(0)
  })

  it('requires the exact explicit database name and fixed calendar date before connecting', async () => {
    const baseline = {
      VERCEL_ENV: 'production',
      DEMO_SEED_MODE: 'run',
      MONGODB_URI: 'mongodb://127.0.0.1:27017/demo',
      DEMO_SEED_EXPECTED_DATABASE: 'demo',
      DEMO_SERVICE_DATE: '2026-10-21'
    }
    let calls = 0
    for (const [environment, errorText] of [
      [{ ...baseline, DEMO_SEED_EXPECTED_DATABASE: '' }, 'DEMO_SEED_EXPECTED_DATABASE'],
      [{ ...baseline, DEMO_SEED_EXPECTED_DATABASE: 'other' }, 'does not match'],
      [{ ...baseline, DEMO_SERVICE_DATE: '' }, 'DEMO_SERVICE_DATE'],
      [{ ...baseline, DEMO_SERVICE_DATE: '2026-02-30' }, 'real calendar date']
    ] as const) {
      try {
        await runProductionBuildSeed(environment, async () => { calls += 1 })
        expect.fail('Expected validation failure')
      } catch (error) {
        expect((error as Error).message).to.contain(errorText)
      }
    }
    expect(calls).to.equal(0)
  })

  it('fails closed and disconnects if a complete fixture inventory has no admin', async () => {
    let disconnected = 0
    let seeded = 0
    try {
      await runProductionBuildSeed(production, async () => {}, {
        database: () => databaseWithAdmin(false),
        inspect: async () => ({ total: 578, missing: 0 }),
        seed: async () => { seeded += 1; throw new Error('Unexpected seed') },
        disconnect: async () => { disconnected += 1 }
      })
      expect.fail('Expected missing admin')
    } catch (error) {
      expect((error as Error).message).to.contain('base admin user is required')
    }
    expect(seeded).to.equal(0)
    expect(disconnected).to.equal(1)
  })

  it('returns complete without Google or writes and disconnects on success', async () => {
    let connections = 0
    let disconnections = 0
    const result = await runProductionBuildSeed({ ...production, GOOGLE_MAPS_SERVER_API_KEY: undefined }, async () => { connections += 1 }, {
      database: () => databaseWithAdmin(true),
      inspect: async () => ({ total: 578, missing: 0 }),
      seed: async () => { throw new Error('Unexpected seed') },
      disconnect: async () => { disconnections += 1 }
    })
    expect(result).to.equal('complete')
    expect(connections).to.equal(1)
    expect(disconnections).to.equal(1)
  })

  it('seeds missing fixtures through the insert-only path and disconnects', async () => {
    let insertOnly: boolean | undefined
    let disconnections = 0
    const result = await runProductionBuildSeed(production, async () => {}, {
      database: () => databaseWithAdmin(true),
      inspect: async () => ({ total: 578, missing: 1 }),
      seed: async (input) => {
        insertOnly = input.insertOnly
        return { dryRun: false, target: { database: 'demo', remote: false }, addressCount: 21 }
      },
      disconnect: async () => { disconnections += 1 }
    })
    expect(result).to.equal('seeded')
    expect(insertOnly).to.equal(true)
    expect(disconnections).to.equal(1)
  })

  it('rejects missing Google configuration when fixtures are absent and disconnects', async () => {
    let disconnections = 0
    try {
      await runProductionBuildSeed({ ...production, GOOGLE_MAPS_SERVER_API_KEY: undefined }, async () => {}, {
        database: () => databaseWithAdmin(true),
        inspect: async () => ({ total: 578, missing: 1 }),
        seed: async () => { throw new Error('Unexpected seed') },
        disconnect: async () => { disconnections += 1 }
      })
      expect.fail('Expected missing key failure')
    } catch (error) {
      expect((error as Error).message).to.contain('GOOGLE_MAPS_SERVER_API_KEY')
    }
    expect(disconnections).to.equal(1)
  })

  it('disconnects when a prepared seed fails', async () => {
    let disconnections = 0
    try {
      await runProductionBuildSeed(production, async () => {}, {
        database: () => databaseWithAdmin(true),
        inspect: async () => ({ total: 578, missing: 1 }),
        seed: async () => { throw new Error('Offline provider failure') },
        disconnect: async () => { disconnections += 1 }
      })
      expect.fail('Expected provider failure')
    } catch (error) {
      expect((error as Error).message).to.equal('Offline provider failure')
    }
    expect(disconnections).to.equal(1)
  })
})
