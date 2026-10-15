import { expect } from 'chai'

import { STOCK_OPERATION_STATUSES, STOCK_ERROR_CODES } from '../src/interfaces/stock.interface'
import {
  confirmOpeningCount,
  OpeningCountError,
  previewOpeningCount
} from '../src/services/stockOpening'

const ACTOR_ID = '507f1f77bcf86cd799439011'
const PRODUCT_ID = '507f1f77bcf86cd799439013'
const OTHER_PRODUCT_ID = '507f1f77bcf86cd799439014'

const input = {
  operationId: 'opening-2026-10-15',
  rows: [
    { productId: OTHER_PRODUCT_ID, countedQuantity: 2, expiryDate: '2026-12-31' },
    { productId: PRODUCT_ID, countedQuantity: 4 }
  ]
}

const auth = { actorId: ACTOR_ID, canManageStock: true, canApproveStockCount: true }

describe('Stock opening — preview and confirmation', () => {
  it('builds deterministic preview evidence without a writer or mutation', () => {
    const result = previewOpeningCount(input, auth)
    expect(result.plan.groups).to.deep.equal([
      { productId: PRODUCT_ID, expiryDate: null, countedQuantity: 4 },
      { productId: OTHER_PRODUCT_ID, expiryDate: '2026-12-31', countedQuantity: 2 }
    ])
    expect(result.evidence).to.deep.equal({
      status: STOCK_OPERATION_STATUSES.PENDING,
      operationId: input.operationId,
      actorId: ACTOR_ID,
      rulesVersion: 'stock-rules-v1',
      movementCount: 2,
      businessDataMutated: false
    })
  })

  it('rejects duplicate keys and invalid rows before confirmation', () => {
    expect(() => previewOpeningCount({
      ...input,
      rows: [input.rows[0], { ...input.rows[0], countedQuantity: 3 }]
    }, auth)).to.throw(OpeningCountError).and.have.property('code', STOCK_ERROR_CODES.STOCK_DATA_INCOMPLETE)
    expect(() => previewOpeningCount({
      ...input,
      rows: [{ productId: 'invalid', countedQuantity: 1 }]
    }, auth)).to.throw(OpeningCountError)
  })

  it('fails closed for unauthorized preview and confirmation', async () => {
    expect(() => previewOpeningCount(input, { ...auth, canManageStock: false })).to.throw(OpeningCountError).and.have.property('code', STOCK_ERROR_CODES.STOCK_FORBIDDEN)
    let writerCalls = 0
    const writer = async (): Promise<{ status: 'APPLIED', movementCount: number }> => {
      writerCalls += 1
      return { status: 'APPLIED', movementCount: 2 }
    }
    let rejection: unknown
    try {
      await confirmOpeningCount({ ...input, approvedBy: ACTOR_ID, approvalId: 'approval-1' }, { ...auth, canApproveStockCount: false }, writer)
    } catch (error) {
      rejection = error
    }
    expect(rejection).to.be.instanceOf(OpeningCountError)
    expect(writerCalls).to.equal(0)
  })

  it('rejects an approval actor mismatch before invoking the writer', async () => {
    let writerCalls = 0
    const writer = async (): Promise<{ status: 'APPLIED', movementCount: number }> => {
      writerCalls += 1
      return { status: 'APPLIED', movementCount: 2 }
    }

    let rejection: unknown
    try {
      await confirmOpeningCount({ ...input, approvedBy: '507f1f77bcf86cd799439015', approvalId: 'approval-mismatch' }, auth, writer)
    } catch (error) {
      rejection = error
    }

    expect(rejection).to.be.instanceOf(OpeningCountError).and.have.property('code', STOCK_ERROR_CODES.STOCK_FORBIDDEN)
    expect(writerCalls).to.equal(0)
  })

  it('calls the writer exactly once and reports applied or recoverable evidence', async () => {
    let writerCalls = 0
    const writer = async (): Promise<{ status: 'APPLIED', movementCount: number }> => {
      writerCalls += 1
      return { status: 'APPLIED', movementCount: 2 }
    }
    const applied = await confirmOpeningCount({ ...input, approvedBy: ACTOR_ID, approvalId: 'approval-1' }, auth, writer)
    expect(writerCalls).to.equal(1)
    expect(applied.evidence).to.deep.equal({
      status: STOCK_OPERATION_STATUSES.APPLIED,
      operationId: input.operationId,
      approvalId: 'approval-1',
      approvedBy: ACTOR_ID,
      actorId: ACTOR_ID,
      rulesVersion: 'stock-rules-v1',
      movementCount: 2,
      businessDataMutated: true
    })

    const failed = await confirmOpeningCount({ ...input, approvedBy: ACTOR_ID, approvalId: 'approval-2' }, auth, async () => ({ status: 'FAILED_RECOVERABLE' as const, movementCount: 0 }))
    expect(failed.evidence.status).to.equal(STOCK_OPERATION_STATUSES.FAILED_RECOVERABLE)
    expect(failed.evidence.businessDataMutated).to.equal(false)
  })

  it('keeps equivalent previews byte-for-byte deterministic', () => {
    const first = JSON.stringify(previewOpeningCount(input, auth))
    const second = JSON.stringify(previewOpeningCount({ ...input, rows: [...input.rows].reverse() }, auth))
    expect(first).to.equal(second)
  })
})
