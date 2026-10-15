import { expect } from 'chai'
import { readFileSync } from 'node:fs'
import { Request, Response } from 'express'
import sinon from 'sinon'

import { StockService, StockServiceError } from '../src/services/stock'
import { STOCK_ERROR_CODES, type StockOperationResult } from '../src/interfaces/stock.interface'
import {
  getAvailability,
  getOverview,
  getProductDetail,
  updateMinimum,
  receivePurchase,
  removeExpiredBucket,
  returnSale,
  previewOpeningCount
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

const overviewResult = {
  page: 1,
  pageSize: 50,
  total: 0,
  items: [],
  summary: {
    productCount: 0,
    physicalQuantity: 0,
    committedQuantity: 0,
    availableToSell: 0,
    alertCount: 0
  }
}

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
      '/overview',
      '/products/:id',
      '/products/:id/minimum',
      '/opening-counts/preview',
      '/purchases/:buyId/receive',
      '/returns',
      '/expired-buckets/:id/remove'
    ])
    expect(source).to.include("checkPermission('read_stock')")
    expect(source).to.include("checkPermission('receive_stock')")
    expect(source).to.include("checkPermission('manage_stock')")
    expect(source).to.include("checkPermission('manage_stock_config')")
    expect(source).to.include("router.post('/opening-counts/preview'")
    expect(source).to.include('checkJwt(req, res, next)')
  })

  it('previews opening counts as a pending dry run without mutating business data', async () => {
    const response = makeResponse()

    await previewOpeningCount(makeRequest({
      body: {
        operationId: 'opening-preview-1',
        rows: [{ productId: PRODUCT_ID, countedQuantity: 4, expiryDate: '2027-01-31' }]
      }
    }), response as unknown as Response)

    expect(response.status.calledWith(200)).to.equal(true)
    const preview = bodyOf(response) as { evidence: Record<string, unknown> }
    expect(preview.evidence).to.include({ status: 'PENDING', actorId: ACTOR_ID, businessDataMutated: false })
  })

  it('rejects malformed, duplicate, and incomplete opening-count payloads before preview execution', async () => {
    const invalidBodies = [
      { operationId: 'opening-preview-2', rows: [{ productId: 'invalid', countedQuantity: 1 }] },
      { operationId: 'opening-preview-3', rows: [{ productId: PRODUCT_ID, countedQuantity: -1 }] },
      { operationId: 'opening-preview-4', rows: [{ productId: PRODUCT_ID, countedQuantity: 1 }, { productId: PRODUCT_ID, countedQuantity: 2 }] },
      { operationId: 'opening-preview-5', rows: [{ productId: PRODUCT_ID, countedQuantity: 1, unknown: true }] },
      { rows: [{ productId: PRODUCT_ID, countedQuantity: 1 }] }
    ]

    for (const body of invalidBodies) {
      const response = makeResponse()
      await previewOpeningCount(makeRequest({ body }), response as unknown as Response)
      expect(response.status.calledWith(400)).to.equal(true)
      expect(bodyOf(response)).to.deep.include({ code: STOCK_ERROR_CODES.STOCK_DATA_INCOMPLETE })
    }
  })

  it('rejects opening-count previews without an authenticated actor and does not expose a confirmation route', async () => {
    const response = makeResponse('')
    await previewOpeningCount(makeRequest({
      body: {
        operationId: 'opening-preview-6',
        rows: [{ productId: PRODUCT_ID, countedQuantity: 1 }]
      }
    }), response as unknown as Response)

    expect(response.status.calledWith(403)).to.equal(true)
    expect(bodyOf(response)).to.deep.include({ code: STOCK_ERROR_CODES.STOCK_FORBIDDEN })

    const { router } = await import('../src/routes/stock')
    const paths = router.stack
      .filter((layer) => layer.route !== undefined)
      .map((layer) => layer.route.path)
    expect(paths).to.not.include('/opening-counts/confirm')
  })

  it('validates strict overview queries, defaults pagination, and never invokes the service for invalid input', async () => {
    const serviceCall = sinon.stub(StockService.prototype, 'getOverview').resolves(overviewResult)

    for (const query of [
      { businessDate: '2026-10-15', unexpected: 'nope' },
      { unexpected: 'nope' },
      { businessDate: '2026-10-15', page: '0' },
      { businessDate: '2026-10-15', pageSize: '101' },
      { businessDate: '2026-02-30' }
    ]) {
      const response = makeResponse()
      await getOverview(makeRequest({ query }), response as unknown as Response)
      expect(response.status.calledWith(400)).to.equal(true)
    }
    expect(serviceCall.called).to.equal(false)

    const response = makeResponse()
    await getOverview(makeRequest({ query: { businessDate: '2026-10-15' } }), response as unknown as Response)

    expect(response.status.calledWith(200)).to.equal(true)
    expect(serviceCall.calledOnce).to.equal(true)
    expect(serviceCall.firstCall.args[0]).to.deep.include({ page: 1, pageSize: 50, businessDate: '2026-10-15' })
    expect(serviceCall.firstCall.args[0]).to.have.property('auth').deep.equal({ actorId: ACTOR_ID, canManageStock: true })
  })

  it('validates strict product detail queries and maps missing products to a stable 404 envelope', async () => {
    const serviceCall = sinon.stub(StockService.prototype, 'getProductDetail').resolves({
      productId: PRODUCT_ID,
      minimum: 2,
      availability: {
        productId: PRODUCT_ID,
        physicalQuantity: 10,
        committedQuantity: 1,
        availableToSell: 9,
        expiredQuantity: 0,
        dataQuality: 'COMPLETE'
      },
      buckets: [],
      movements: [],
      alerts: []
    })

    for (const request of [
      { params: { id: 'invalid' }, query: { businessDate: '2026-10-15' } },
      { params: { id: PRODUCT_ID }, query: { businessDate: '2026-02-30' } },
      { params: { id: PRODUCT_ID }, query: { businessDate: '2026-10-15', movementLimit: '101' } },
      { params: { id: PRODUCT_ID }, query: { businessDate: '2026-10-15', unexpected: 'nope' } }
    ]) {
      const response = makeResponse()
      await getProductDetail(makeRequest(request), response as unknown as Response)
      expect(response.status.calledWith(400)).to.equal(true)
    }
    expect(serviceCall.called).to.equal(false)

    const validResponse = makeResponse()
    await getProductDetail(makeRequest({ params: { id: PRODUCT_ID }, query: { businessDate: '2026-10-15' } }), validResponse as unknown as Response)
    expect(validResponse.status.calledWith(200)).to.equal(true)
    expect(serviceCall.calledOnce).to.equal(true)
    expect(serviceCall.firstCall.args[0]).to.deep.include({ productId: PRODUCT_ID, movementLimit: 50 })

    serviceCall.resetHistory()
    serviceCall.rejects(new StockServiceError('STOCK_PRODUCT_NOT_FOUND', 'missing'))
    const missingResponse = makeResponse()
    await getProductDetail(makeRequest({ params: { id: PRODUCT_ID }, query: { businessDate: '2026-10-15' } }), missingResponse as unknown as Response)
    expect(missingResponse.status.calledWith(404)).to.equal(true)
    expect(bodyOf(missingResponse)).to.deep.include({ code: 'STOCK_PRODUCT_NOT_FOUND' })
  })

  it('strictly validates minimum updates, propagates the authenticated actor, and maps service failures', async () => {
    const serviceCall = sinon.stub(StockService.prototype, 'updateMinimum').resolves({ productId: PRODUCT_ID, minimum: 4 })
    for (const body of [{ minimum: -1 }, { minimum: 1.5 }, { minimum: Number.MAX_SAFE_INTEGER + 1 }, { minimum: 1, extra: true }]) {
      const response = makeResponse()
      await updateMinimum(makeRequest({ params: { id: PRODUCT_ID }, body }), response as unknown as Response)
      expect(response.status.calledWith(400)).to.equal(true)
    }
    expect(serviceCall.called).to.equal(false)

    const response = makeResponse()
    await updateMinimum(makeRequest({ params: { id: PRODUCT_ID }, body: { minimum: 4 } }), response as unknown as Response)
    expect(response.status.calledWith(200)).to.equal(true)
    expect(bodyOf(response)).to.deep.equal({ productId: PRODUCT_ID, minimum: 4 })
    expect(serviceCall.firstCall.args).to.deep.equal([PRODUCT_ID, 4, { actorId: ACTOR_ID, canManageStock: true }])

    serviceCall.resetHistory()
    serviceCall.rejects(new StockServiceError('STOCK_PRODUCT_NOT_FOUND', 'missing'))
    const missingResponse = makeResponse()
    await updateMinimum(makeRequest({ params: { id: PRODUCT_ID }, body: { minimum: 4 } }), missingResponse as unknown as Response)
    expect(missingResponse.status.calledWith(404)).to.equal(true)
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
