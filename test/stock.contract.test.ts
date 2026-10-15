import { expect } from 'chai'
import { readFileSync } from 'node:fs'
import { Request, Response } from 'express'
import sinon from 'sinon'

import { StockService, StockServiceError } from '../src/services/stock'
import { STOCK_ERROR_CODES, type StockOperationResult } from '../src/interfaces/stock.interface'
import {
  getAvailability,
  receivePurchase,
  removeExpiredBucket,
  returnSale
} from '../src/controllers/stock'

const PRODUCT_ID = '507f1f77bcf86cd799439011'
const BUY_ID = '507f1f77bcf86cd799439012'
const ITEM_BUY_ID = '507f1f77bcf86cd799439013'
const SALE_ID = '507f1f77bcf86cd799439014'
const BUCKET_ID = '507f1f77bcf86cd799439015'
const ACTOR_ID = '507f1f77bcf86cd799439016'
const ATTACKER_ID = '507f1f77bcf86cd799439017'

interface TestRequest {
  body?: unknown
  params?: Record<string, string>
  query?: Record<string, unknown>
  headers?: Record<string, string>
}

interface TestResponse {
  locals: Record<string, unknown>
  status: sinon.SinonStub
  send: sinon.SinonStub
}

const makeRequest = (request: TestRequest): Request => request as unknown as Request

const makeResponse = (userId: string = ACTOR_ID): TestResponse => {
  const response = {
    locals: { userId },
    status: sinon.stub(),
    send: sinon.stub()
  }
  response.status.returns(response)
  response.send.returns(response)
  return response
}

const result = (appliedMovementCount: number, alreadyAppliedCount: number): StockOperationResult => ({
  status: 'APPLIED',
  operationId: 'operation-1',
  movementCount: appliedMovementCount,
  appliedMovementCount,
  alreadyAppliedCount,
  projectionCount: appliedMovementCount
})

const bodyOf = (response: TestResponse): unknown => response.send.firstCall.args[0]

describe('Stock contract — HTTP adapter', () => {
  afterEach(() => sinon.restore())

  it('declares the auto-mounted paths and intended permission contracts', async () => {
    const source = readFileSync('src/routes/stock.ts', 'utf8')
    const { router } = await import('../src/routes/stock')
    const { createApp } = await import('../src/app')
    const app = await createApp()
    const paths = router.stack
      .filter((layer) => layer.route !== undefined)
      .map((layer) => layer.route.path)
    const appStack = (app as unknown as { _router?: { stack?: unknown[] } })._router?.stack ?? []
    const stockMount = appStack.some((layer) => {
      if (typeof layer !== 'object' || layer === null || !('regexp' in layer)) return false
      const regexp = (layer as { regexp?: unknown }).regexp
      return typeof regexp === 'object' && regexp !== null && 'test' in regexp && typeof regexp.test === 'function' && regexp.test('/stock')
    })

    expect(stockMount).to.equal(true)
    expect(paths).to.deep.equal([
      '/availability',
      '/purchases/:buyId/receive',
      '/returns',
      '/expired-buckets/:id/remove'
    ])
    expect(source).to.include("checkPermission('read_stock')")
    expect(source).to.include("checkPermission('receive_stock')")
    expect(source).to.include("checkPermission('manage_stock')")
  })

  it('requires strict availability queries to provide businessDate before invoking StockService', async () => {
    const serviceCall = sinon.stub(StockService.prototype, 'getAvailability').resolves([])
    const malformedResponse = makeResponse()

    await getAvailability(makeRequest({
      query: { productIds: [PRODUCT_ID], businessDate: '2026-10-15', unexpected: 'nope' },
      headers: { 'x-correlation-id': 'correlation-1' }
    }), malformedResponse as unknown as Response)

    expect(malformedResponse.status.calledWith(400)).to.equal(true)
    expect(bodyOf(malformedResponse)).to.deep.include({ code: 'STOCK_DATA_INCOMPLETE' })
    expect(serviceCall.called).to.equal(false)

    const missingDateResponse = makeResponse()
    await getAvailability(makeRequest({
      query: { productIds: [PRODUCT_ID] }
    }), missingDateResponse as unknown as Response)

    expect(missingDateResponse.status.calledWith(400)).to.equal(true)
    expect(bodyOf(missingDateResponse)).to.deep.include({ code: 'STOCK_DATA_INCOMPLETE' })
    expect(serviceCall.called).to.equal(false)

    const validResponse = makeResponse()
    await getAvailability(makeRequest({
      query: { productIds: [PRODUCT_ID], businessDate: '2026-10-15' }
    }), validResponse as unknown as Response)

    expect(validResponse.status.calledWith(200)).to.equal(true)
    expect(serviceCall.calledOnce).to.equal(true)
    expect(serviceCall.firstCall.args[0]).to.deep.include({ auth: { actorId: ACTOR_ID, canManageStock: true } })
  })

  it('propagates the authenticated actor and ignores caller-supplied receivedBy', async () => {
    const serviceCall = sinon.stub(StockService.prototype, 'receivePurchase').resolves(result(1, 0))
    const response = makeResponse()

    await receivePurchase(makeRequest({
      params: { buyId: BUY_ID },
      body: {
        buyId: ATTACKER_ID,
        receivedBy: ATTACKER_ID,
        lines: [{ itemBuyId: ITEM_BUY_ID, productId: PRODUCT_ID, quantityReceived: 2 }],
        receivedAt: '2026-10-15T12:30:00.000Z',
        operationId: 'receipt-1'
      }
    }), response as unknown as Response)

    expect(response.status.calledWith(201)).to.equal(true)
    expect(serviceCall.calledOnce).to.equal(true)
    expect(serviceCall.firstCall.args[0]).to.deep.include({ buyId: BUY_ID, receivedBy: ACTOR_ID })
  })

  it('returns 200 for a fully idempotent purchase retry', async () => {
    sinon.stub(StockService.prototype, 'receivePurchase').resolves(result(0, 1))
    const response = makeResponse()

    await receivePurchase(makeRequest({
      params: { buyId: BUY_ID },
      body: {
        lines: [{ itemBuyId: ITEM_BUY_ID, productId: PRODUCT_ID, quantityReceived: 2 }],
        receivedAt: '2026-10-15T12:30:00.000Z',
        operationId: 'receipt-retry'
      }
    }), response as unknown as Response)

    expect(response.status.calledWith(200)).to.equal(true)
  })

  it('rejects malformed returns before invoking StockService and maps service conflicts stably', async () => {
    const serviceCall = sinon.stub(StockService.prototype, 'returnSale')
      .onFirstCall().rejects(new StockServiceError(STOCK_ERROR_CODES.STOCK_IDEMPOTENCY_CONFLICT, 'internal conflict detail'))
    const invalidResponse = makeResponse()

    await returnSale(makeRequest({
      body: {
        saleId: SALE_ID,
        operationId: 'return-1',
        businessDate: '2026-10-15',
        lines: [{ productId: PRODUCT_ID, quantity: 0 }]
      }
    }), invalidResponse as unknown as Response)

    expect(invalidResponse.status.calledWith(400)).to.equal(true)
    expect(serviceCall.called).to.equal(false)

    const conflictResponse = makeResponse()
    await returnSale(makeRequest({
      body: {
        saleId: SALE_ID,
        operationId: 'return-1',
        businessDate: '2026-10-15',
        lines: [{ productId: PRODUCT_ID, quantity: 1 }]
      }
    }), conflictResponse as unknown as Response)

    expect(conflictResponse.status.calledWith(409)).to.equal(true)
    expect(bodyOf(conflictResponse)).to.deep.equal({
      code: STOCK_ERROR_CODES.STOCK_IDEMPOTENCY_CONFLICT,
      message: 'Stock operation conflicts with an existing idempotency record'
    })
  })

  it('returns 200 for an idempotent expired-bucket no-op and rejects unknown payload keys', async () => {
    const serviceCall = sinon.stub(StockService.prototype, 'removeExpiredBucket').resolves(result(0, 0))
    const invalidResponse = makeResponse()

    await removeExpiredBucket(makeRequest({
      params: { id: BUCKET_ID },
      body: {
        operationId: 'remove-1',
        businessDate: '2026-10-15',
        reason: 'Expired goods',
        extra: true
      }
    }), invalidResponse as unknown as Response)

    expect(invalidResponse.status.calledWith(400)).to.equal(true)
    expect(serviceCall.called).to.equal(false)

    const response = makeResponse()
    await removeExpiredBucket(makeRequest({
      params: { id: BUCKET_ID },
      body: {
        operationId: 'remove-1',
        businessDate: '2026-10-15',
        reason: 'Expired goods'
      }
    }), response as unknown as Response)

    expect(response.status.calledWith(200)).to.equal(true)
    expect(serviceCall.calledOnce).to.equal(true)
    expect(serviceCall.firstCall.args[0]).to.deep.include({
      bucketId: BUCKET_ID,
      auth: { actorId: ACTOR_ID, canManageStock: true }
    })
  })
})
