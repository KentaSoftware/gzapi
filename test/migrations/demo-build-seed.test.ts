import { expect } from 'chai'
import { Types } from 'mongoose'
import { runProductionStartupSeed } from '../../migrations/demo-002-build-seed'
import type { DemoDatabase } from '../../migrations/demo-001-seed-data'

const production = {
  VERCEL_ENV: 'production',
  MONGODB_URI: 'mongodb://127.0.0.1:27017/demo',
  GOOGLE_MAPS_SERVER_API_KEY: 'offline-test-placeholder'
}

const databaseWithAdmin = (present: boolean): DemoDatabase => ({
  collection: () => ({
    findOne: async () => present ? { _id: new Types.ObjectId('507f1f77bcf86cd799439011') } : null,
    updateOne: async () => { throw new Error('Unexpected database write') }
  })
})

describe('demo seed production startup', () => {
  it('skips outside Production before inspecting fixtures or credentials', async () => {
    for (const environment of [
      { VERCEL_ENV: undefined }, { VERCEL_ENV: 'preview' },
      { VERCEL_ENV: 'development' }, { VERCEL_ENV: 'production', NODE_ENV: 'test' }
    ]) {
      expect(await runProductionStartupSeed(environment, {
        database: () => { throw new Error('Unexpected database access') },
        inspect: async () => { throw new Error('Unexpected inventory') },
        seed: async () => { throw new Error('Unexpected seed') }
      })).to.equal('skipped')
    }
  })

  it('requires a configured MongoDB URI before inventory', async () => {
    for (const [environment, message] of [
      [{ VERCEL_ENV: 'production' }, 'MONGODB_URI']
    ] as const) {
      try {
        await runProductionStartupSeed(environment, {
          database: () => { throw new Error('Unexpected database access') },
          inspect: async () => { throw new Error('Unexpected inventory') },
          seed: async () => { throw new Error('Unexpected seed') }
        })
        expect.fail('Expected unsafe target failure')
      } catch (error) {
        expect((error as Error).message).to.contain(message)
      }
    }
  })

  it('checks admin and skips Google when the fixed-anchor inventory is complete', async () => {
    let date: Date | undefined
    const result = await runProductionStartupSeed({ ...production, GOOGLE_MAPS_SERVER_API_KEY: undefined }, {
      database: () => databaseWithAdmin(true),
      inspect: async (_database, serviceDate) => {
        date = serviceDate
        return { total: 578, missing: 0 }
      },
      seed: async () => { throw new Error('Unexpected provider access') }
    })
    expect(result).to.equal('complete')
    expect(date?.toISOString()).to.equal('2026-10-21T00:00:00.000Z')
  })

  it('fails closed without base admin even for complete fixtures', async () => {
    try {
      await runProductionStartupSeed(production, {
        database: () => databaseWithAdmin(false),
        inspect: async () => ({ total: 578, missing: 0 }),
        seed: async () => { throw new Error('Unexpected seed') }
      })
      expect.fail('Expected missing admin')
    } catch (error) {
      expect((error as Error).message).to.contain('base admin user is required')
    }
  })

  it('requires Google credentials only for missing fixtures', async () => {
    try {
      await runProductionStartupSeed({ ...production, GOOGLE_MAPS_SERVER_API_KEY: undefined }, {
        database: () => databaseWithAdmin(true),
        inspect: async () => ({ total: 578, missing: 1 }),
        seed: async () => { throw new Error('Unexpected seed') }
      })
      expect.fail('Expected missing Google key')
    } catch (error) {
      expect((error as Error).message).to.contain('GOOGLE_MAPS_SERVER_API_KEY')
    }
  })

  it('uses insert-only repair on the stable date and propagates provider failure', async () => {
    let called = 0
    const dependencies = {
      database: () => databaseWithAdmin(true),
      inspect: async () => ({ total: 578, missing: 1 }),
      seed: async (input: Parameters<typeof import('../../migrations/demo-001-seed-data').runDemoSeed>[0]) => {
        called += 1
        expect(input.insertOnly).to.equal(true)
        expect(input.serviceDate?.toISOString()).to.equal('2026-10-21T00:00:00.000Z')
        if (called === 1) throw new Error('Offline DRIVE failure')
        return { dryRun: false as const, target: { database: 'demo', remote: false }, addressCount: 21 }
      }
    }
    try {
      await runProductionStartupSeed(production, dependencies)
      expect.fail('Expected provider failure')
    } catch (error) {
      expect((error as Error).message).to.equal('Offline DRIVE failure')
    }
    expect(await runProductionStartupSeed(production, dependencies)).to.equal('seeded')
    expect(called).to.equal(2)
  })
})
