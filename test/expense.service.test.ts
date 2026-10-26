/**
 * PS-T12 — Expense service unit tests.
 * Strategy: sinon stubs the Mongoose model methods and the audit log, so every
 * case runs without a database. No HTTP, no Mongo.
 */

/* eslint-disable @typescript-eslint/no-var-requires */
const { expect } = require('chai')
const sinon = require('sinon')

const ExpenseModel = require('../src/models/expense').default
const logModule = require('../src/services/log')
const service = require('../src/services/expense').default

const VALID_ID = '507f1f77bcf86cd799439011'
const USER_ID = '507f1f77bcf86cd799439012'

function makeExpense (overrides: Record<string, any> = {}): any {
  return {
    _id: VALID_ID,
    amountCents: 1000,
    isDeleted: false,
    createdAt: new Date('2026-01-15T10:00:00.000Z'),
    date: new Date('2026-01-15T10:00:00.000Z'),
    toObject: () => ({ amountCents: 1000 }),
    save: sinon.stub().resolves(),
    populate: sinon.stub().resolves(),
    ...overrides
  }
}

describe('PS-T12 — ExpenseService.getExpensesTotal', () => {
  afterEach(() => sinon.restore())

  it('returns zero when the period has no expenses', async () => {
    sinon.stub(ExpenseModel, 'aggregate').resolves([])

    const result = await service.getExpensesTotal({ from: '2026-01-01', to: '2026-01-31' })

    expect(result.totalCents).to.equal(0)
    expect(result.totalAmount).to.equal(0)
    expect(result.currency).to.equal('ARS')
  })

  it('converts cents to plain decimals', async () => {
    sinon.stub(ExpenseModel, 'aggregate').resolves([{ _id: null, totalCents: 12345 }])

    const result = await service.getExpensesTotal({ from: '2026-01-01', to: '2026-01-31' })

    expect(result.totalAmount).to.equal(123.45)
  })

  it('always excludes soft-deleted expenses from the pipeline', async () => {
    const aggregate = sinon.stub(ExpenseModel, 'aggregate').resolves([])

    await service.getExpensesTotal({ from: '2026-01-01', to: '2026-01-31' })

    const pipeline = aggregate.firstCall.args[0]
    expect(pipeline[0].$match.isDeleted).to.equal(false)
  })

  it('requires from and to', async () => {
    let error: any = null
    try {
      await service.getExpensesTotal({ from: '2026-01-01' })
    } catch (e) {
      error = e
    }

    expect(error).to.be.instanceOf(Error)
    expect(error.message).to.match(/requeridos/i)
  })

  it('rejects an inverted period', async () => {
    let error: any = null
    try {
      await service.getExpensesTotal({ from: '2026-02-01', to: '2026-01-01' })
    } catch (e) {
      error = e
    }

    expect(error).to.be.instanceOf(Error)
    expect(error.message).to.match(/no puede ser posterior/i)
  })

  it('rejects an unknown expense type', async () => {
    let error: any = null
    try {
      await service.getExpensesTotal({ from: '2026-01-01', to: '2026-01-31', type: 'inventado' })
    } catch (e) {
      error = e
    }

    expect(error).to.be.instanceOf(Error)
  })
})

describe('PS-T12 — ExpenseService.list validations', () => {
  afterEach(() => sinon.restore())

  it('rejects a limit above 100', async () => {
    let error: any = null
    try {
      await service.list({ limit: 500 })
    } catch (e) {
      error = e
    }

    expect(error).to.be.instanceOf(Error)
    expect(error.message).to.match(/100/i)
  })

  it('rejects an invalid expense type', async () => {
    let error: any = null
    try {
      await service.list({ type: 'inventado' })
    } catch (e) {
      error = e
    }

    expect(error).to.be.instanceOf(Error)
    expect(error.message).to.match(/inválido/i)
  })

  it('rejects an invalid preset', async () => {
    let error: any = null
    try {
      await service.list({ preset: 'decada' })
    } catch (e) {
      error = e
    }

    expect(error).to.be.instanceOf(Error)
    expect(error.message).to.match(/preset/i)
  })
})

describe('PS-T12 — ExpenseService.create', () => {
  afterEach(() => sinon.restore())

  it('stores the amount in cents', async () => {
    const create = sinon.stub(ExpenseModel, 'create').resolves(makeExpense({ amountCents: 25050 }))
    sinon.stub(logModule, 'insertLog').resolves()

    await service.create(
      {
        date: '2026-01-15',
        amount: 250.5,
        category: 'servicios',
        type: 'operativo',
        paymentMethod: 'efectivo'
      },
      USER_ID
    )

    expect(create.firstCall.args[0].amountCents).to.equal(25050)
  })

  it('rejects a future date', async () => {
    let error: any = null
    try {
      await service.create(
        {
          date: '2099-01-15',
          amount: 10,
          category: 'servicios',
          type: 'operativo',
          paymentMethod: 'efectivo'
        },
        USER_ID
      )
    } catch (e) {
      error = e
    }

    expect(error).to.be.instanceOf(Error)
    expect(error.message).to.match(/futura/i)
  })

  it('rejects a non positive amount', async () => {
    let error: any = null
    try {
      await service.create(
        {
          date: '2026-01-15',
          amount: 0,
          category: 'servicios',
          type: 'operativo',
          paymentMethod: 'efectivo'
        },
        USER_ID
      )
    } catch (e) {
      error = e
    }

    expect(error).to.be.instanceOf(Error)
    expect(error.message).to.match(/mayor a 0/i)
  })
})

describe('PS-T12 — ExpenseService.update', () => {
  afterEach(() => sinon.restore())

  it('rejects an invalid ObjectId', async () => {
    let error: any = null
    try {
      await service.update('no-es-un-id', {}, USER_ID)
    } catch (e) {
      error = e
    }

    expect(error.status).to.equal(400)
  })

  it('returns 404 when the expense does not exist', async () => {
    sinon.stub(ExpenseModel, 'findById').resolves(null)

    let error: any = null
    try {
      await service.update(VALID_ID, { description: 'x' }, USER_ID)
    } catch (e) {
      error = e
    }

    expect(error.status).to.equal(404)
  })

  it('refuses to edit a soft-deleted expense', async () => {
    sinon.stub(ExpenseModel, 'findById').resolves(makeExpense({ isDeleted: true }))

    let error: any = null
    try {
      await service.update(VALID_ID, { description: 'x' }, USER_ID)
    } catch (e) {
      error = e
    }

    expect(error.status).to.equal(410)
  })
})

describe('PS-T12 — ExpenseService.softDelete', () => {
  afterEach(() => sinon.restore())

  it('marks the expense as deleted instead of removing the document', async () => {
    const document = makeExpense()
    sinon.stub(ExpenseModel, 'findById').resolves(document)
    const deleteOne = sinon.stub(ExpenseModel, 'deleteOne').resolves(null)
    const findByIdAndDelete = sinon.stub(ExpenseModel, 'findByIdAndDelete').resolves(null)
    sinon.stub(logModule, 'insertLog').resolves()

    const result = await service.softDelete(VALID_ID, USER_ID)

    expect(document.isDeleted).to.equal(true)
    expect(document.save.calledOnce).to.equal(true)
    expect(deleteOne.called).to.equal(false)
    expect(findByIdAndDelete.called).to.equal(false)
    expect(result).to.equal(document)
  })

  it('is idempotent for an already deleted expense', async () => {
    const document = makeExpense({ isDeleted: true })
    sinon.stub(ExpenseModel, 'findById').resolves(document)

    const result = await service.softDelete(VALID_ID, USER_ID)

    expect(document.save.called).to.equal(false)
    expect(result).to.equal(document)
  })

  it('returns 404 when the expense does not exist', async () => {
    sinon.stub(ExpenseModel, 'findById').resolves(null)

    let error: any = null
    try {
      await service.softDelete(VALID_ID, USER_ID)
    } catch (e) {
      error = e
    }

    expect(error.status).to.equal(404)
  })

  it('rejects an invalid ObjectId', async () => {
    let error: any = null
    try {
      await service.softDelete('no-es-un-id', USER_ID)
    } catch (e) {
      error = e
    }

    expect(error.status).to.equal(400)
  })
})
