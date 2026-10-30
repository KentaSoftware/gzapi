import { expect } from 'chai'
import sinon from 'sinon'
import mongoose, { Types, type ClientSession } from 'mongoose'

import {
  BASELINE_STATUS,
  EXPIRY_TRACKING,
  INVENTORY_MOVEMENT_TYPES,
  STOCK_ERROR_CODES
} from '../src/interfaces/stock.interface'
import {
  mapBucketDocumentToStockSnapshot,
  mapMovementDocumentToStockRecord,
  MongooseStockRepository,
  mapProductDocumentToStockSnapshot
} from '../src/services/stockMongoRepository'
import { STOCK_TIME_ZONE } from '../src/config/stock'
import ProductModel from '../src/models/product'
import InventoryMovementModel from '../src/models/inventoryMovement'
import StockExpiryBucketModel from '../src/models/stockExpiryBucket'
import StockOpeningOperationModel from '../src/models/stockOpeningOperation'
import StockMinimumAuditModel from '../src/models/stockMinimumAudit'
import {
  mapSaleReferenceToStockCommitInput,
  buenosAiresCivilDate,
  SaleCommitmentReference
} from '../src/services/commercialPorts'
import { StockServiceError } from '../src/services/stock'

describe('Stock Mongo repository and commercial reference mapping', () => {
  afterEach(() => {
    sinon.restore()
  })

  it('maps Product.stock only to physical quantity and derives availability from committed quantity', () => {
    const snapshot = mapProductDocumentToStockSnapshot({
      _id: new Types.ObjectId('507f1f77bcf86cd799439011'),
      stock: 12,
      inventory: {
        expiryTracking: EXPIRY_TRACKING.NOT_TRACKED,
        baselineStatus: BASELINE_STATUS.RECONCILED
      }
    }, 5)

    expect(snapshot).to.deep.equal({
      productId: '507f1f77bcf86cd799439011',
      physicalQuantity: 12,
      committedQuantity: 5,
      availableQuantity: 7,
      expiryTracking: EXPIRY_TRACKING.NOT_TRACKED,
      baselineStatus: BASELINE_STATUS.RECONCILED
    })
  })

  it('normalizes a non-canonical near-midnight UTC expiry through Buenos Aires time', () => {
    const snapshot = mapBucketDocumentToStockSnapshot({
      _id: new Types.ObjectId('507f1f77bcf86cd799439012'),
      productId: new Types.ObjectId('507f1f77bcf86cd799439011'),
      expiryDate: new Date('2026-10-16T02:00:00.000Z'),
      receivedQuantity: 10,
      availableQuantity: 4,
      committedQuantity: 6
    })

    expect(snapshot).to.deep.equal({
      bucketId: '507f1f77bcf86cd799439012',
      productId: '507f1f77bcf86cd799439011',
      expiryDate: '2026-10-15',
      receivedQuantity: 10,
      availableQuantity: 4,
      committedQuantity: 6
    })
  })

  it('interprets a Mongoose-canonical midnight UTC expiry as its stored civil date', () => {
    const snapshot = mapBucketDocumentToStockSnapshot({
      _id: new Types.ObjectId('507f1f77bcf86cd799439014'),
      productId: new Types.ObjectId('507f1f77bcf86cd799439011'),
      expiryDate: new Date('2026-10-16T00:00:00.000Z'),
      receivedQuantity: 10,
      availableQuantity: 4,
      committedQuantity: 6
    })

    expect(snapshot.expiryDate).to.equal('2026-10-16')
  })

  it('maps a lightweight sale reference with a deterministic date and ignores price or bulto fields', () => {
    const reference: SaleCommitmentReference = {
      saleId: 'sale-1',
      operationId: 'sale-operation-1',
      businessDate: '2026-10-15',
      lines: [{ _id: '507f1f77bcf86cd799439011', cantidad: 2, precio: 99, bulto: 12 }],
      actorId: '507f1f77bcf86cd799439013'
    }

    expect(mapSaleReferenceToStockCommitInput(reference)).to.deep.include({
      saleId: 'sale-1',
      operationId: 'sale-operation-1',
      businessDate: '2026-10-15',
      auth: { actorId: '507f1f77bcf86cd799439013', canManageStock: false }
    })
    const mapped = mapSaleReferenceToStockCommitInput(reference)
    expect(mapped.lines).to.have.length(1)
    expect(mapped.lines[0]).to.include({ productId: '507f1f77bcf86cd799439011', quantity: 2 })
    expect(mapped.lines[0].lineId).to.match(/^[0-9a-f]{24}$/)
  })

  it('maps source line IDs to deterministic, valid ObjectIds distinct across sales and lines', () => {
    const baseReference: SaleCommitmentReference = {
      saleId: 'sale-1',
      operationId: 'sale-operation-1',
      businessDate: '2026-10-15',
      lines: [
        { lineId: 'arbitrary-line-id', productId: 'product-1', quantity: 1 },
        { lineId: '507f1f77bcf86cd799439012', productId: 'product-2', quantity: 1 }
      ],
      actorId: '507f1f77bcf86cd799439013'
    }

    const first = mapSaleReferenceToStockCommitInput(baseReference)
    const retry = mapSaleReferenceToStockCommitInput(baseReference)
    const otherSale = mapSaleReferenceToStockCommitInput({ ...baseReference, saleId: 'sale-2' })

    expect(first.lines[0].lineId).to.equal(retry.lines[0].lineId)
    expect(first.lines[0].lineId).to.match(/^[0-9a-f]{24}$/)
    expect(first.lines[1].lineId).to.equal('507f1f77bcf86cd799439012')
    expect(first.lines[0].lineId).to.not.equal(first.lines[1].lineId)
    expect(first.lines[0].lineId).to.not.equal(otherSale.lines[0].lineId)
  })

  it('normalizes sale business dates using the configured stock timezone', () => {
    const date = new Date('2026-10-16T02:00:00.000Z')
    const expectedParts = new Intl.DateTimeFormat('en-US', {
      timeZone: STOCK_TIME_ZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).formatToParts(date)
    const partValue = (type: 'year' | 'month' | 'day'): string => {
      const value = expectedParts.find((part) => part.type === type)?.value
      if (value === undefined) throw new Error(`Missing date part ${type}`)
      return value
    }
    const expected = `${partValue('year')}-${partValue('month')}-${partValue('day')}`

    expect(buenosAiresCivilDate(date)).to.equal(expected)
  })

  it('aggregates bounded sales history by product without price or conversion fields', async () => {
    const productId = new Types.ObjectId('507f1f77bcf86cd799439011')
    const aggregateQuery = {
      exec: sinon.stub().resolves([{
        _id: productId,
        createdAt: new Date('2026-07-17T03:00:00.000Z'),
        sales: [
          { occurredAt: new Date('2026-09-01T12:00:00.000Z'), quantity: 2, active: true, status: 'Creado' },
          { occurredAt: new Date('2026-09-02T12:00:00.000Z'), quantity: 3, status: 'Cancelado' }
        ]
      }])
    }
    const aggregateStub = sinon.stub(ProductModel, 'aggregate').returns(aggregateQuery as unknown as ReturnType<typeof ProductModel.aggregate>)
    const repository = new MongooseStockRepository()

    const result = await repository.getSalesHistory([productId.toString()], '2026-10-15', 90, STOCK_TIME_ZONE)

    expect(result[0]).to.deep.include({
      productId: productId.toString(),
      productCreatedAt: '2026-07-17T03:00:00.000Z',
      businessDate: '2026-10-15',
      rotationDays: 90,
      timeZone: STOCK_TIME_ZONE
    })
    expect(result[0].sales).to.deep.equal([
      { occurredAt: '2026-09-01T12:00:00.000Z', quantity: 2, active: true, cancelled: false },
      { occurredAt: '2026-09-02T12:00:00.000Z', quantity: 3, cancelled: true }
    ])
    expect(aggregateStub.calledOnce).to.equal(true)
    const pipeline = aggregateStub.firstCall.args[0] as unknown[]
    expect(JSON.stringify(pipeline)).to.include('2026-07-17')
    expect(JSON.stringify(pipeline)).to.include('2026-10-15')
    expect(JSON.stringify(pipeline)).to.not.include('precio')
    expect(JSON.stringify(pipeline)).to.not.include('bulto')
  })

  it('includes product identity in paged stock catalog records', async () => {
    const productId = new Types.ObjectId('507f1f77bcf86cd799439011')
    const productQuery = {
      select: sinon.stub().returnsThis(),
      sort: sinon.stub().returnsThis(),
      skip: sinon.stub().returnsThis(),
      limit: sinon.stub().returnsThis(),
      lean: sinon.stub().returnsThis(),
      exec: sinon.stub().resolves([{ _id: productId, descripcion: 'Café molido', stock: 4, inventory: { expiryTracking: EXPIRY_TRACKING.TRACKED, baselineStatus: BASELINE_STATUS.RECONCILED } }])
    }
    sinon.stub(ProductModel, 'find').returns(productQuery as unknown as ReturnType<typeof ProductModel.find>)
    sinon.stub(ProductModel, 'countDocuments').returns({ exec: sinon.stub().resolves(1) } as unknown as ReturnType<typeof ProductModel.countDocuments>)
    sinon.stub(StockExpiryBucketModel, 'find').returns({ sort: sinon.stub().returnsThis(), lean: sinon.stub().returnsThis(), exec: sinon.stub().resolves([]) } as unknown as ReturnType<typeof StockExpiryBucketModel.find>)
    sinon.stub(ProductModel, 'aggregate').returns({ exec: sinon.stub().resolves([]) } as unknown as ReturnType<typeof ProductModel.aggregate>)

    const page = await new MongooseStockRepository().listProducts(1, 10)

    expect(page.items[0]).to.include({ productId: productId.toString(), productName: 'Café molido' })
    expect(productQuery.select.calledWith('_id descripcion path stock inventory categoria')).to.equal(true)
    expect(page.items[0]).to.not.have.property('imagePath')
  })

  it('loads category and image display metadata only for the selected product page', async () => {
    const productId = new Types.ObjectId('507f1f77bcf86cd799439011')
    const categoryId = new Types.ObjectId('507f1f77bcf86cd799439012')
    const productQuery = {
      select: sinon.stub().returnsThis(), sort: sinon.stub().returnsThis(), skip: sinon.stub().returnsThis(),
      limit: sinon.stub().returnsThis(), lean: sinon.stub().returnsThis(),
      exec: sinon.stub().resolves([{ _id: productId, descripcion: 'Coffee', path: 'coffee.jpg', stock: 4, categoria: categoryId, inventory: { expiryTracking: EXPIRY_TRACKING.TRACKED, baselineStatus: BASELINE_STATUS.RECONCILED } }])
    }
    sinon.stub(ProductModel, 'find').returns(productQuery as unknown as ReturnType<typeof ProductModel.find>)
    sinon.stub(ProductModel, 'countDocuments').returns({ exec: sinon.stub().resolves(2) } as unknown as ReturnType<typeof ProductModel.countDocuments>)
    sinon.stub(StockExpiryBucketModel, 'find').returns({ sort: sinon.stub().returnsThis(), lean: sinon.stub().returnsThis(), exec: sinon.stub().resolves([]) } as unknown as ReturnType<typeof StockExpiryBucketModel.find>)
    const aggregateStub = sinon.stub(ProductModel, 'aggregate').returns({ exec: sinon.stub().resolves([{ _id: productId, categoryName: 'Beverages' }]) } as unknown as ReturnType<typeof ProductModel.aggregate>)

    const page = await new MongooseStockRepository().listProducts(2, 1)

    expect(page.items[0]).to.include({ productName: 'Coffee', categoryName: 'Beverages', imagePath: 'coffee.jpg' })
    expect(productQuery.select.calledWith('_id descripcion path stock inventory categoria')).to.equal(true)
    const pipeline = JSON.stringify(aggregateStub.firstCall.args[0])
    expect(pipeline).to.include('categories')
    expect(pipeline).to.include('categoryName')
    expect(pipeline).to.include(productId.toString())
    expect(pipeline).to.not.include('precio')
    expect(pipeline).to.not.include('stock')
  })

  it('classifies category lookup failures with a finite list-products stage', async () => {
    const productId = new Types.ObjectId('507f1f77bcf86cd799439011')
    const productQuery = {
      select: sinon.stub().returnsThis(), sort: sinon.stub().returnsThis(), skip: sinon.stub().returnsThis(),
      limit: sinon.stub().returnsThis(), lean: sinon.stub().returnsThis(),
      exec: sinon.stub().resolves([{ _id: productId, descripcion: 'Coffee', stock: 4, inventory: { expiryTracking: EXPIRY_TRACKING.TRACKED, baselineStatus: BASELINE_STATUS.RECONCILED } }])
    }
    sinon.stub(ProductModel, 'find').returns(productQuery as unknown as ReturnType<typeof ProductModel.find>)
    sinon.stub(ProductModel, 'countDocuments').returns({ exec: sinon.stub().resolves(1) } as unknown as ReturnType<typeof ProductModel.countDocuments>)
    sinon.stub(ProductModel, 'aggregate').returns({ exec: sinon.stub().rejects(new Error('private category query details')) } as unknown as ReturnType<typeof ProductModel.aggregate>)

    const error = await new MongooseStockRepository().listProducts(1, 10).catch((caught: unknown) => caught)

    expect(error).to.be.instanceOf(StockServiceError)
    expect((error as StockServiceError).diagnostic).to.include({
      operation: 'stock_repository_unknown',
      stage: 'category_lookup'
    })
    expect((error as Error).message).not.to.include('private category query details')
  })

  it('classifies malformed product IDs as product normalization failures', async () => {
    const productQuery = {
      select: sinon.stub().returnsThis(),
      sort: sinon.stub().returnsThis(),
      skip: sinon.stub().returnsThis(),
      limit: sinon.stub().returnsThis(),
      lean: sinon.stub().returnsThis(),
      exec: sinon.stub().resolves([{ _id: 'malformed-id', descripcion: 'Coffee', stock: 4 }])
    }
    sinon.stub(ProductModel, 'find').returns(productQuery as unknown as ReturnType<typeof ProductModel.find>)
    sinon.stub(ProductModel, 'countDocuments').returns({ exec: sinon.stub().resolves(1) } as unknown as ReturnType<typeof ProductModel.countDocuments>)
    const aggregateStub = sinon.stub(ProductModel, 'aggregate')

    const error = await new MongooseStockRepository().listProducts(1, 10).catch((caught: unknown) => caught)

    expect(error).to.be.instanceOf(StockServiceError)
    expect((error as StockServiceError).diagnostic).to.include({
      operation: 'stock_repository_unknown',
      stage: 'product_normalization'
    })
    expect(aggregateStub.called).to.equal(false)
  })

  it('filters and counts matching catalog products before pagination using escaped name text and category metadata', async () => {
    const productId = new Types.ObjectId('507f1f77bcf86cd799439011')
    const productQuery = {
      select: sinon.stub().returnsThis(), sort: sinon.stub().returnsThis(), skip: sinon.stub().returnsThis(),
      limit: sinon.stub().returnsThis(), lean: sinon.stub().returnsThis(),
      exec: sinon.stub().resolves([{ _id: productId, descripcion: 'Coffee (dark)', stock: 4, categoria: new Types.ObjectId('507f1f77bcf86cd799439012'), inventory: { expiryTracking: EXPIRY_TRACKING.TRACKED, baselineStatus: BASELINE_STATUS.RECONCILED } }])
    }
    const findStub = sinon.stub(ProductModel, 'find').returns(productQuery as unknown as ReturnType<typeof ProductModel.find>)
    sinon.stub(ProductModel, 'countDocuments').returns({ exec: sinon.stub().resolves(3) } as unknown as ReturnType<typeof ProductModel.countDocuments>)
    sinon.stub(StockExpiryBucketModel, 'find').returns({ sort: sinon.stub().returnsThis(), lean: sinon.stub().returnsThis(), exec: sinon.stub().resolves([]) } as unknown as ReturnType<typeof StockExpiryBucketModel.find>)
    const aggregateStub = sinon.stub(ProductModel, 'aggregate').returns({ exec: sinon.stub().resolves([{ metadata: [{ total: 3 }], items: [{ _id: productId, descripcion: 'Coffee (dark)', stock: 4, categoria: new Types.ObjectId('507f1f77bcf86cd799439012'), inventory: { expiryTracking: EXPIRY_TRACKING.TRACKED, baselineStatus: BASELINE_STATUS.RECONCILED }, categoryName: 'Beverages' }] }]) } as unknown as ReturnType<typeof ProductModel.aggregate>)
    const page = await new MongooseStockRepository().listProducts(2, 1, undefined, { search: 'Coffee (dark)', category: 'Beverages' })
    expect(page.total).to.equal(3)
    expect(page.items).to.have.length(1)
    expect(findStub.called).to.equal(false)
    expect(JSON.stringify(aggregateStub.firstCall.args[0])).to.include('categories')
    const pipeline = aggregateStub.firstCall.args[0] as Array<Record<string, unknown>>
    expect(pipeline[0].$match).to.deep.equal({ descripcion: /Coffee \(dark\)/i })
    expect(JSON.stringify(pipeline)).to.include('skip')
    expect(JSON.stringify(pipeline)).to.include('limit')
    expect(JSON.stringify(pipeline)).to.include('categoryMetadata')
    expect(JSON.stringify(pipeline)).to.include('categoryName')
    const facet = pipeline.find((stage) => '$facet' in stage)?.$facet as { items: Array<Record<string, unknown>> }
    expect(facet.items.at(-1)?.$project).to.deep.equal({
      _id: 1,
      descripcion: 1,
      path: 1,
      stock: 1,
      inventory: 1,
      categoria: 1,
      categoryName: { $arrayElemAt: ['$categoryMetadata.descripcion', 0] }
    })
  })

  it('aggregates only each requested product latest active non-cancelled sale across all history', async () => {
    const productId = new Types.ObjectId('507f1f77bcf86cd799439011')
    const occurredAt = new Date('2025-01-10T08:30:00.000Z')
    const aggregateQuery = { exec: sinon.stub().resolves([{ _id: productId, occurredAt }]) }
    const aggregateStub = sinon.stub(ProductModel, 'aggregate').returns(aggregateQuery as unknown as ReturnType<typeof ProductModel.aggregate>)
    const repository = new MongooseStockRepository()

    const result = await repository.getLatestSales([productId.toString()])

    expect(result).to.deep.equal([{ productId: productId.toString(), occurredAt }])
    const pipeline = aggregateStub.firstCall.args[0] as unknown[]
    const serialized = JSON.stringify(pipeline)
    expect(serialized).to.include('itemsales')
    expect(serialized).to.include('sales')
    expect(serialized).to.include('estado')
    expect(serialized).to.include('createdAt')
    expect(serialized).to.include('limit')
    expect(serialized).to.not.include('expiryBucket')
    const productLookup = (pipeline[1] as { $lookup: { pipeline: unknown[] } }).$lookup.pipeline
    const activeLineMatch = productLookup[0] as { $match: { $expr: { $and: unknown[] } } }
    expect(JSON.stringify(activeLineMatch)).to.include('estado')
    expect(JSON.stringify(activeLineMatch)).to.include('$ne')
    const saleStatusMatch = productLookup[3] as { $match: { 'sale.estado': { $not: RegExp } } }
    expect(!saleStatusMatch.$match['sale.estado'].$not.test('Cancelado')).to.equal(false)
    expect(!saleStatusMatch.$match['sale.estado'].$not.test('Creado')).to.equal(true)
    expect(productLookup[4]).to.deep.equal({ $sort: { 'sale.createdAt': -1, 'sale._id': -1 } })
    expect(productLookup[5]).to.deep.equal({ $limit: 1 })
    expect(aggregateStub.calledOnce).to.equal(true)
  })

  it('returns no latest-sale rows for no qualifying records and skips oversized product batches', async () => {
    const aggregateStub = sinon.stub(ProductModel, 'aggregate').returns({ exec: sinon.stub().resolves([]) } as unknown as ReturnType<typeof ProductModel.aggregate>)
    const repository = new MongooseStockRepository()

    expect(await repository.getLatestSales(['507f1f77bcf86cd799439011'])).to.deep.equal([])
    expect(await repository.getLatestSales(Array.from({ length: 101 }, () => '507f1f77bcf86cd799439011'))).to.deep.equal([])
    expect(aggregateStub.calledOnce).to.equal(true)
  })

  it('does not aggregate sales history when the supplied transaction session is unavailable', async () => {
    const aggregateStub = sinon.stub(ProductModel, 'aggregate')
    const repository = new MongooseStockRepository()

    const result = await repository.getSalesHistory(['507f1f77bcf86cd799439011'], '2026-10-15', 90, STOCK_TIME_ZONE, { transactionId: 'missing-session' }).catch((error: unknown) => error)

    expect(result).to.be.instanceOf(StockServiceError)
    expect(aggregateStub.called).to.equal(false)
  })

  it('uses the neutral operation label for repository failures outside an overview stage', async () => {
    const query = {
      session: sinon.stub().returnsThis(),
      lean: sinon.stub().returnsThis(),
      exec: sinon.stub().rejects(Object.assign(new Error('private connection detail'), { name: 'MongoNetworkError' }))
    }
    sinon.stub(ProductModel, 'findById').returns(query as unknown as ReturnType<typeof ProductModel.findById>)
    const repository = new MongooseStockRepository()
    const error = await repository.getProduct('507f1f77bcf86cd799439011').catch((caught: unknown) => caught)

    expect(error).to.be.instanceOf(StockServiceError)
    expect((error as StockServiceError).diagnostic).to.deep.equal({ operation: 'stock_repository_unknown', cause: 'connection' })
  })

  it('preserves validated movement audit timestamps when mapping Mongo documents', () => {
    const createdAt = new Date('2026-10-15T10:00:00.000Z')
    const updatedAt = new Date('2026-10-15T11:00:00.000Z')
    const mapped = mapMovementDocumentToStockRecord({
      _id: new Types.ObjectId('507f1f77bcf86cd799439011'),
      productId: new Types.ObjectId('507f1f77bcf86cd799439012'),
      type: INVENTORY_MOVEMENT_TYPES.SALE_COMMIT,
      quantity: 2,
      occurredAt: new Date('2026-10-15T09:00:00.000Z'),
      sourceType: 'SALE',
      sourceId: 'sale-1',
      sourceEvent: 'COMMIT',
      operationId: 'operation-1',
      idempotencyKey: 'idempotency-1',
      rulesVersion: 'stock-rules-v1',
      createdBy: new Types.ObjectId('507f1f77bcf86cd799439013'),
      createdAt,
      updatedAt
    })

    expect(mapped.createdAt).to.deep.equal(createdAt)
    expect(mapped.updatedAt).to.deep.equal(updatedAt)
    expect(mapped.createdAt).to.not.equal(createdAt)
    expect(mapped.updatedAt).to.not.equal(updatedAt)
  })

  it('rejects malformed commercial lines with a typed Stock error', () => {
    const reference: SaleCommitmentReference = {
      saleId: 'sale-1',
      lines: [{ _id: 'line-1', idProducto: 'product-1', cantidad: 0 }],
      actorId: 'actor-1'
    }

    expect(() => mapSaleReferenceToStockCommitInput(reference)).to.throw(StockServiceError)
    try {
      mapSaleReferenceToStockCommitInput(reference)
      expect.fail('expected malformed line to be rejected')
    } catch (error) {
      expect(error).to.have.property('code', STOCK_ERROR_CODES.STOCK_DATA_INCOMPLETE)
    }
  })

  it('writes only physical product projection deltas to Product.stock', async () => {
    const updateQuery = {
      session: sinon.stub().returnsThis(),
      exec: sinon.stub().resolves({ matchedCount: 1 })
    }
    const updateStub = sinon.stub(ProductModel, 'updateOne').returns(updateQuery as unknown as ReturnType<typeof ProductModel.updateOne>)
    const repository = new MongooseStockRepository()

    await repository.applyProductProjectionDelta('507f1f77bcf86cd799439011', {
      availableQuantityDelta: 0,
      committedQuantityDelta: 0,
      physicalQuantityDelta: 3
    })

    expect(updateStub.calledOnce).to.equal(true)
    expect(updateStub.firstCall.args[1]).to.deep.equal({ $inc: { stock: 3 } })
  })

  it('persists opening operation evidence through the supplied session', async () => {
    const operationQuery = {
      session: sinon.stub().returnsThis(),
      lean: sinon.stub().returnsThis(),
      exec: sinon.stub().resolves(undefined)
    }
    const findStub = sinon.stub(StockOpeningOperationModel, 'findOne').returns(operationQuery as unknown as ReturnType<typeof StockOpeningOperationModel.findOne>)
    const repository = new MongooseStockRepository()

    const result = await repository.getOpeningOperation('opening-operation-1', { transactionId: 'missing-session' }).catch((error: unknown) => error)

    expect(result).to.be.instanceOf(StockServiceError)
    expect(findStub.called).to.equal(false)
  })

  it('reconciles the absolute physical product projection and propagates its session', async () => {
    const updateQuery = {
      session: sinon.stub().returnsThis(),
      exec: sinon.stub().resolves({ matchedCount: 1 })
    }
    const updateStub = sinon.stub(ProductModel, 'updateOne').returns(updateQuery as unknown as ReturnType<typeof ProductModel.updateOne>)
    const repository = new MongooseStockRepository()

    await repository.reconcileOpeningProduct('507f1f77bcf86cd799439011', 8, '507f1f77bcf86cd799439013', new Date('2026-10-15T12:00:00.000Z'), { transactionId: 'missing-session' }).catch((error: unknown) => error)

    expect(updateStub.called).to.equal(false)
  })

  it('resets omitted opening buckets to zero while preserving their commitment field', async () => {
    const productId = new Types.ObjectId('507f1f77bcf86cd799439011')
    const staleBucketId = new Types.ObjectId('507f1f77bcf86cd799439012')
    const findQuery = {
      sort: sinon.stub().returnsThis(),
      lean: sinon.stub().returnsThis(),
      exec: sinon.stub().resolves([{
        _id: staleBucketId,
        productId,
        expiryDate: new Date('2026-12-30T00:00:00.000Z'),
        receivedQuantity: 6,
        availableQuantity: 6,
        committedQuantity: 0
      }])
    }
    const staleUpdateQuery = {
      exec: sinon.stub().resolves({ matchedCount: 1 })
    }
    const targetUpdateQuery = {
      lean: sinon.stub().returnsThis(),
      exec: sinon.stub().resolves({
        _id: new Types.ObjectId('507f1f77bcf86cd799439013'),
        productId,
        expiryDate: new Date('2026-12-31T00:00:00.000Z'),
        receivedQuantity: 4,
        availableQuantity: 4,
        committedQuantity: 0
      })
    }
    sinon.stub(StockExpiryBucketModel, 'find').returns(findQuery as unknown as ReturnType<typeof StockExpiryBucketModel.find>)
    const updateStub = sinon.stub(StockExpiryBucketModel, 'updateOne').returns(staleUpdateQuery as unknown as ReturnType<typeof StockExpiryBucketModel.updateOne>)
    const targetStub = sinon.stub(StockExpiryBucketModel, 'findOneAndUpdate').returns(targetUpdateQuery as unknown as ReturnType<typeof StockExpiryBucketModel.findOneAndUpdate>)
    const repository = new MongooseStockRepository()

    await repository.reconcileOpeningBuckets(productId.toString(), [{ expiryDate: '2026-12-31', receivedQuantity: 4, availableQuantity: 4 }])

    expect(updateStub.firstCall.args[1]).to.deep.equal({ $set: { receivedQuantity: 0, availableQuantity: 0 } })
    expect(targetStub.firstCall.args[1].$set).to.deep.equal({ receivedQuantity: 4, availableQuantity: 4 })
    expect(targetStub.firstCall.args[1].$setOnInsert.committedQuantity).to.equal(0)
  })

  it('updates only inventory.minimum and preserves transaction session propagation', async () => {
    const updateQuery = {
      session: sinon.stub().returnsThis(),
      select: sinon.stub().returnsThis(),
      lean: sinon.stub().returnsThis(),
      exec: sinon.stub().resolves({
        _id: new Types.ObjectId('507f1f77bcf86cd799439011'),
        inventory: { minimum: 9 }
      })
    }
    const updateStub = sinon.stub(ProductModel, 'findOneAndUpdate').returns(updateQuery as unknown as ReturnType<typeof ProductModel.findOneAndUpdate>)
    const repository = new MongooseStockRepository()

    const result = await repository.updateProductMinimum('507f1f77bcf86cd799439011', 9, { transactionId: 'missing-session' }).catch((error: unknown) => error)

    expect(result).to.be.instanceOf(StockServiceError)
    expect(updateStub.called).to.equal(false)

    const success = await repository.updateProductMinimum('507f1f77bcf86cd799439011', 9)
    expect(success).to.deep.equal({ productId: '507f1f77bcf86cd799439011', minimum: 9 })
    expect(updateStub.firstCall.args[1]).to.deep.equal({ $set: { 'inventory.minimum': 9 } })
  })

  it('persists minimum audit records through the supplied transaction session', async () => {
    const auditDocument = {
      _id: new Types.ObjectId('507f1f77bcf86cd799439014'),
      productId: '507f1f77bcf86cd799439011',
      actorId: '507f1f77bcf86cd799439013',
      previousMinimum: null,
      newMinimum: 9,
      occurredAt: new Date('2026-10-15T12:00:00.000Z'),
      correlationId: 'correlation-1',
      reason: 'Initial policy'
    }
    const createStub = sinon.stub(StockMinimumAuditModel, 'create').resolves([auditDocument] as never)
    const repository = new MongooseStockRepository()

    const audit = await repository.insertMinimumAudit({
      productId: auditDocument.productId,
      actorId: auditDocument.actorId,
      previousMinimum: auditDocument.previousMinimum,
      newMinimum: auditDocument.newMinimum,
      occurredAt: auditDocument.occurredAt,
      correlationId: auditDocument.correlationId,
      reason: auditDocument.reason
    })

    expect(audit).to.deep.include({
      productId: auditDocument.productId,
      actorId: auditDocument.actorId,
      previousMinimum: null,
      newMinimum: 9,
      correlationId: 'correlation-1',
      reason: 'Initial policy'
    })
    expect(createStub.calledOnce).to.equal(true)
    expect(createStub.firstCall.args[0]).to.deep.equal([{
      productId: auditDocument.productId,
      actorId: auditDocument.actorId,
      previousMinimum: null,
      newMinimum: 9,
      occurredAt: auditDocument.occurredAt,
      correlationId: 'correlation-1',
      reason: 'Initial policy'
    }])

    const session = {
      id: 'minimum-audit-session',
      withTransaction: async (work: () => Promise<void>): Promise<void> => await work(),
      endSession: sinon.stub().resolves()
    } as unknown as ClientSession
    sinon.stub(mongoose, 'startSession').resolves(session)
    createStub.resetHistory()
    createStub.resolves([{
      ...auditDocument,
      toObject: () => auditDocument
    }] as never)
    await repository.withTransaction(async (transaction) => await transaction.insertMinimumAudit({
      productId: auditDocument.productId,
      actorId: auditDocument.actorId,
      previousMinimum: 4,
      newMinimum: 9,
      occurredAt: auditDocument.occurredAt
    }, transaction.session))
    expect(createStub.calledOnce).to.equal(true)
    expect(createStub.firstCall.args[1]).to.deep.equal({ session })
  })

  it('defines bounded append-only audit fields and product/time plus correlation indexes', () => {
    const paths = StockMinimumAuditModel.schema.paths
    expect(paths.productId.options).to.include({ type: String, required: true, trim: true })
    expect(paths.actorId.options).to.include({ type: String, required: true, trim: true })
    expect(paths.previousMinimum.options).to.include({ type: Number, required: false, default: null })
    expect(paths.newMinimum.options).to.include({ type: Number, required: true })
    expect(paths.occurredAt.options).to.include({ type: Date, required: true })
    expect(paths.correlationId.options).to.include({ type: String, required: false, trim: true, maxlength: 128 })
    expect(paths.reason.options).to.include({ type: String, required: false, trim: true, maxlength: 200 })
    const indexes = StockMinimumAuditModel.schema.indexes().map(([fields, options]) => ({ fields, options }))
    expect(indexes).to.deep.include({
      fields: { productId: 1, occurredAt: -1 },
      options: { name: 'idx_stock_minimum_audit_product_occurred_at', background: true }
    })
    expect(indexes).to.deep.include({
      fields: { correlationId: 1 },
      options: { name: 'idx_stock_minimum_audit_correlation', background: true }
    })
  })

  it('queries product-scoped movements in deterministic descending order with a bounded limit', async () => {
    const movementQuery = {
      sort: sinon.stub().returnsThis(),
      limit: sinon.stub().returnsThis(),
      lean: sinon.stub().returnsThis(),
      exec: sinon.stub().resolves([])
    }
    const findStub = sinon.stub(InventoryMovementModel, 'find').returns(movementQuery as unknown as ReturnType<typeof InventoryMovementModel.find>)
    const repository = new MongooseStockRepository()

    await repository.findMovements({ productId: '507f1f77bcf86cd799439011', limit: 2 })

    expect(findStub.firstCall.args[0]).to.deep.equal({ productId: new Types.ObjectId('507f1f77bcf86cd799439011') })
    expect(movementQuery.sort.calledWith({ occurredAt: -1, _id: -1 })).to.equal(true)
    expect(movementQuery.limit.calledWith(2)).to.equal(true)
  })

  it('applies bucket availability and commitment deltas atomically through one update', async () => {
    const updateQuery = {
      session: sinon.stub().returnsThis(),
      exec: sinon.stub().resolves({ matchedCount: 1 })
    }
    const updateStub = sinon.stub(StockExpiryBucketModel, 'updateOne').returns(updateQuery as unknown as ReturnType<typeof StockExpiryBucketModel.updateOne>)
    const repository = new MongooseStockRepository()

    await repository.applyBucketProjectionDelta('507f1f77bcf86cd799439012', {
      availableQuantityDelta: -2,
      committedQuantityDelta: 2,
      receivedQuantityDelta: -2
    })

    expect(updateStub.calledOnce).to.equal(true)
    expect(updateStub.firstCall.args[1]).to.deep.equal({
      $inc: { availableQuantity: -2, committedQuantity: 2, receivedQuantity: -2 }
    })
  })

  it('reads a bucket by identity and propagates the Mongo session', async () => {
    const bucketQuery = {
      session: sinon.stub().returnsThis(),
      lean: sinon.stub().returnsThis(),
      exec: sinon.stub().resolves({
        _id: new Types.ObjectId('507f1f77bcf86cd799439012'),
        productId: new Types.ObjectId('507f1f77bcf86cd799439011'),
        expiryDate: new Date('2026-10-10T00:00:00.000Z'),
        receivedQuantity: 4,
        availableQuantity: 4,
        committedQuantity: 0
      })
    }
    const findStub = sinon.stub(StockExpiryBucketModel, 'findById').returns(bucketQuery as unknown as ReturnType<typeof StockExpiryBucketModel.findById>)
    const repository = new MongooseStockRepository()

    const snapshot = await repository.getBucket('507f1f77bcf86cd799439012', { transactionId: 'missing-session' }).catch((error: unknown) => error)

    expect(snapshot).to.be.instanceOf(StockServiceError)
    expect(findStub.called).to.equal(false)
  })

  it('upserts physical receipt buckets with session-aware atomic increments', async () => {
    const updateQuery = {
      session: sinon.stub().returnsThis(),
      lean: sinon.stub().returnsThis(),
      exec: sinon.stub().resolves({
        _id: new Types.ObjectId('507f1f77bcf86cd799439012'),
        productId: new Types.ObjectId('507f1f77bcf86cd799439011'),
        expiryDate: new Date('2026-11-01T12:00:00.000Z'),
        receivedQuantity: 4,
        availableQuantity: 4,
        committedQuantity: 0
      })
    }
    const updateStub = sinon.stub(StockExpiryBucketModel, 'findOneAndUpdate').returns(updateQuery as unknown as ReturnType<typeof StockExpiryBucketModel.findOneAndUpdate>)
    const repository = new MongooseStockRepository()

    const snapshot = await repository.applyPhysicalBucketReceipt('507f1f77bcf86cd799439011', '2026-11-01', 4)

    expect(snapshot).to.deep.include({ expiryDate: '2026-11-01', receivedQuantity: 4, availableQuantity: 4, committedQuantity: 0 })
    expect(updateStub.calledOnce).to.equal(true)
    expect(updateStub.firstCall.args[0]).to.deep.equal({
      productId: new Types.ObjectId('507f1f77bcf86cd799439011'),
      expiryDate: '2026-11-01',
      receivedQuantity: { $gte: 0 },
      availableQuantity: { $gte: 0 },
      committedQuantity: { $gte: 0 }
    })
    expect(updateStub.firstCall.args[1]).to.deep.equal({
      $setOnInsert: {
        productId: new Types.ObjectId('507f1f77bcf86cd799439011'),
        expiryDate: '2026-11-01',
        receivedQuantity: 0,
        availableQuantity: 0,
        committedQuantity: 0
      },
      $inc: { receivedQuantity: 4, availableQuantity: 4 }
    })
  })

  it('rejects impossible civil expiry dates before writing', async () => {
    const updateStub = sinon.stub(StockExpiryBucketModel, 'findOneAndUpdate')
    const repository = new MongooseStockRepository()

    try {
      await repository.applyPhysicalBucketReceipt('507f1f77bcf86cd799439011', '2026-02-30', 4)
      expect.fail('expected impossible expiry date to reject')
    } catch (error) {
      expect(error).to.be.instanceOf(StockServiceError)
      expect(error).to.have.property('code', STOCK_ERROR_CODES.STOCK_REPOSITORY_ERROR)
    }

    expect(updateStub.called).to.equal(false)
  })

  it('derives non-tracked commitments after delivered-out movements', async () => {
    const productId = new Types.ObjectId('507f1f77bcf86cd799439011')
    const actorId = new Types.ObjectId('507f1f77bcf86cd799439013')
    const occurredAt = new Date('2026-10-15T12:00:00.000Z')
    const movement = {
      _id: new Types.ObjectId('507f1f77bcf86cd799439014'),
      productId,
      type: INVENTORY_MOVEMENT_TYPES.SALE_COMMIT,
      quantity: 3,
      occurredAt,
      sourceType: 'SALE',
      sourceId: 'sale-1',
      sourceEvent: 'SALE_COMMIT',
      operationId: 'operation-1',
      idempotencyKey: 'idempotency-1',
      rulesVersion: 'stock-rules-v1',
      createdBy: actorId,
      createdAt: occurredAt,
      updatedAt: occurredAt
    }
    const delivered = { ...movement, _id: new Types.ObjectId('507f1f77bcf86cd799439015'), type: INVENTORY_MOVEMENT_TYPES.SALE_DELIVERED_OUT, sourceEvent: 'SALE_DELIVERY', idempotencyKey: 'idempotency-2', reversesMovementId: movement._id }
    const productQuery = {
      lean: sinon.stub().returnsThis(),
      exec: sinon.stub().resolves({ _id: productId, stock: 10, inventory: { expiryTracking: EXPIRY_TRACKING.NOT_TRACKED, baselineStatus: BASELINE_STATUS.RECONCILED } })
    }
    const movementQuery = {
      lean: sinon.stub().returnsThis(),
      exec: sinon.stub().resolves([movement, delivered])
    }
    sinon.stub(ProductModel, 'findById').returns(productQuery as unknown as ReturnType<typeof ProductModel.findById>)
    const findStub = sinon.stub(InventoryMovementModel, 'find').returns(movementQuery as unknown as ReturnType<typeof InventoryMovementModel.find>)
    const repository = new MongooseStockRepository()

    const snapshot = await repository.getProduct(productId.toString())

    expect(snapshot).to.deep.include({ physicalQuantity: 10, committedQuantity: 0, availableQuantity: 10 })
    expect(findStub.firstCall.args[0]).to.deep.include({
      type: {
        $in: [
          INVENTORY_MOVEMENT_TYPES.SALE_COMMIT,
          INVENTORY_MOVEMENT_TYPES.SALE_CANCEL,
          INVENTORY_MOVEMENT_TYPES.SALE_ADJUSTMENT,
          INVENTORY_MOVEMENT_TYPES.SALE_DELIVERED_OUT
        ]
      }
    })
  })

  it('exposes movement types needed by ledger derivation', () => {
    expect(INVENTORY_MOVEMENT_TYPES.SALE_COMMIT).to.equal('SALE_COMMIT')
    expect(INVENTORY_MOVEMENT_TYPES.SALE_CANCEL).to.equal('SALE_CANCEL')
  })
})
