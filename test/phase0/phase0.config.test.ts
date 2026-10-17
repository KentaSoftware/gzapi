import { expect } from 'chai'

import { isPhase0ContractsEnabled } from '../../src/config/phase0'

describe('Phase 0 contract gate configuration', () => {
  let originalFlag: string | undefined

  beforeEach(() => {
    originalFlag = process.env.PHASE_0_CONTRACTS_ENABLED
  })

  afterEach(() => {
    if (originalFlag === undefined) {
      delete process.env.PHASE_0_CONTRACTS_ENABLED
    } else {
      process.env.PHASE_0_CONTRACTS_ENABLED = originalFlag
    }
  })

  it('defaults to false when the environment variable is unset', () => {
    delete process.env.PHASE_0_CONTRACTS_ENABLED

    expect(isPhase0ContractsEnabled()).to.equal(false)
  })

  it('returns false for an explicit false value', () => {
    process.env.PHASE_0_CONTRACTS_ENABLED = 'false'

    expect(isPhase0ContractsEnabled()).to.equal(false)
  })

  it('returns false for arbitrary values other than exact true', () => {
    process.env.PHASE_0_CONTRACTS_ENABLED = 'TRUE'

    expect(isPhase0ContractsEnabled()).to.equal(false)
  })

  it('returns true only for the exact true value', () => {
    process.env.PHASE_0_CONTRACTS_ENABLED = 'true'

    expect(isPhase0ContractsEnabled()).to.equal(true)
  })
})
