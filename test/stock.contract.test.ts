import { expect } from 'chai'
import { readFileSync } from 'node:fs'
import { Request, Response } from 'express'
import sinon from 'sinon'

import { StockService, StockServiceError, stockFailureDiagnosticOf } from '../src/services/stock'
import { STOCK_ERROR_CODES, type OpeningCountWriter, type StockOperationResult } from '../src/interfaces/stock.interface'
import {
  getAvailability,
  getOverview,
  getProductDetail,
  updateMinimum,
  receivePurchase,
  removeExpiredBucket,
  writeOffProduct,
  removeExpiredProduct,
  removeExpiredProducts,
  returnSale,
  previewOpeningCount,
  confirmOpeningCount
} from '../src/controllers/stock'

const PRODUCT_ID = '507f1f77bcf86cd799439011'
const BUY_ID = '507f1f77bcf86cd799439012'
const ITEM_BUY_ID = '507f1f77bcf86cd799439013'
const SALE_ID = '507f1f77bcf86cd799439014'
const BUCKET_ID = '507f1f77bcf86cd799439015'
const ACTOR_ID = '507f1f77bcf86cd799439016'
const ATTACKER_ID = '507f1f77bcf86cd799439017'

interface TestRequest {
  user?: { id: string }
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
  items: [{
    productId: PRODUCT_ID,
    productName: 'Coffee',
    categoryName: 'Beverages',
    imagePath: 'coffee.jpg',
    physicalQuantity: 4,
    committedQuantity: 1,
    availableToSell: 3,
    expiredQuantity: 0,
    dataQuality: 'COMPLETE',
    minimum: 2,
    alerts: [],
    latestSale: { status: 'INCOMPLETE' }
  }],
  summary: {
    productCount: 0,
    physicalQuantity: 0,
    committedQuantity: 0,
    availableToSell: 0,
    alertCount: 0
  },
  globalSummary: {
    belowMinimumProductCount: 0,
    expiringProductCount: 0,
    expiredProductCount: 0,
    lowRotationProductCount: 0,
    activeAlertCount: 0
  },
  globalAlerts: []
}

describe('Stock contract — HTTP adapter', () => {
  afterEach(() => sinon.restore())

  it('S-05/S-13/S-22/S-23: declares the auto-mounted paths and intended permission contracts', async () => {
    const source = readFileSync('src/routes/stock.ts', 'utf8')
    const { router } = await import('../src/routes/stock')
    const { createApp } = await import('../src/app')
    const app = await createApp()
    const paths = router.stack
      .filter((layer) => layer.route !== undefined)
      .map((layer) => layer.route.path)
    const routeMethods = router.stack
      .filter((layer) => layer.route !== undefined)
      .map((layer) => ({ path: layer.route.path, methods: layer.route.methods }))
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
      '/opening-counts/confirm',
      '/purchases/:buyId/receive',
      '/returns',
      '/expired-buckets/:id/remove',
      '/products/:id/write-offs',
      '/products/:id/expired-removal',
      '/expired-removals'
    ])
    expect(routeMethods.filter(({ path }) => path.includes('/opening-counts/'))).to.deep.equal([
      { path: '/opening-counts/preview', methods: { post: true } },
      { path: '/opening-counts/confirm', methods: { post: true } }
    ])
    const openingRouteLines = source.split('\n').filter((line) => line.includes("router.post('/opening-counts/"))
    expect(openingRouteLines).to.have.length(2)
    expect(openingRouteLines.every((line) => line.includes("checkPermission('manage_stock_config')"))).to.equal(true)
    const readRoutes = source.split('\n').filter((line) => ["router.get('/availability'", "router.get('/overview'", "router.get('/products/:id'"].some((route) => line.includes(route)))
    expect(readRoutes).to.have.length(3)
    expect(readRoutes.every((line) => line.includes('checkJwt(req, res, next)'))).to.equal(true)
    expect(readRoutes.every((line) => line.includes('checkPermission') === false)).to.equal(true)
    expect(source).to.include("checkPermission('receive_stock')")
    expect(source).to.include("checkPermission('manage_stock')")
    expect(source).to.include("checkPermission('manage_stock_config')")
    expect(source).to.include("router.post('/opening-counts/preview'")
    const ss04Routes = source.split('\n').filter((line) => line.includes("router.post('/products/:id/write-offs'") || line.includes("router.post('/products/:id/expired-removal'") || line.includes("router.post('/expired-removals'"))
    expect(ss04Routes).to.have.length(3)
    expect(ss04Routes.every((line) => line.includes('checkJwt(req, res, next)') && !line.includes('checkPermission'))).to.equal(true)
    expect(source).to.include('checkJwt(req, res, next)')
  })

  it('builds opening-count preview evidence as a pending dry run without mutating business data', async () => {
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

  it('TC-018: returns 201 for a new confirmation, 200 for a matching retry, and stable conflict envelopes', async () => {
    const body = {
      operationId: 'opening-confirm-1',
      rows: [{ productId: PRODUCT_ID, countedQuantity: 4 }],
      approvedBy: ACTOR_ID,
      approvalId: 'approval-1'
    }
    const appliedWriter: OpeningCountWriter = async () => ({ status: 'APPLIED', movementCount: 1 })
    const appliedResponse = makeResponse()
    await confirmOpeningCount(makeRequest({ body }), appliedResponse as unknown as Response, appliedWriter)
    expect(appliedResponse.status.calledWith(201)).to.equal(true)
    const appliedBody = bodyOf(appliedResponse) as { evidence: Record<string, unknown> }
    expect(appliedBody.evidence).to.include({
      status: 'APPLIED',
      operationId: body.operationId,
      approvalId: body.approvalId,
      approvedBy: ACTOR_ID,
      actorId: ACTOR_ID,
      businessDataMutated: true
    })

    const retryResponse = makeResponse()
    await confirmOpeningCount(makeRequest({ body }), retryResponse as unknown as Response, async () => ({ status: 'IDEMPOTENT_RETRY' as const, movementCount: 1 }))
    expect(retryResponse.status.calledWith(200)).to.equal(true)

    const conflictResponse = makeResponse()
    await confirmOpeningCount(makeRequest({ body }), conflictResponse as unknown as Response, async () => {
      throw new StockServiceError(STOCK_ERROR_CODES.STOCK_IDEMPOTENCY_CONFLICT, 'internal conflict detail')
    })
    expect(conflictResponse.status.calledWith(409)).to.equal(true)
    expect(bodyOf(conflictResponse)).to.deep.equal({
      code: STOCK_ERROR_CODES.STOCK_IDEMPOTENCY_CONFLICT,
      message: 'Stock operation conflicts with an existing idempotency record'
    })

    const unavailableResponse = makeResponse()
    await confirmOpeningCount(makeRequest({ body }), unavailableResponse as unknown as Response, async () => ({
      status: 'FAILED_RECOVERABLE',
      movementCount: 0,
      errorCode: STOCK_ERROR_CODES.STOCK_REPOSITORY_ERROR
    }))
    expect(unavailableResponse.status.calledWith(503)).to.equal(true)
    expect(bodyOf(unavailableResponse)).to.deep.equal({
      code: STOCK_ERROR_CODES.STOCK_REPOSITORY_ERROR,
      message: 'Stock persistence is currently unavailable'
    })
  })

  it('NFR-004: returns 400 for malformed confirmation and 403 for approval actor mismatch', async () => {
    const malformedResponse = makeResponse()
    await confirmOpeningCount(makeRequest({ body: { operationId: 'opening-confirm-2', rows: [] } }), malformedResponse as unknown as Response, async () => ({ status: 'APPLIED' as const, movementCount: 0 }))
    expect(malformedResponse.status.calledWith(400)).to.equal(true)
    expect(bodyOf(malformedResponse)).to.deep.equal({
      code: STOCK_ERROR_CODES.STOCK_DATA_INCOMPLETE,
      message: 'Stock request data is incomplete or invalid'
    })

    const mismatchResponse = makeResponse()
    await confirmOpeningCount(makeRequest({
      body: {
        operationId: 'opening-confirm-3',
        rows: [{ productId: PRODUCT_ID, countedQuantity: 1 }],
        approvedBy: ATTACKER_ID,
        approvalId: 'approval-3'
      }
    }), mismatchResponse as unknown as Response, async () => ({ status: 'APPLIED' as const, movementCount: 1 }))
    expect(mismatchResponse.status.calledWith(403)).to.equal(true)
    expect(bodyOf(mismatchResponse)).to.deep.equal({
      code: STOCK_ERROR_CODES.STOCK_FORBIDDEN,
      message: 'Stock permission is required'
    })
  })

  it('TC-018/NFR-004: maps the representative Stock HTTP error matrix to stable envelopes', async () => {
    const body = {
      operationId: 'opening-matrix-1',
      rows: [{ productId: PRODUCT_ID, countedQuantity: 1 }],
      approvedBy: ACTOR_ID,
      approvalId: 'approval-matrix-1'
    }

    const missingProductService = sinon.stub(StockService.prototype, 'getProductDetail').rejects(new StockServiceError(STOCK_ERROR_CODES.STOCK_PRODUCT_NOT_FOUND, 'raw missing product detail'))
    const missingProductResponse = makeResponse()
    await getProductDetail(makeRequest({ params: { id: PRODUCT_ID }, query: { businessDate: '2026-10-15' } }), missingProductResponse as unknown as Response)
    expect(missingProductResponse.status.calledWith(404)).to.equal(true)
    expect(bodyOf(missingProductResponse)).to.deep.equal({
      code: STOCK_ERROR_CODES.STOCK_PRODUCT_NOT_FOUND,
      message: 'Stock product was not found'
    })
    missingProductService.restore()

    const baselineResponse = makeResponse()
    await confirmOpeningCount(makeRequest({ body }), baselineResponse as unknown as Response, async () => {
      throw new StockServiceError(STOCK_ERROR_CODES.STOCK_BASELINE_ALREADY_RECONCILED, 'raw committed baseline detail')
    })
    expect(baselineResponse.status.calledWith(409)).to.equal(true)
    expect(bodyOf(baselineResponse)).to.deep.equal({
      code: STOCK_ERROR_CODES.STOCK_BASELINE_ALREADY_RECONCILED,
      message: 'The product baseline has already been reconciled'
    })

    const committedResponse = makeResponse()
    await confirmOpeningCount(makeRequest({ body }), committedResponse as unknown as Response, async () => {
      throw new StockServiceError(STOCK_ERROR_CODES.STOCK_BUCKET_HAS_COMMITMENTS, 'raw committed bucket detail')
    })
    expect(committedResponse.status.calledWith(409)).to.equal(true)
    expect(bodyOf(committedResponse)).to.deep.equal({
      code: STOCK_ERROR_CODES.STOCK_BUCKET_HAS_COMMITMENTS,
      message: 'The stock bucket still has sale commitments'
    })

    const unknownService = sinon.stub(StockService.prototype, 'getOverview').rejects(new Error('raw Mongo failure'))
    const unknownResponse = makeResponse()
    await getOverview(makeRequest({ query: { businessDate: '2026-10-15' } }), unknownResponse as unknown as Response)
    expect(unknownResponse.status.calledWith(500)).to.equal(true)
    expect(bodyOf(unknownResponse)).to.deep.equal({
      code: 'INTERNAL_ERROR',
      message: 'Stock operation failed'
    })

    unknownService.restore()
    const sentinel = 'raw Mongo failure sentinel mongodb://user:secret@host/db query=private'
    const repositoryCause = Object.assign(new Error(sentinel), { name: 'MongoServerError', code: 11000 })
    const sanitizedDiagnostic = stockFailureDiagnosticOf('stock_overview_list_products', repositoryCause)
    sinon.stub(StockService.prototype, 'getOverview').rejects(Object.assign(new StockServiceError(STOCK_ERROR_CODES.STOCK_REPOSITORY_ERROR, sentinel), { diagnostic: sanitizedDiagnostic }))
    const log = sinon.stub(console, 'error')
    const repositoryResponse = makeResponse()
    await getOverview(makeRequest({
      headers: { 'x-correlation-id': 'stock-correlation_1' },
      query: { businessDate: '2026-10-15' }
    }), repositoryResponse as unknown as Response)

    expect(repositoryResponse.status.calledWith(503)).to.equal(true)
    expect(bodyOf(repositoryResponse)).to.deep.equal({
      code: STOCK_ERROR_CODES.STOCK_REPOSITORY_ERROR,
      message: 'Stock persistence is currently unavailable',
      correlationId: 'stock-correlation_1'
    })
    expect(log.calledOnce).to.equal(true)
    expect(log.firstCall.args).to.deep.equal([{
      event: 'stock_repository_failure',
      code: STOCK_ERROR_CODES.STOCK_REPOSITORY_ERROR,
      operation: 'stock_overview_list_products',
      cause: 'duplicate_key',
      databaseCode: 11000,
      correlationId: 'stock-correlation_1'
    }])
    expect(JSON.stringify(log.args)).not.to.include(sentinel)
    expect(log.firstCall.args[0]).not.to.include({ cause: repositoryCause })
    expect(JSON.stringify(log.args)).not.to.include(repositoryCause.message)
    unknownService.restore()
  })

  it('keeps unknown repository diagnostics scalar and preserves the generic response', async () => {
    const sentinel = 'private Mongo URL mongodb://user:secret@host/db'
    const original = Object.assign(new Error(sentinel), { code: sentinel })
    sinon.stub(StockService.prototype, 'getOverview').rejects(Object.assign(new StockServiceError(STOCK_ERROR_CODES.STOCK_REPOSITORY_ERROR, sentinel), {
      diagnostic: { operation: 'untrusted_operation', cause: original, databaseCode: Number.POSITIVE_INFINITY, substage: 'mongodb://private-secret' }
    }))
    const log = sinon.stub(console, 'error')
    const response = makeResponse()

    await getOverview(makeRequest({ query: { businessDate: '2026-10-15' } }), response as unknown as Response)

    expect(response.status.calledWith(503)).to.equal(true)
    expect(bodyOf(response)).to.deep.equal({
      code: STOCK_ERROR_CODES.STOCK_REPOSITORY_ERROR,
      message: 'Stock persistence is currently unavailable'
    })
    expect(log.firstCall.args[0]).to.deep.equal({
      event: 'stock_repository_failure',
      code: STOCK_ERROR_CODES.STOCK_REPOSITORY_ERROR,
      operation: 'stock_repository_unknown',
      cause: 'unknown',
      correlationId: undefined
    })
    expect(JSON.stringify(log.args)).not.to.include(sentinel)
    expect(Object.values(log.firstCall.args[0] as Record<string, unknown>)).not.to.include(original)
  })

  it('logs only allowlisted repository stages and preserves the generic 503 response', async () => {
    const sentinel = 'private database message mongodb://user:secret@host/db'
    sinon.stub(StockService.prototype, 'getOverview').rejects(Object.assign(new StockServiceError(STOCK_ERROR_CODES.STOCK_REPOSITORY_ERROR, sentinel), {
      diagnostic: { operation: 'stock_overview_list_products', cause: 'unknown', stage: 'tracked_bucket_read', substage: 'mongodb://private-secret' }
    }))
    const log = sinon.stub(console, 'error')
    const response = makeResponse()

    await getOverview(makeRequest({ query: { businessDate: '2026-10-15' } }), response as unknown as Response)

    expect(log.firstCall.args[0]).to.include({ stage: 'tracked_bucket_read' })
    expect(log.firstCall.args[0]).not.to.have.property('substage')
    expect(bodyOf(response)).to.deep.equal({
      code: STOCK_ERROR_CODES.STOCK_REPOSITORY_ERROR,
      message: 'Stock persistence is currently unavailable'
    })
    expect(JSON.stringify(log.args)).not.to.include(sentinel)

    sinon.restore()
    sinon.stub(StockService.prototype, 'getOverview').rejects(Object.assign(new StockServiceError(STOCK_ERROR_CODES.STOCK_REPOSITORY_ERROR, sentinel), {
      diagnostic: { operation: 'stock_overview_list_products', cause: 'unknown', stage: sentinel }
    }))
    const invalidStageLog = sinon.stub(console, 'error')
    const invalidStageResponse = makeResponse()
    await getOverview(makeRequest({ query: { businessDate: '2026-10-15' } }), invalidStageResponse as unknown as Response)
    expect(invalidStageLog.firstCall.args[0]).not.to.have.property('stage')
    expect(bodyOf(invalidStageResponse)).to.deep.equal({
      code: STOCK_ERROR_CODES.STOCK_REPOSITORY_ERROR,
      message: 'Stock persistence is currently unavailable'
    })
    expect(JSON.stringify(invalidStageLog.args)).not.to.include(sentinel)
  })

  it('preserves allowlisted connection causes and uses a neutral operation for invalid repository metadata', async () => {
    const connectionError = Object.assign(new Error('private connection detail'), { name: 'MongoServerSelectionError' })
    const connectionDiagnostic = stockFailureDiagnosticOf('stock_overview_list_products', connectionError)
    sinon.stub(StockService.prototype, 'getOverview').rejects(Object.assign(new StockServiceError(STOCK_ERROR_CODES.STOCK_REPOSITORY_ERROR, 'private detail'), {
      diagnostic: connectionDiagnostic
    }))
    const connectionLog = sinon.stub(console, 'error')
    const connectionResponse = makeResponse()

    await getOverview(makeRequest({ query: { businessDate: '2026-10-15' } }), connectionResponse as unknown as Response)

    expect(connectionLog.firstCall.args[0]).to.include({
      event: 'stock_repository_failure',
      operation: 'stock_overview_list_products',
      cause: 'connection'
    })
    expect(bodyOf(connectionResponse)).to.deep.equal({
      code: STOCK_ERROR_CODES.STOCK_REPOSITORY_ERROR,
      message: 'Stock persistence is currently unavailable'
    })

    sinon.restore()
    const invalidDiagnostic = { cause: 'connection', databaseCode: 89 }
    sinon.stub(StockService.prototype, 'getOverview').rejects(Object.assign(new StockServiceError(STOCK_ERROR_CODES.STOCK_REPOSITORY_ERROR, 'private detail'), {
      diagnostic: invalidDiagnostic
    }))
    const invalidLog = sinon.stub(console, 'error')
    const invalidResponse = makeResponse()

    await getOverview(makeRequest({ query: { businessDate: '2026-10-15' } }), invalidResponse as unknown as Response)

    expect(invalidLog.firstCall.args[0]).to.include({
      event: 'stock_repository_failure',
      operation: 'stock_repository_unknown',
      cause: 'connection',
      databaseCode: 89
    })
    expect(bodyOf(invalidResponse)).to.deep.equal({
      code: STOCK_ERROR_CODES.STOCK_REPOSITORY_ERROR,
      message: 'Stock persistence is currently unavailable'
    })

    sinon.restore()
    sinon.stub(StockService.prototype, 'getOverview').rejects(Object.assign(new StockServiceError(STOCK_ERROR_CODES.STOCK_REPOSITORY_ERROR, 'private detail'), {
      diagnostic: { cause: 'connection' }
    }))
    const absentOperationLog = sinon.stub(console, 'error')
    const absentOperationResponse = makeResponse()

    await getOverview(makeRequest({ query: { businessDate: '2026-10-15' } }), absentOperationResponse as unknown as Response)

    expect(absentOperationLog.firstCall.args[0]).to.include({
      event: 'stock_repository_failure',
      operation: 'stock_repository_unknown',
      cause: 'connection'
    })
    expect(bodyOf(absentOperationResponse)).to.deep.equal({
      code: STOCK_ERROR_CODES.STOCK_REPOSITORY_ERROR,
      message: 'Stock persistence is currently unavailable'
    })
  })

  it('classifies only known Mongo connection errors and keeps arbitrary names unknown', () => {
    const connectionError = Object.assign(new Error('private connection detail'), { name: 'MongoServerSelectionError' })
    const arbitraryError = Object.assign(new Error('private arbitrary detail'), { name: 'SecretInternalError' })
    expect(stockFailureDiagnosticOf('stock_overview_list_products', connectionError).cause).to.equal('connection')
    expect(stockFailureDiagnosticOf('stock_overview_list_products', arbitraryError).cause).to.equal('unknown')
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

  it('NFR-004/TC-020: rejects opening-count previews without an authenticated actor and exposes only the confirmation route for mutation', async () => {
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
    expect(paths).to.include('/opening-counts/confirm')
    expect(paths.filter((path) => path.includes('/opening-counts/'))).to.deep.equal([
      '/opening-counts/preview',
      '/opening-counts/confirm'
    ])
  })

  it('S-05: validates strict overview queries, defaults pagination, and never invokes the service for invalid input', async () => {
    const serviceCall = sinon.stub(StockService.prototype, 'getOverview').resolves(overviewResult)

    for (const query of [
      { businessDate: '2026-10-15', unexpected: 'nope' },
      { unexpected: 'nope' },
      { businessDate: '2026-10-15', page: '0' },
      { businessDate: '2026-10-15', pageSize: '101' },
      { businessDate: '2026-10-15', search: 'x'.repeat(101) },
      { businessDate: '2026-10-15', category: 'x'.repeat(101) },
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
    expect(bodyOf(response)).to.deep.include({ summary: overviewResult.summary, globalSummary: overviewResult.globalSummary, globalAlerts: [] })
    expect((bodyOf(response) as typeof overviewResult).items[0]).to.deep.include({ productName: 'Coffee', categoryName: 'Beverages', imagePath: 'coffee.jpg' })
  })

  it('uses the authenticated JWT actor for overview reads and rejects requests without an actor', async () => {
    const serviceCall = sinon.stub(StockService.prototype, 'getOverview').resolves(overviewResult)
    const response = makeResponse(ATTACKER_ID)

    await getOverview(makeRequest({ user: { id: ACTOR_ID }, query: { businessDate: '2026-10-15' } }), response as unknown as Response)

    expect(response.status.calledWith(200)).to.equal(true)
    expect(serviceCall.calledOnce).to.equal(true)
    expect(serviceCall.firstCall.args[0]).to.have.property('auth').deep.equal({ actorId: ACTOR_ID, canManageStock: true })

    serviceCall.resetHistory()
    const missingActorResponse = makeResponse('')
    await getOverview(makeRequest({ query: { businessDate: '2026-10-15' } }), missingActorResponse as unknown as Response)

    expect(missingActorResponse.status.calledWith(403)).to.equal(true)
    expect(bodyOf(missingActorResponse)).to.deep.include({ code: STOCK_ERROR_CODES.STOCK_FORBIDDEN })
    expect(serviceCall.called).to.equal(false)
  })

  it('S-03/S-09: passes normalized search and category filters to overview without changing global response contracts', async () => {
    const serviceCall = sinon.stub(StockService.prototype, 'getOverview').resolves(overviewResult)
    const response = makeResponse()
    await getOverview(makeRequest({ query: { businessDate: '2026-10-15', search: ' Coffee ', category: ' Beverages ' } }), response as unknown as Response)
    expect(response.status.calledWith(200)).to.equal(true)
    expect(serviceCall.firstCall.args[0]).to.deep.include({ search: 'Coffee', category: 'Beverages' })
    expect(bodyOf(response)).to.deep.include({ globalSummary: overviewResult.globalSummary, globalAlerts: overviewResult.globalAlerts })
  })

  it('S-05: validates strict product detail queries and maps missing products to a stable 404 envelope', async () => {
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

  it('NFR-004: strictly validates minimum updates, propagates the authenticated actor, and maps service failures', async () => {
    const serviceCall = sinon.stub(StockService.prototype, 'updateMinimum').resolves({ productId: PRODUCT_ID, minimum: 4 })
    for (const body of [{ minimum: -1 }, { minimum: 1.5 }, { minimum: Number.MAX_SAFE_INTEGER + 1 }, { minimum: 1, extra: true }, { minimum: 1, reason: 42 }, { minimum: 1, reason: 'x'.repeat(201) }]) {
      const response = makeResponse()
      await updateMinimum(makeRequest({ params: { id: PRODUCT_ID }, body }), response as unknown as Response)
      expect(response.status.calledWith(400)).to.equal(true)
    }
    expect(serviceCall.called).to.equal(false)

    const response = makeResponse()
    await updateMinimum(makeRequest({
      params: { id: PRODUCT_ID },
      headers: { 'x-correlation-id': 'correlation-1' },
      body: { minimum: 4, reason: 'Replenishment policy changed' }
    }), response as unknown as Response)
    expect(response.status.calledWith(200)).to.equal(true)
    expect(bodyOf(response)).to.deep.equal({ productId: PRODUCT_ID, minimum: 4 })
    expect(serviceCall.firstCall.args).to.deep.equal([
      PRODUCT_ID,
      4,
      { actorId: ACTOR_ID, canManageStock: true },
      { correlationId: 'correlation-1', reason: 'Replenishment policy changed' }
    ])

    serviceCall.resetHistory()
    serviceCall.rejects(new StockServiceError('STOCK_PRODUCT_NOT_FOUND', 'missing'))
    const missingResponse = makeResponse()
    await updateMinimum(makeRequest({ params: { id: PRODUCT_ID }, body: { minimum: 4 } }), missingResponse as unknown as Response)
    expect(missingResponse.status.calledWith(404)).to.equal(true)
  })

  it('SS04-RED S-04/S-05/S-08/S-06: adapts thresholds and product stock operations without bucket inputs or role gates', async () => {
    const minimumCall = sinon.stub(StockService.prototype, 'updateMinimum').resolves({ productId: PRODUCT_ID, minimum: 4, expiryAlertDays: 21 })
    const settingsResponse = makeResponse()
    await updateMinimum(makeRequest({ params: { id: PRODUCT_ID }, body: { minimum: 4, expiryAlertDays: 21 } }), settingsResponse as unknown as Response)
    expect(settingsResponse.status.calledWith(200)).to.equal(true)
    expect(minimumCall.firstCall.args[3]).to.deep.include({ expiryAlertDays: 21 })

    const writeOffCall = sinon.stub(StockService.prototype, 'writeOff').resolves(result(1, 0))
    const writeOffResponse = makeResponse()
    await writeOffProduct(makeRequest({ params: { id: PRODUCT_ID }, body: { operationId: 'writeoff-contract', businessDate: '2026-10-15', quantity: 2, reason: 'vencimiento', note: 'Observed damage' } }), writeOffResponse as unknown as Response)
    expect(writeOffResponse.status.calledWith(201)).to.equal(true)
    expect(writeOffCall.firstCall.args[0]).to.deep.include({ productId: PRODUCT_ID, quantity: 2, reason: 'vencimiento', note: 'Observed damage', auth: { actorId: ACTOR_ID, canManageStock: true } })

    const expiredCall = sinon.stub(StockService.prototype, 'removeExpiredProduct').resolves({ productId: PRODUCT_ID, operationId: 'expiry-contract', outcome: 'PARTIAL', removedQuantity: 2, movementCount: 1 })
    const expiredResponse = makeResponse()
    await removeExpiredProduct(makeRequest({ params: { id: PRODUCT_ID }, body: { operationId: 'expiry-contract', businessDate: '2026-10-15' } }), expiredResponse as unknown as Response)
    expect(expiredResponse.status.calledWith(201)).to.equal(true)
    expect(expiredCall.firstCall.args[0]).to.deep.include({ productId: PRODUCT_ID, auth: { actorId: ACTOR_ID, canManageStock: true } })
    expect(expiredCall.firstCall.args[0]).not.to.have.property('bucketId')

    const bulkCall = sinon.stub(StockService.prototype, 'removeExpiredProducts').resolves({ operationId: 'bulk-contract', results: [{ productId: PRODUCT_ID, status: 'REMOVED', removedQuantity: 2 }] })
    const bulkResponse = makeResponse()
    await removeExpiredProducts(makeRequest({ body: { operationId: 'bulk-contract', businessDate: '2026-10-15', productIds: [PRODUCT_ID] } }), bulkResponse as unknown as Response)
    expect(bulkResponse.status.calledWith(200)).to.equal(true)
    expect(bulkCall.firstCall.args[0]).to.deep.include({ productIds: [PRODUCT_ID], auth: { actorId: ACTOR_ID, canManageStock: true } })
  })

  it('S-01: requires strict availability queries to provide businessDate before invoking StockService', async () => {
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

  it('S-03/NFR-004: propagates the authenticated actor and ignores caller-supplied receivedBy', async () => {
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

  it('TC-018: returns 200 for a fully idempotent purchase retry', async () => {
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

  it('S-06: rejects malformed returns before invoking StockService and maps service conflicts stably', async () => {
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

  it('S-13/TC-018: returns 200 for an idempotent expired-bucket no-op and rejects unknown payload keys', async () => {
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
