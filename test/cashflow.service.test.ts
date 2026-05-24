/**
 * TICKET-003: CashflowService — Unit Tests
 * Change: cash-flow-real-v1
 *
 * Covers all REQ scenarios from specs/cashflow-derivation/spec.md:
 *   - REQ: Amount Normalization
 *   - REQ: Cash-Date Resolution
 *   - REQ: Inflow Filter (Sale)
 *   - REQ: Outflow Filter Buy
 *   - REQ: Outflow Filter Expense
 *   - REQ: Period Filter
 *
 * Strategy: pure-unit tests — CashflowService methods are exercised with
 * in-memory mock documents (no DB connection required). We import the
 * internal helpers by accessing them through the service interface.
 *
 * TS_NODE_TRANSPILE_ONLY=1 is set by npm test; tsc build is the type gate.
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { expect } = require('chai')

// Import under test
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { resolveCashDate, buildMovements, filterByPeriod } = require('../src/services/cashflow')

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeDate (iso: string): Date {
  return new Date(iso)
}

// ─── REQ: Cash-Date Resolution ────────────────────────────────────────────────

describe('TICKET-003 — resolveCashDate', () => {
  it('returns paidAt when set (paidAt > fecha > createdAt)', () => {
    const doc = {
      paidAt: makeDate('2026-03-15'),
      fecha: makeDate('2026-03-12'),
      createdAt: makeDate('2026-03-10')
    }
    expect(resolveCashDate(doc)).to.deep.equal(makeDate('2026-03-15'))
  })

  it('returns fecha when paidAt is absent', () => {
    const doc = {
      fecha: makeDate('2026-03-12'),
      createdAt: makeDate('2026-03-10')
    }
    expect(resolveCashDate(doc)).to.deep.equal(makeDate('2026-03-12'))
  })

  it('returns createdAt when neither paidAt nor fecha exist', () => {
    const doc = {
      createdAt: makeDate('2026-03-10')
    }
    expect(resolveCashDate(doc)).to.deep.equal(makeDate('2026-03-10'))
  })
})

// ─── REQ: Amount Normalization + Inflow/Outflow Filters ──────────────────────

describe('TICKET-003 — buildMovements (normalization + filters)', () => {
  const period = {
    startDate: makeDate('2026-03-01'),
    endDate: makeDate('2026-03-31T23:59:59.999Z')
  }

  // ── Amount Normalization ──

  it('normalizes Expense.amountCents ÷ 100', () => {
    const expenses = [
      {
        _id: 'exp1',
        amountCents: 150000,
        isDeleted: false,
        category: 'alquiler',
        createdAt: makeDate('2026-03-10')
      }
    ]
    const result = buildMovements({ sales: [], buys: [], expenses }, period)
    const exp = result.find((m: any) => m.source === 'expense')
    expect(exp).to.exist
    expect(exp.amount).to.equal(1500.00)
  })

  it('uses Sale.total as-is (no conversion)', () => {
    const sales = [
      {
        _id: 'sale1',
        total: 2000.50,
        estado: 'Entregado',
        cliente: 'Test Client',
        createdAt: makeDate('2026-03-05')
      }
    ]
    const result = buildMovements({ sales, buys: [], expenses: [] }, period)
    const sale = result.find((m: any) => m.source === 'sale')
    expect(sale).to.exist
    expect(sale.amount).to.equal(2000.50)
  })

  it('uses Buy.total as-is (no conversion)', () => {
    const buys = [
      {
        _id: 'buy1',
        total: 800.00,
        estado: 'paid',
        proveedor: 'Proveedor X',
        createdAt: makeDate('2026-03-07')
      }
    ]
    const result = buildMovements({ sales: [], buys, expenses: [] }, period)
    const buy = result.find((m: any) => m.source === 'buy')
    expect(buy).to.exist
    expect(buy.amount).to.equal(800.00)
  })

  // ── Inflow Filter (Sale) ──

  it('includes Sale with estado != Cancelado as inflow', () => {
    const sales = [
      { _id: 's1', total: 100, estado: 'Entregado', cliente: 'C1', createdAt: makeDate('2026-03-05') }
    ]
    const result = buildMovements({ sales, buys: [], expenses: [] }, period)
    expect(result.some((m: any) => m.source === 'sale' && m.type === 'inflow')).to.equal(true)
  })

  it('excludes Sale with estado = Cancelado', () => {
    const sales = [
      { _id: 's2', total: 200, estado: 'Cancelado', cliente: 'C2', createdAt: makeDate('2026-03-05') }
    ]
    const result = buildMovements({ sales, buys: [], expenses: [] }, period)
    expect(result.some((m: any) => m.source === 'sale')).to.equal(false)
  })

  // ── Outflow Filter (Buy) ──

  it('includes Buy with estado = paid as outflow', () => {
    const buys = [
      { _id: 'b1', total: 500, estado: 'paid', proveedor: 'P1', createdAt: makeDate('2026-03-08') }
    ]
    const result = buildMovements({ sales: [], buys, expenses: [] }, period)
    expect(result.some((m: any) => m.source === 'buy' && m.type === 'outflow')).to.equal(true)
  })

  it('excludes Buy with estado != paid (e.g. Entregado)', () => {
    const buys = [
      { _id: 'b2', total: 500, estado: 'Entregado', proveedor: 'P2', createdAt: makeDate('2026-03-08') }
    ]
    const result = buildMovements({ sales: [], buys, expenses: [] }, period)
    expect(result.some((m: any) => m.source === 'buy')).to.equal(false)
  })

  // ── Outflow Filter (Expense) ──

  it('includes Expense with isDeleted = false as outflow', () => {
    const expenses = [
      { _id: 'e1', amountCents: 5000, isDeleted: false, category: 'luz', createdAt: makeDate('2026-03-09') }
    ]
    const result = buildMovements({ sales: [], buys: [], expenses }, period)
    expect(result.some((m: any) => m.source === 'expense' && m.type === 'outflow')).to.equal(true)
  })

  it('excludes Expense with isDeleted = true', () => {
    const expenses = [
      { _id: 'e2', amountCents: 5000, isDeleted: true, category: 'luz', createdAt: makeDate('2026-03-09') }
    ]
    const result = buildMovements({ sales: [], buys: [], expenses }, period)
    expect(result.some((m: any) => m.source === 'expense')).to.equal(false)
  })
})

// ─── REQ: Period Filter ───────────────────────────────────────────────────────

describe('TICKET-003 — filterByPeriod', () => {
  const start = makeDate('2026-03-01')
  const end = makeDate('2026-03-31T23:59:59.999Z')

  it('includes movement whose cashDate falls within range (inclusive)', () => {
    const movements = [
      { date: makeDate('2026-03-20'), type: 'inflow', amount: 100, source: 'sale', description: 'x', sourceId: '1' }
    ]
    const result = filterByPeriod(movements, start, end)
    expect(result).to.have.length(1)
  })

  it('excludes movement whose cashDate falls outside range', () => {
    const movements = [
      { date: makeDate('2026-04-05'), type: 'inflow', amount: 100, source: 'sale', description: 'x', sourceId: '2' }
    ]
    const result = filterByPeriod(movements, start, end)
    expect(result).to.have.length(0)
  })

  it('includes boundary dates (start inclusive)', () => {
    const movements = [
      { date: makeDate('2026-03-01T00:00:00.000Z'), type: 'inflow', amount: 50, source: 'sale', description: 'x', sourceId: '3' }
    ]
    const result = filterByPeriod(movements, start, end)
    expect(result).to.have.length(1)
  })
})
