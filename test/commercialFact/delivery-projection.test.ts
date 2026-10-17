import { expect } from 'chai'
import mongoose from 'mongoose'

import CommercialFactModel from '../../src/models/commercialFact'
import SaleModel from '../../src/models/sale'
import { CommercialFactService } from '../../src/services/commercialFact'

const TEST_DB_URI = 'mongodb://localhost:27017/gzapi_delivery_projection_test'

describe('Commercial delivery projection', () => {
  before(async () => { await mongoose.connect(TEST_DB_URI) })
  after(async () => {
    const dbName = mongoose.connection.db?.databaseName
    if (dbName?.endsWith('_test') === true) await mongoose.connection.dropDatabase()
    await mongoose.disconnect()
  })
  beforeEach(async () => { await Promise.all([CommercialFactModel.deleteMany({}), SaleModel.deleteMany({})]) })

  it('TC-024: SALE_DELIVERY writes Sale.delivery through the delivery port', async () => {
    const sale = await SaleModel.create({ estado: 'CREATED', total: 10, user: new mongoose.Types.ObjectId(), cliente: 'A' })
    await new CommercialFactService().recordSaleDelivery({ aggregateId: String(sale._id), businessDate: new Date('2026-10-12T12:00:00.000Z'), idempotencyKey: 'delivery-projection-1' }, { actorId: 'operator' })
    const projected = await SaleModel.findById(sale._id).lean()
    expect(projected?.delivery?.status).to.equal('DELIVERED')
    expect(projected?.delivery?.deliveredAt).to.deep.equal(new Date('2026-10-12T12:00:00.000Z'))
  })
})
