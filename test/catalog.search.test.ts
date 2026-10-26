/**
 * PS-T13 — Catalog search: similarity scoring, match priority and batch validation.
 * No database: the aggregation pipeline and the alias lookup are stubbed.
 */

/* eslint-disable @typescript-eslint/no-var-requires */
const { expect } = require('chai')
const sinon = require('sinon')

const ProductModel = require('../src/models/product').default
const ProductAliasModel = require('../src/models/productAlias').default
const { searchProductsService } = require('../src/services/catalog')
const { batchSearch } = require('../src/controllers/catalog')
const { fuzzyScore, similarity } = require('../src/utils/fuzzy')

const PROVIDER_ID = '507f1f77bcf86cd799439011'
const OTHER_PROVIDER_ID = '507f1f77bcf86cd799439022'

function productRow (overrides: Record<string, any> = {}): any {
  return {
    productId: '507f1f77bcf86cd799439033',
    name: 'COCA COLA 500ML',
    barcode: null,
    providerId: PROVIDER_ID,
    providerName: 'Proveedor',
    brandId: '507f1f77bcf86cd799439044',
    brandName: 'Marca',
    categoryId: '507f1f77bcf86cd799439055',
    categoryName: 'Bebidas',
    ...overrides
  }
}

function makeRes (): any {
  const res: any = {}
  res.status = sinon.stub().returns(res)
  res.json = sinon.stub().returns(res)
  return res
}

describe('PS-T13 — fuzzy scoring', () => {
  it('stays inside the 0..1 range', () => {
    const cases = [
      ['cocla cola', 'COCA COLA 500ML'],
      ['zzzz', 'COCA COLA 500ML'],
      ['', 'COCA COLA 500ML'],
      ['COCA COLA 500ML', 'COCA COLA 500ML']
    ]

    for (const [query, candidate] of cases) {
      const score = fuzzyScore(query, candidate)
      expect(score).to.be.at.least(0)
      expect(score).to.be.at.most(1)
    }
  })

  it('is symmetric for the edit distance similarity', () => {
    expect(similarity('COCA', 'COCLA')).to.equal(similarity('COCLA', 'COCA'))
  })

  it('ranks the real product above an unrelated one', () => {
    const expected = fuzzyScore('cocla cola', 'COCA COLA 500ML')
    const unrelated = fuzzyScore('cocla cola', 'AGUA MINERAL 500ML')

    expect(expected).to.be.greaterThan(unrelated)
    expect(expected).to.be.at.least(0.55)
  })
})

describe('PS-T13 — search priority', () => {
  afterEach(() => sinon.restore())

  it('returns the barcode match immediately', async () => {
    sinon.stub(ProductModel, 'aggregate').resolves([
      productRow({ barcode: '7790895000011' })
    ])
    const aliasFind = sinon.stub(ProductAliasModel, 'findOne')

    const results = await searchProductsService({ barcode: '7790895000011' })

    expect(results).to.have.length(1)
    expect(results[0].matchSource).to.equal('BARCODE')
    expect(results[0].matchScore).to.equal(1)
    expect(aliasFind.called).to.equal(false)
  })

  it('prefers an exact alias over a description match', async () => {
    const aggregate = sinon.stub(ProductModel, 'aggregate')
    aggregate.onCall(0).resolves([productRow({ name: 'Producto por alias' })])
    aggregate.onCall(1).resolves([productRow({ name: 'Producto por descripción' })])
    aggregate.onCall(2).resolves([])
    aggregate.onCall(3).resolves([])

    sinon.stub(ProductAliasModel, 'findOne').returns({
      lean: () =>
        Promise.resolve({
          _id: 'alias-1',
          productId: '507f1f77bcf86cd799439033',
          confidence: 0.95
        })
    } as any)

    const results = await searchProductsService({ q: 'coca cola', providerId: PROVIDER_ID })

    expect(results[0].matchSource).to.equal('ALIAS')
  })

  it('falls back to the global catalog when the provider has too few candidates', async () => {
    const aggregate = sinon.stub(ProductModel, 'aggregate')
    aggregate.onCall(0).resolves([]) // descripción exacta: sin coincidencias
    aggregate.onCall(1).resolves([]) // difusa del proveedor
    aggregate.onCall(2).resolves([productRow({ providerId: OTHER_PROVIDER_ID, name: 'COCA COLA 2.25L' })])

    sinon.stub(ProductAliasModel, 'findOne').returns({
      lean: () => Promise.resolve(null)
    } as any)

    const results = await searchProductsService({ q: 'coca cola', providerId: PROVIDER_ID })

    const globalResults = results.filter((result: any) => result.matchScope === 'GLOBAL')
    expect(globalResults).to.have.length(1)
    expect(globalResults[0].providerId).to.equal(OTHER_PROVIDER_ID)
  })
})

describe('PS-T13 — batch search input validation', () => {
  afterEach(() => sinon.restore())

  it('rejects a non array queries field', async () => {
    const res = makeRes()

    await batchSearch({ body: { queries: 'no-es-array' } } as any, res)

    expect(res.status.calledWith(400)).to.equal(true)
  })

  it('rejects an empty queries array', async () => {
    const res = makeRes()

    await batchSearch({ body: { queries: [] } } as any, res)

    expect(res.status.calledWith(400)).to.equal(true)
  })

  it('rejects more than 50 queries', async () => {
    const res = makeRes()
    const queries = Array.from({ length: 51 }, (_, index) => ({ queryId: `q${index}`, q: 'coca' }))

    await batchSearch({ body: { queries } } as any, res)

    expect(res.status.calledWith(400)).to.equal(true)
    expect(res.json.firstCall.args[0].error).to.equal('TOO_MANY_QUERIES')
  })

  it('rejects a query without queryId', async () => {
    const res = makeRes()

    await batchSearch({ body: { queries: [{ q: 'coca' }] } } as any, res)

    expect(res.json.firstCall.args[0].error).to.equal('MISSING_QUERY_ID')
  })

  it('rejects a query shorter than two characters', async () => {
    const res = makeRes()

    await batchSearch({ body: { queries: [{ queryId: 'q1', q: 'c' }] } } as any, res)

    expect(res.json.firstCall.args[0].error).to.equal('QUERY_TOO_SHORT')
  })

  it('rejects an invalid scope', async () => {
    const res = makeRes()

    await batchSearch(
      { body: { queries: [{ queryId: 'q1', q: 'coca' }], scope: 'INVENTADO' } } as any,
      res
    )

    expect(res.json.firstCall.args[0].error).to.equal('INVALID_SCOPE')
  })
})
