import { expect } from 'chai'
import { createRequire } from 'module'

import { SIMULATION_DATA_QUALITY } from '../../src/interfaces/simulation.interface'
import {
  CAPTURED_AT,
  USER_ID,
  validCalculation,
  validRouteSnapshot,
  validRun,
  validStockSnapshot
} from './fixtures'

interface VerificationResult {
  failures: string[]
  indexes: Array<{ collection: string, name: string }>
  runsChecked: number
  configurationsChecked: number
  presetsChecked: number
  structuralValidationCheck: string
  modelImmutabilityCheck: string
}

interface VerificationModule {
  validateRun: (run: unknown, failures: string[]) => void
  verify: (db: unknown) => Promise<VerificationResult>
}

const requireFromTest = createRequire(__filename)
const { validateRun, verify } = requireFromTest('../../migrations/simulation-004-verify.js') as VerificationModule

describe('Simulation migration - persisted structural verification', () => {
  const persistedRun = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    _id: USER_ID,
    ...validRun,
    createdBy: USER_ID,
    versions: { ...validRun.versions, calculatedAt: new Date(CAPTURED_AT) },
    ...overrides
  })

  it('TC-012: accepts structurally complete persisted evidence', () => {
    const failures: string[] = []
    validateRun(persistedRun(), failures)
    expect(failures).to.deep.equal([])
  })

  it('TC-012: rejects malformed persisted evidence consistently with model validation', () => {
    const emptyActor: string[] = []
    validateRun(persistedRun({ createdBy: '' }), emptyActor)
    expect(emptyActor.some((failure) => failure.includes('no actor evidence'))).to.equal(true)

    const malformedRoute: string[] = []
    validateRun(persistedRun({ routeSnapshot: { ...validRouteSnapshot, capacity: undefined } }), malformedRoute)
    expect(malformedRoute.some((failure) => failure.includes('invalid route capacity'))).to.equal(true)

    const malformedStock: string[] = []
    validateRun(persistedRun({
      stockSnapshot: {
        ...validStockSnapshot,
        products: [{ ...validStockSnapshot.products[0], presalePriceArs: undefined }]
      }
    }), malformedStock)
    expect(malformedStock.some((failure) => failure.includes('invalid stock product'))).to.equal(true)

    const missingAmount: string[] = []
    validateRun(persistedRun({
      calculation: { ...validCalculation, components: [{ code: 'fuel' }] }
    }), missingAmount)
    expect(missingAmount.some((failure) => failure.includes('invalid calculation component'))).to.equal(true)

    const inconsistentRecommendation: string[] = []
    validateRun(persistedRun({
      calculation: { ...validCalculation, dataQuality: SIMULATION_DATA_QUALITY.INCOMPLETE }
    }), inconsistentRecommendation)
    expect(inconsistentRecommendation.some((failure) => failure.includes('recommends an incomplete or non-viable calculation'))).to.equal(true)
  })

  it('TC-012: rejects impossible civil dates in persisted evidence while accepting real leap-year dates', () => {
    const impossibleDay: string[] = []
    validateRun(persistedRun({
      routeSnapshot: { ...validRouteSnapshot, capturedAt: '2026-02-30T12:00:00.000Z' }
    }), impossibleDay)
    expect(impossibleDay.some((failure) => failure.includes('invalid route capture timestamp'))).to.equal(true)

    const impossibleMonthEnd: string[] = []
    validateRun(persistedRun({
      stockSnapshot: { ...validStockSnapshot, capturedAt: '2026-04-31T12:00:00.000Z' },
      calculation: { ...validCalculation, calculatedAt: '2026-02-29T12:00:00.000Z' }
    }), impossibleMonthEnd)
    expect(impossibleMonthEnd.some((failure) => failure.includes('invalid stock capture timestamp'))).to.equal(true)
    expect(impossibleMonthEnd.some((failure) => failure.includes('invalid calculation timestamp'))).to.equal(true)

    const leapDay: string[] = []
    validateRun(persistedRun({
      routeSnapshot: { ...validRouteSnapshot, capturedAt: '2024-02-29T12:00:00.000Z' },
      stockSnapshot: { ...validStockSnapshot, capturedAt: '2024-02-29T12:00:00.000Z' },
      calculation: { ...validCalculation, calculatedAt: '2024-02-29T12:00:00.000Z' }
    }), leapDay)
    expect(leapDay).to.deep.equal([])
  })

  it('TC-013: iterates persisted collections incrementally instead of materializing them', async () => {
    const cursorFor = (documents: unknown[]): unknown => {
      let index = 0
      return {
        toArray: async () => {
          throw new Error('collection was materialized with toArray')
        },
        [Symbol.asyncIterator]: () => ({
          next: async () => {
            if (index >= documents.length) return { done: true, value: undefined }
            const value = documents[index]
            index += 1
            return { done: false, value }
          }
        })
      }
    }
    const documents: Record<string, unknown[]> = {
      simulationruns: [persistedRun(), persistedRun({ _id: '507f1f77bcf86cd799439016' })],
      simulationconfigversions: [],
      simulationpresetversions: []
    }
    const db = {
      listCollections: () => ({ toArray: async () => Object.keys(documents).map((name) => ({ name })) }),
      collection: (name: string) => ({
        indexes: async () => [],
        find: () => cursorFor(documents[name] ?? [])
      })
    }

    const result = await verify(db)
    expect(result.runsChecked).to.equal(2)
    expect(result.configurationsChecked).to.equal(0)
    expect(result.presetsChecked).to.equal(0)
  })
})
