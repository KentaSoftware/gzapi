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

interface VerificationModule {
  validateRun: (run: unknown, failures: string[]) => void
}

const requireFromTest = createRequire(__filename)
const { validateRun } = requireFromTest('../../migrations/simulation-004-verify.js') as VerificationModule

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
})
