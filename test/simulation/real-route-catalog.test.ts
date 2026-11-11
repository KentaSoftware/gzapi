import { expect } from 'chai'
import express from 'express'
import request from 'supertest'
import sinon from 'sinon'
import { Types } from 'mongoose'
import ProductModel from '../../src/models/product'
import { createSimulationRouter } from '../../src/routes/simulation'
import { listRouteCatalog } from '../../src/services/routeSimulation'

describe('simulation real route catalog', () => {
  afterEach(() => { sinon.restore() })

  it('reads only minimal real fields and excludes invalid records without fabricating prices', async () => {
    const id = new Types.ObjectId('000000000000000000000005')
    const lean = sinon.stub().resolves([
      { _id: id, descripcion: 'Actual', stock: 3, precioUnitario: 12.5, secret: 'hidden' },
      { _id: new Types.ObjectId(), descripcion: 'Missing', stock: 2 },
      { _id: new Types.ObjectId(), descripcion: 'Invalid', stock: 2, precioUnitario: -1 },
      { _id: new Types.ObjectId(), descripcion: 'NaN', stock: 2, precioUnitario: NaN },
      { _id: new Types.ObjectId(), descripcion: 'Bad stock', stock: null, precioUnitario: 1 }
    ])
    const limit = sinon.stub().returns({ lean })
    const sort = sinon.stub().returns({ limit })
    const query = { sort }
    const find = sinon.stub(ProductModel, 'find').returns(query as never)
    const result = await listRouteCatalog()
    expect(find.firstCall.args[1]).to.deep.equal({ _id: 1, descripcion: 1, stock: 1, precioUnitario: 1 })
    expect(sort.firstCall.args[0]).to.deep.equal({ _id: -1 })
    expect(limit.firstCall.args[0]).to.equal(101)
    expect(result).to.deep.equal({ items: [{ id: String(id), name: 'Actual', stock: 3, precioUnitario: 12.5 }], excludedCount: 4, hasMore: false, nextCursor: null })
  })

  it('paginates by scanned records even when records are excluded', async () => {
    const records = Array.from({ length: 101 }, (_, i) => ({ _id: new Types.ObjectId((101 - i).toString(16).padStart(24, '0')), descripcion: 'Product', stock: 1 }))
    const lean = sinon.stub().resolves(records)
    const query = { sort: () => ({ limit: () => ({ lean }) }) }
    const find = sinon.stub(ProductModel, 'find').returns(query as never)
    const cursor = '000000000000000000000099'
    const result = await listRouteCatalog(cursor)
    expect(find.firstCall.args[0]).to.deep.equal({ _id: { $lt: new Types.ObjectId(cursor) } })
    expect(result).to.deep.equal({ items: [], excludedCount: 100, hasMore: true, nextCursor: String(records[99]._id) })
  })

  it('requires authentication, current-role grant and production flag before reading', async () => {
    const app = express()
    let reads = 0
    app.locals.simulationRouteDependencies = {
      checkJwt: (req: express.Request, res: express.Response, next: express.NextFunction) => req.headers.authorization === undefined ? res.sendStatus(401) : next(),
      checkPermission: (action: string, options: { currentRole?: boolean }) => (req: express.Request, res: express.Response, next: express.NextFunction) => {
        expect(action).to.equal('simulation:read')
        expect(options.currentRole).to.equal(true)
        if (req.headers['x-grant'] !== 'yes') { res.sendStatus(403); return }
        next()
      },
      getConfig: () => ({ enabled: app.locals.enabled }),
      service: {},
      routeCatalog: async () => { reads++; return { items: [], excludedCount: 0, hasMore: false, nextCursor: null } }
    }
    app.use('/simulation', createSimulationRouter())
    expect((await request(app).get('/simulation/route-catalog')).status).to.equal(401)
    expect((await request(app).get('/simulation/route-catalog').set('Authorization', 'token')).status).to.equal(403)
    expect((await request(app).get('/simulation/route-catalog').set('Authorization', 'token').set('x-grant', 'yes')).status).to.equal(503)
    app.locals.enabled = true
    expect((await request(app).get('/simulation/route-catalog?cursor=bad').set('Authorization', 'token').set('x-grant', 'yes')).status).to.equal(400)
    const response = await request(app).get('/simulation/route-catalog').set('Authorization', 'token').set('x-grant', 'yes')
    expect(response.status).to.equal(200)
    expect(response.body).to.deep.equal({ items: [], excludedCount: 0, hasMore: false, nextCursor: null })
    expect(reads).to.equal(1)
  })
})
