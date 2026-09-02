/**
 * CashflowService — TICKET-003: cash-flow-real-v1
 *
 * Live derivation of cash-flow from Sale, Buy, and Expense collections.
 * No persisted ledger. All monetary values normalized to plain decimal (ARS).
 *
 * Design constraints (design.md):
 *  - Amount unit: plain decimal. Expense.amountCents ÷ 100 here; never reuse getSimpleResult().
 *  - Cash-date priority chain: paidAt > fecha > createdAt
 *  - Inflow filter: Sale.estado !== 'Cancelado'
 *  - Outflow filter Buy: Buy.estado === 'paid'
 *  - Outflow filter Expense: isDeleted is falsy
 *  - CashflowConfig singleton: upserted with openingBalance = 0 if missing
 */

import SaleModel from '../models/sale'
import BuyModel from '../models/buy'
import ExpenseModel from '../models/expense'
import CashflowConfigModel from '../models/cashflowConfig'
import {
  CashflowMovement,
  CashflowSummary,
  CashflowConfig
} from '../interfaces/cashflow.interface'

// ─── Exported helpers (also used by unit tests directly) ─────────────────────

/**
 * Resolves the effective cash date for a document.
 * Priority chain: paidAt → fecha → createdAt
 */
export function resolveCashDate (doc: any): Date {
  return doc.paidAt ?? doc.fecha ?? doc.createdAt
}

/**
 * Filters a pre-built movements array to the inclusive [startDate, endDate] range.
 */
export function filterByPeriod (
  movements: CashflowMovement[],
  startDate: Date,
  endDate: Date
): CashflowMovement[] {
  return movements.filter(m => m.date >= startDate && m.date <= endDate)
}

/**
 * Builds a flat CashflowMovement[] from raw document arrays.
 * All filtering (inflow/outflow rules, period) is applied here.
 *
 * Exported for unit testing without DB dependency.
 */
export function buildMovements (
  docs: {
    sales: any[]
    buys: any[]
    expenses: any[]
  },
  period: { startDate: Date; endDate: Date }
): CashflowMovement[] {
  const movements: CashflowMovement[] = []

  // ── Sales → inflows (exclude Cancelado) ──
  for (const sale of docs.sales) {
    if (sale.estado === 'Cancelado') continue
    const date = resolveCashDate(sale)
    if (date < period.startDate || date > period.endDate) continue
    movements.push({
      date,
      type: 'inflow',
      amount: sale.total,
      source: 'sale',
      description: sale.cliente ?? '',
      sourceId: String(sale._id)
    })
  }

  // ── Buys → outflows (only estado = 'paid') ──
  for (const buy of docs.buys) {
    if (buy.estado !== 'paid') continue
    const date = resolveCashDate(buy)
    if (date < period.startDate || date > period.endDate) continue
    movements.push({
      date,
      type: 'outflow',
      amount: Number(buy.total),
      source: 'buy',
      description: buy.proveedor ?? '',
      sourceId: String(buy._id)
    })
  }

  // ── Expenses → outflows (exclude soft-deleted) ──
  for (const expense of docs.expenses) {
    if (expense.isDeleted) continue
    const date = resolveCashDate(expense)
    if (date < period.startDate || date > period.endDate) continue
    movements.push({
      date,
      type: 'outflow',
      // amountCents ÷ 100 — single normalization point (design.md)
      amount: expense.amountCents / 100,
      source: 'expense',
      description: expense.category ?? '',
      sourceId: String(expense._id)
    })
  }

  return movements
}

// ─── Service class ────────────────────────────────────────────────────────────

class CashflowService {
  /**
   * Returns all cash movements for the given period.
   * Queries DB, then delegates to buildMovements (pure, testable).
   */
  async computeMovements (startDate: Date, endDate: Date): Promise<CashflowMovement[]> {
    const [sales, buys, expenses] = await Promise.all([
      SaleModel.find({ estado: { $ne: 'Cancelado' } }).lean(),
      BuyModel.find({ estado: 'paid' }).lean(),
      ExpenseModel.find({ isDeleted: { $ne: true } }).lean()
    ])

    return buildMovements(
      { sales, buys, expenses },
      { startDate, endDate }
    )
  }

  /**
   * Aggregates movements into a CashflowSummary for the given period.
   * Fetches openingBalance from CashflowConfig singleton (upsert if missing).
   */
  async computeSummary (startDate: Date, endDate: Date): Promise<CashflowSummary> {
    const [movements, config] = await Promise.all([
      this.computeMovements(startDate, endDate),
      this.getOrCreateConfig()
    ])

    const totalInflows = round2(
      movements
        .filter(m => m.type === 'inflow')
        .reduce((sum, m) => sum + m.amount, 0)
    )

    const totalOutflows = round2(
      movements
        .filter(m => m.type === 'outflow')
        .reduce((sum, m) => sum + m.amount, 0)
    )

    const netCashFlow = round2(totalInflows - totalOutflows)
    const closingBalance = round2(config.openingBalance + netCashFlow)

    return {
      openingBalance: config.openingBalance,
      totalInflows,
      totalOutflows,
      netCashFlow,
      closingBalance
    }
  }

  /**
   * Returns the CashflowConfig singleton, creating it with openingBalance = 0
   * if it does not yet exist.
   */
  async getOrCreateConfig (): Promise<CashflowConfig> {
    const doc = await CashflowConfigModel.findOneAndUpdate(
      {},
      { $setOnInsert: { openingBalance: 0 } },
      { upsert: true, new: true }
    ).lean()
    return { openingBalance: doc!.openingBalance }
  }

  /**
   * Updates the CashflowConfig singleton's openingBalance.
   */
  async updateConfig (openingBalance: number): Promise<CashflowConfig> {
    const doc = await CashflowConfigModel.findOneAndUpdate(
      {},
      { $set: { openingBalance } },
      { upsert: true, new: true }
    ).lean()
    return { openingBalance: doc!.openingBalance }
  }
}

// ─── Private helpers ──────────────────────────────────────────────────────────

function round2 (value: number): number {
  return parseFloat(value.toFixed(2))
}

export default new CashflowService()
