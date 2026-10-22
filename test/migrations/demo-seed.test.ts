import { expect } from 'chai'
import {
  parseDemoArguments,
  resolveTarget,
  runDemoSeed,
  selectRoadSafeCandidate,
  upsertFixture,
  validateRoadConnectivity
} from '../../migrations/demo-001-seed-data'
import { GEOCODING_PRECISION } from '../../src/interfaces/client.interface'
import type { FixtureCollection } from '../../migrations/demo-001-seed-data'
import type { RouteLocation } from '../../src/interfaces/routeOptimization.interface'
import { Types } from 'mongoose'

const candidate = {
  formattedAddress: '25 de Mayo 90, San Miguel de Tucumán, Tucumán, Argentina',
  placeId: 'provider-place-id',
  precision: GEOCODING_PRECISION.ROOFTOP,
  lat: -26.8317,
  lng: -65.2032
}

const locations: RouteLocation[] = [
  { id: 'depot', name: 'Depot', latitude: -26.83, longitude: -65.2 },
  { id: 'client-1', name: 'Client', latitude: -26.8317, longitude: -65.2032 }
]

describe('demo seed safety seams', () => {
  it('rejects a remote target without explicit confirmation', () => {
    expect(() => resolveTarget('mongodb+srv://cluster.example/gzapi', false)).to.throw('explicit --confirm-remote')
    expect(resolveTarget('mongodb://127.0.0.1:27017/gzapi', false).remote).to.equal(false)
  })

  it('dry-run argument parsing does not require or expose a target credential', () => {
    const result = parseDemoArguments(['--dry-run'], { MONGODB_URI: 'mongodb://127.0.0.1:27017/gzapi' })
    expect(result.dryRun).to.equal(true)
    expect(result.target.database).to.equal('gzapi')
  })

  it('dry-run execution performs no database access or writes', async () => {
    let collectionCalls = 0
    const result = await runDemoSeed({
      target: resolveTarget('mongodb://127.0.0.1:27017/gzapi', false),
      dryRun: true,
      database: {
        collection: (): FixtureCollection => {
          collectionCalls += 1
          return {
            findOne: async () => null,
            updateOne: async () => ({ upsertedCount: 0, modifiedCount: 0 })
          }
        }
      }
    })
    expect(result.dryRun).to.equal(true)
    expect(collectionCalls).to.equal(0)
  })

  it('rejects approximate geocoding results', () => {
    expect(() => selectRoadSafeCandidate([{ ...candidate, precision: GEOCODING_PRECISION.APPROXIMATE }], 'demo address')).to.throw('road-safe precision')
    expect(() => selectRoadSafeCandidate([], 'demo address')).to.throw('empty or ambiguous')
  })

  it('rejects an unroutable client before persistence', async () => {
    const matrix = async (): Promise<{ segments: [] }> => ({ segments: [] })
    try {
      await validateRoadConnectivity(locations[0], [locations[1]], matrix)
      expect.fail('Expected missing reverse route to fail')
    } catch (error) {
      expect(error).to.be.instanceOf(Error)
      expect((error as Error).message).to.contain('DRIVE route')
    }
  })

  it('uses the same deterministic fixture key for repeat upserts', async () => {
    const calls: Array<{ filter: Record<string, unknown>, id: unknown }> = []
    const collection: FixtureCollection = {
      findOne: async () => null,
      updateOne: async (filter) => {
        calls.push({ filter, id: filter._id })
        return { upsertedCount: calls.length === 1 ? 1 : 0, modifiedCount: calls.length === 1 ? 0 : 1 }
      }
    }
    const id = new Types.ObjectId('507f1f77bcf86cd799439011')
    expect(await upsertFixture(collection, 'client:centro:1', id, { name: 'demo' }, new Date('2026-10-01T00:00:00.000Z'))).to.equal('inserted')
    expect(await upsertFixture(collection, 'client:centro:1', id, { name: 'demo' }, new Date('2026-10-01T00:00:00.000Z'))).to.equal('updated')
    expect(calls).to.have.length(2)
    expect(calls[0].id).to.equal(calls[1].id)
    expect(calls[0].filter.fixtureNamespace).to.equal('gzapi-demo-seed-v1')
  })
})
