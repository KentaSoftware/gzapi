import { expect } from 'chai'
import mongoose from 'mongoose'
import request from 'supertest'
import sinon from 'sinon'

import CommercialFactModel from '../../src/models/commercialFact'
import {
  PHASE0_CONTRACT_V1,
  resetPhase0ContractV1,
  seedPhase0ContractV1
} from '../fixtures/phase-0-contract-v1'

const TEST_DB_URI = 'mongodb://localhost:27017/gzapi_phase0_scenario_coverage_test'

describe('Phase 0 — scenario coverage contract', () => {
  let app: Awaited<ReturnType<typeof import('../../src/app').createApp>>

  before(async () => {
    process.env.PHASE_0_CONTRACTS_ENABLED = 'true'
    await mongoose.connect(TEST_DB_URI)
    const { createApp } = await import('../../src/app')
    app = await createApp()
  })

  after(async () => {
    await resetPhase0ContractV1()
    const dbName = mongoose.connection.db?.databaseName
    if (dbName?.endsWith('_test') === true) await mongoose.connection.dropDatabase()
    await mongoose.disconnect()
    delete process.env.PHASE_0_CONTRACTS_ENABLED
  })

  beforeEach(async () => {
    await seedPhase0ContractV1()
  })

  it('S-23a: an authorization failure log excludes the JWT, amount, and address while retaining correlation', async () => {
    const { ids, businessDate } = PHASE0_CONTRACT_V1
    const logger = sinon.stub(console, 'log')

    try {
      const response = await request(app)
        .post(`/commercialFact/sales/${ids.sale}/payment?token=private-token`)
        .set('Authorization', 'Bearer private-token')
        .set('x-correlation-id', 'scenario-coverage-correlation')
        .send({
          businessDate,
          idempotencyKey: 'authorization-log-denial',
          amount: 9876,
          address: 'Private Test Address'
        })

      expect(response.status).to.equal(401)
      expect(response.body.code).to.equal('AUTHENTICATION_INVALID')
      expect(await CommercialFactModel.countDocuments({})).to.equal(0)

      const output = logger.getCalls().map((call) => call.args.join(' ')).join('\n')
      expect(output).to.contain('scenario-coverage-correlation')
      expect(output).to.not.contain('private-token')
      expect(output).to.not.contain('9876')
      expect(output).to.not.contain('Private Test Address')
    } finally {
      logger.restore()
    }
  })
})
