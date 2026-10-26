/**
 * PS-T13 â€” Duplicate detection: criteria, scoring, dedupe and decision persistence.
 * No database: BuyModel queries and the check collection are stubbed.
 */

/* eslint-disable @typescript-eslint/no-var-requires */
const { expect } = require('chai')
const sinon = require('sinon')

const BuyModel = require('../src/models/buy').default
const PurchaseDocDuplicateCheckModel = require('../src/models/purchaseDocDuplicateCheck').default
const logModule = require('../src/services/log')
const { checkForDuplicates, recordDecision } = require('../src/services/duplicateCheck')

const PROVIDER_ID = '507f1f77bcf86cd799439011'
const BUY_ID = '507f1f77bcf86cd799439021'
const CHECK_ID = '507f1f77bcf86cd799439031'

/** Simulates the `.select().limit().lean()` chain used by every query. */
function chain (rows: any[]): any {
  return {
    select: () => ({
      limit: () => ({
        lean: () => Promise.resolve(rows)
      })
    })
  }
}

function buyRow (overrides: Record<string, any> = {}): any {
  return {
    _id: BUY_ID,
    fecha: new Date('2026-01-15T10:00:00.000Z'),
    total: 1000,
    docNumber: 'A-0001',
    fingerprint: 'fp-1',
    ...overrides
  }
}

function stubBase (): void {
  sinon.stub(PurchaseDocDuplicateCheckModel, 'create').resolves({ _id: CHECK_ID })
  sinon.stub(logModule, 'insertLog').resolves()
}

describe('PS-T13 â€” checkForDuplicates', () => {
  afterEach(() => sinon.restore())

  it('does not flag anything when there are no candidates', async () => {
    stubBase()
    sinon.stub(BuyModel, 'find').returns(chain([]) as any)

    const result = await checkForDuplicates({
      providerId: PROVIDER_ID,
      date: '2026-01-15',
      total: 1000
    } as any)

    expect(result.isPossibleDuplicate).to.equal(false)
    expect(result.recommendation).to.equal('NO_PROMPT')
    expect(result.candidates).to.have.length(0)
  })

  it('flags a duplicate by exact document number', async () => {
    stubBase()
    const find = sinon.stub(BuyModel, 'find')
    find.onCall(0).returns(chain([buyRow()]) as any) // docNumber
    find.onCall(1).returns(chain([]) as any) // provider + date + total

    const result = await checkForDuplicates({
      providerId: PROVIDER_ID,
      docNumber: 'A-0001',
      date: '2026-01-15',
      total: 1000
    } as any)

    expect(result.isPossibleDuplicate).to.equal(true)
    expect(result.criteriaTriggered).to.include('DOC_NUMBER')
    expect(result.candidates[0].score).to.equal(0.95)
  })

  it('flags a duplicate by exact fingerprint', async () => {
    stubBase()
    const find = sinon.stub(BuyModel, 'find')
    find.onCall(0).returns(chain([buyRow()]) as any) // fingerprint
    find.onCall(1).returns(chain([]) as any) // provider + date + total

    const result = await checkForDuplicates({
      providerId: PROVIDER_ID,
      fingerprint: 'fp-1',
      date: '2026-01-15',
      total: 1000
    } as any)

    expect(result.isPossibleDuplicate).to.equal(true)
    expect(result.criteriaTriggered).to.include('FINGERPRINT')
  })

  it('does not prompt when only provider + date + total match', async () => {
    stubBase()
    sinon.stub(BuyModel, 'find').returns(chain([buyRow()]) as any)

    const result = await checkForDuplicates({
      providerId: PROVIDER_ID,
      date: '2026-01-15',
      total: 1000
    } as any)

    // 0.75 base score is below the 0.80 prompt threshold on purpose
    expect(result.criteriaTriggered).to.include('PROVIDER_DATE_TOTAL')
    expect(result.isPossibleDuplicate).to.equal(false)
  })

  it('boosts the score when two criteria point at the same purchase', async () => {
    stubBase()
    const find = sinon.stub(BuyModel, 'find')
    find.onCall(0).returns(chain([buyRow()]) as any) // docNumber
    find.onCall(1).returns(chain([buyRow()]) as any) // provider + date + total

    const result = await checkForDuplicates({
      providerId: PROVIDER_ID,
      docNumber: 'A-0001',
      date: '2026-01-15',
      total: 1000
    } as any)

    expect(result.candidates).to.have.length(1)
    // 0.95 (docNumber) + 0.1 boost, clamped to 1.0
    expect(result.candidates[0].score).to.equal(1)
    expect(result.isPossibleDuplicate).to.equal(true)
  })

  it('persists the check as NOT_PROMPTED', async () => {
    stubBase()
    const create = PurchaseDocDuplicateCheckModel.create as any
    sinon.stub(BuyModel, 'find').returns(chain([]) as any)

    await checkForDuplicates({
      providerId: PROVIDER_ID,
      date: '2026-01-15',
      total: 1000
    } as any)

    expect(create.firstCall.args[0].decision).to.equal('NOT_PROMPTED')
  })
})

describe('PS-T13 â€” recordDecision', () => {
  afterEach(() => sinon.restore())

  it('throws CHECK_NOT_FOUND when the check does not exist', async () => {
    sinon.stub(PurchaseDocDuplicateCheckModel, 'findByIdAndUpdate').resolves(null)

    let error: any = null
    try {
      await recordDecision(CHECK_ID, 'PROCEED' as any, PROVIDER_ID)
    } catch (e) {
      error = e
    }

    expect(error).to.be.instanceOf(Error)
    expect(error.message).to.equal('CHECK_NOT_FOUND')
  })

  it('stores the decision and writes an audit entry', async () => {
    const update = sinon.stub(PurchaseDocDuplicateCheckModel, 'findByIdAndUpdate').resolves({
      _id: CHECK_ID,
      candidates: [],
      draftId: null
    })
    const insertLog = sinon.stub(logModule, 'insertLog').resolves()

    await recordDecision(CHECK_ID, 'PROCEED' as any, PROVIDER_ID)

    expect(update.calledOnce).to.equal(true)
    expect(insertLog.calledOnce).to.equal(true)
  })
})
