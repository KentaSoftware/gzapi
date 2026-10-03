import { expect } from 'chai'
import sinon from 'sinon'
import {
  RoutePlanReaderDouble,
  assertSimulationSnapshotCompatible,
  financePortAdapter,
  stockPortAdapter
} from '../../src/services/commercialPorts'
import { CommercialFactError } from '../../src/interfaces/commercialFact.interface'

const captureError = (fn: () => unknown): unknown => {
  try {
    fn()
    return undefined
  } catch (error) {
    return error
  }
}

describe('Phase 0 — commercial ports', () => {
  afterEach(() => {
    sinon.restore()
  })

  describe('route plan reader contract double', () => {
    it('S-09: contract-double RoutePlanReader returns a saved plan read-only and writes nothing', async () => {
      const plan = { planId: 'plan-1', stops: ['A', 'B'] }
      const reader = new RoutePlanReaderDouble({ 'plan-1': plan })

      const read = await reader.readSavedPlan('plan-1')

      expect(read).to.deep.equal(plan)
      expect(Object.isFrozen(read)).to.equal(true)
    })

    it('S-09a: a plan seeded by Administración is returned read-only', async () => {
      const plan = { planId: 'plan-admin', stops: ['Depot', 'Client-1'] }
      const reader = new RoutePlanReaderDouble({ 'plan-admin': plan })

      const read = await reader.readSavedPlan('plan-admin')

      expect(read).to.deep.equal(plan)
      expect(Object.isFrozen(read)).to.equal(true)
    })

    it('S-09b: an unavailable external provider fails closed with FEATURE_UNAVAILABLE', async () => {
      const reader = new RoutePlanReaderDouble()

      try {
        await reader.readSavedPlan('missing-plan')
        expect.fail('expected readSavedPlan to throw')
      } catch (error) {
        expect(error).to.be.instanceOf(CommercialFactError)
        expect(error.code).to.equal('FEATURE_UNAVAILABLE')
      }
    })
  })

  describe('simulation snapshot compatibility', () => {
    it('S-22: an incompatible producer snapshot fails closed with SIMULATION_CONTRACT_INCOMPATIBLE and writes nothing', () => {
      const salePaymentSpy = sinon.spy(financePortAdapter, 'recordSalePayment')
      const purchasePaymentSpy = sinon.spy(financePortAdapter, 'recordPurchasePayment')
      const receivePurchaseSpy = sinon.spy(stockPortAdapter, 'receivePurchase')

      const snapshot = { version: 'SIM-ROUTE-SNAPSHOT-099', data: { planId: 'p1' } }

      const error = captureError(() => assertSimulationSnapshotCompatible(snapshot))

      expect(error).to.be.instanceOf(CommercialFactError)
      expect(error.code).to.equal('SIMULATION_CONTRACT_INCOMPATIBLE')
      expect(salePaymentSpy.called).to.equal(false)
      expect(purchasePaymentSpy.called).to.equal(false)
      expect(receivePurchaseSpy.called).to.equal(false)
    })

    it('S-22a: an incompatible route snapshot version fails closed', () => {
      const error = captureError(() => assertSimulationSnapshotCompatible({ version: 'SIM-ROUTE-SNAPSHOT-002', data: { planId: 'p1' } }))

      expect(error).to.be.instanceOf(CommercialFactError)
      expect(error.code).to.equal('SIMULATION_CONTRACT_INCOMPATIBLE')
    })

    it('S-22b: a snapshot missing mandatory data fails closed', () => {
      const error = captureError(() => assertSimulationSnapshotCompatible({ version: 'SIM-STOCK-SNAPSHOT-001' }))

      expect(error).to.be.instanceOf(CommercialFactError)
      expect(error.code).to.equal('SIMULATION_CONTRACT_INCOMPATIBLE')
    })
  })
})
