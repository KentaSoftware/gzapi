/**
 * TICKET-002: Domain Models & Interfaces
 * Tests: paidAt on Sale, paidAt on Buy, CashflowConfig model, cashflow.interface types
 *
 * Strategy: use synchronous require() — the project compiles to CommonJS.
 * TS_NODE_TRANSPILE_ONLY=1 skips type-checking at test runtime; tsc build is the
 * authoritative type check.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { expect } = require('chai')

// ─── Sale interface structural test ──────────────────────────────────────────

describe('TICKET-002: Sale interface', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const SaleModel = require('../src/models/sale').default

  it('should have paidAt as an optional Date field on Sale schema', () => {
    const paths = SaleModel.schema.paths
    expect(paths).to.have.property('paidAt')
    expect(paths.paidAt.instance).to.equal('Date')
    // required: false → isRequired is undefined/false/null
    expect(paths.paidAt.isRequired).to.be.oneOf([false, undefined, null])
  })

  it('module loads without error (retrocompatible — no required paidAt)', () => {
    // If ISale required paidAt, existing code using Sale without it would fail tsc.
    // At runtime, just assert the module loaded cleanly.
    expect(SaleModel).to.exist
  })
})

// ─── Buy interface structural test ───────────────────────────────────────────

describe('TICKET-002: Buy interface', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const BuyModel = require('../src/models/buy').default

  it('should have paidAt as an optional Date field on Buy schema', () => {
    const paths = BuyModel.schema.paths
    expect(paths).to.have.property('paidAt')
    expect(paths.paidAt.instance).to.equal('Date')
    expect(paths.paidAt.isRequired).to.be.oneOf([false, undefined, null])
  })

  it('module loads without error (retrocompatible — no required paidAt)', () => {
    expect(BuyModel).to.exist
  })
})

// ─── CashflowConfig model structural test ────────────────────────────────────

describe('TICKET-002: CashflowConfig model', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const CashflowConfigModel = require('../src/models/cashflowConfig').default

  it('should export a Mongoose model with openingBalance field of type Number', () => {
    const paths = CashflowConfigModel.schema.paths
    expect(paths).to.have.property('openingBalance')
    expect(paths.openingBalance.instance).to.equal('Number')
  })

  it('openingBalance should default to 0', () => {
    const paths = CashflowConfigModel.schema.paths
    expect(paths.openingBalance.defaultValue).to.equal(0)
  })
})

// ─── cashflow.interface types structural test ─────────────────────────────────

describe('TICKET-002: cashflow.interface types', () => {
  it('module cashflow.interface loads without error', () => {
    // Type-only exports are erased at runtime; their existence is proven by tsc.
    // We assert the module loads cleanly — any missing export caught at compile time.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const iface = require('../src/interfaces/cashflow.interface')
    expect(iface).to.be.an('object')
  })
})
