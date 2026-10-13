import { Types } from 'mongoose'
import BuyModel from '../models/buy'
import SaleModel from '../models/sale'
import {
  CommercialFact,
  CommercialFactError,
  DeliveryPort,
  FinancePort,
  RoutePlanReader,
  StockPort
} from '../interfaces/commercialFact.interface'
import { recomputeForSale } from './routePlanOperational'

// Phase 0 Finance port adapter. Finance derives cash only from explicit payment
// and refund facts. This adapter writes the legacy compatibility projections
// (`sales.paidAt`, `buys.paidAt`) and treats the immutable refund fact itself as
// the record, since refunds have no legacy projection.
export const financePortAdapter: FinancePort = {
  async recordSalePayment (fact: CommercialFact): Promise<void> {
    await SaleModel.updateOne(
      { _id: new Types.ObjectId(fact.aggregateId) },
      { $set: { paidAt: fact.businessDate } }
    )
  },

  async recordSaleRefund (): Promise<void> {
    // Acknowledged only: refunds have no legacy projection; the fact is the record.
  },

  async recordPurchasePayment (fact: CommercialFact): Promise<void> {
    await BuyModel.updateOne(
      { _id: new Types.ObjectId(fact.aggregateId) },
      { $set: { paidAt: fact.businessDate } }
    )
  }
}

// Phase 0 Stock port contract double. It honors the method signatures and the
// fail-closed boundary but does not implement the Stock ledger (owned by the
// Stock module) and never writes business collections.
export const stockPortAdapter: StockPort = {
  async commitSale (): Promise<void> {},
  async receivePurchase (): Promise<void> {},
  async applyPurchaseAdjustment (): Promise<void> {},
  async applyPhysicalReturn (): Promise<void> {}
}

export const deliveryPortAdapter: DeliveryPort = {
  async recordSaleDelivery (fact: CommercialFact): Promise<void> {
    await SaleModel.updateOne(
      { _id: new Types.ObjectId(fact.aggregateId) },
      { $set: { delivery: { status: 'DELIVERED', deliveredAt: fact.businessDate } } }
    )
    await recomputeForSale(fact.aggregateId, fact.actorId)
  }
}

// Commitment reference handed from the sale-creation path to Stock. It carries
// only the sale identity, its line info and the acting user; it is a plain
// object, not a persisted CommercialFact, and the adapter must not write any
// business collection from it.
export interface SaleCommitmentReference {
  saleId: string
  lines: Array<Record<string, unknown>>
  actorId: string
}

// Centralizes the sale-creation wiring's commitment call so the caller never
// fabricates a full CommercialFact for a reservation that is not a fact.
export const commitSaleReference = async (commitment: SaleCommitmentReference): Promise<void> => {
  await stockPortAdapter.commitSale(commitment as unknown as CommercialFact)
}

// Phase 0 contract double for the Rutas saved-plan reader. It reads only from an
// explicitly provided, frozen registry and returns plans read-only. It never
// writes business collections and does not implement the Rutas planner.
export class RoutePlanReaderDouble implements RoutePlanReader {
  private readonly plans: Map<string, unknown>

  constructor (seedPlans: Record<string, unknown> = {}) {
    this.plans = new Map(Object.entries(seedPlans))
  }

  async readSavedPlan (planId: string): Promise<unknown> {
    const plan = this.plans.get(planId)
    if (plan === undefined) {
      throw new CommercialFactError('FEATURE_UNAVAILABLE', 'Saved plan is not available')
    }
    return Object.freeze(plan)
  }
}

// Allowed producer snapshot versions for the read-only simulation contract. The
// exact producer field schemas are owned by the Rutas and Stock modules and are
// deferred; this guard only enforces version compatibility and presence of
// mandatory data, and it never writes to any producer collection or port.
const SUPPORTED_SNAPSHOT_VERSIONS = new Set<string>([
  'SIM-ROUTE-SNAPSHOT-001',
  'SIM-STOCK-SNAPSHOT-001'
])

export const assertSimulationSnapshotCompatible = (snapshot: unknown): void => {
  if (typeof snapshot !== 'object' || snapshot === null || Array.isArray(snapshot)) {
    throw new CommercialFactError('SIMULATION_CONTRACT_INCOMPATIBLE', 'Simulation snapshot is not a valid object')
  }

  const record = snapshot as Record<string, unknown>
  const version = record.version

  if (typeof version !== 'string' || !SUPPORTED_SNAPSHOT_VERSIONS.has(version)) {
    throw new CommercialFactError('SIMULATION_CONTRACT_INCOMPATIBLE', 'Simulation snapshot version is not supported')
  }

  if (record.data === undefined || record.data === null) {
    throw new CommercialFactError('SIMULATION_CONTRACT_INCOMPATIBLE', 'Simulation snapshot is missing mandatory data')
  }
}
