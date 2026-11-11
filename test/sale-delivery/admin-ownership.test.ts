import express from 'express'
import { expect } from 'chai'
import sinon from 'sinon'
import request from 'supertest'
import * as sales from '../../src/services/sale'
import { CommercialFactService } from '../../src/services/commercialFact'
import { recordSaleDelivery } from '../../src/controllers/commercialFact'

describe('sale ownership with current administrator role', () => {
  afterEach(() => { sinon.restore() })

  it('allows the current admin to act on another sale with the real actor', async () => {
    const actor = '507f1f77bcf86cd799439011'
    sinon.stub(sales, 'getSale').resolves([{ user: '507f1f77bcf86cd799439012' }] as never)
    const result: unknown = { replayed: false }
    const delivery = sinon.stub(CommercialFactService.prototype, 'recordSaleDelivery').resolves(result as never)
    const app = express()
    app.use(express.json())
    app.post('/:saleId', (req, res) => {
      Object.assign(req, { user: { id: actor, role: { name: 'Preventista' } } })
      res.locals.authorizationRole = 'admin'
      void recordSaleDelivery(req, res)
    })
    const response = await request(app).post('/507f1f77bcf86cd799439013').send({ businessDate: '2026-01-01', idempotencyKey: 'x' })
    expect(response.status).to.equal(201)
    expect(delivery.firstCall.args[1].actorId).to.equal(actor)
  })
})
