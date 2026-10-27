/**
 * PS-T23 — confirmPurchaseDoc must answer business rejections with a client
 * status instead of 500.
 */

/* eslint-disable @typescript-eslint/no-var-requires */
const { expect } = require('chai')
const sinon = require('sinon')

const purchaseDocService = require('../src/services/purchaseDoc')
const { confirmPurchaseDoc } = require('../src/controllers/purchaseDoc')

const DRAFT_ID = '507f1f77bcf86cd799439011'
const USER_ID = '507f1f77bcf86cd799439022'

function makeRes (): any {
  const res: any = {}
  res.status = sinon.stub().returns(res)
  res.json = sinon.stub().returns(res)
  res.send = sinon.stub().returns(res)
  return res
}

function makeReq (body: any = {}): any {
  return {
    params: { draftId: DRAFT_ID },
    user: { id: USER_ID },
    body: { items: [{ lineId: 'L1', chosenProductId: '507f1f77bcf86cd799439033' }], ...body }
  }
}

function stubReadyDraft (): void {
  sinon.stub(purchaseDocService, 'getDraftById').resolves({
    _id: DRAFT_ID,
    userId: USER_ID,
    status: 'READY'
  })
}

describe('PS-T23 — confirmPurchaseDoc error mapping', () => {
  afterEach(() => sinon.restore())

  it('answers 409 when the user cancels because of a duplicate', async () => {
    stubReadyDraft()
    sinon
      .stub(purchaseDocService, 'confirmDraft')
      .rejects(new Error('Confirmación cancelada por duplicado'))

    const res = makeRes()
    await confirmPurchaseDoc(makeReq({ duplicateDecision: { decision: 'CANCEL' } }), res)

    expect(res.status.calledWith(409)).to.equal(true)
    expect(res.json.firstCall.args[0].error).to.match(/cancelada por duplicado/i)
  })

  it('answers 409 when the draft is no longer ready', async () => {
    stubReadyDraft()
    sinon
      .stub(purchaseDocService, 'confirmDraft')
      .rejects(new Error('Draft no está listo para confirmar. Estado actual: PROCESSING'))

    const res = makeRes()
    await confirmPurchaseDoc(makeReq(), res)

    expect(res.status.calledWith(409)).to.equal(true)
  })

  it('answers 400 when the header is incomplete', async () => {
    stubReadyDraft()
    sinon
      .stub(purchaseDocService, 'confirmDraft')
      .rejects(new Error('Header incompleto: se requiere providerId y total'))

    const res = makeRes()
    await confirmPurchaseDoc(makeReq(), res)

    expect(res.status.calledWith(400)).to.equal(true)
  })

  it('keeps 500 for unexpected failures', async () => {
    stubReadyDraft()
    sinon.stub(purchaseDocService, 'confirmDraft').rejects(new Error('ECONNRESET'))

    const res = makeRes()
    await confirmPurchaseDoc(makeReq(), res)

    expect(res.status.calledWith(500)).to.equal(true)
  })

  it('returns the created buy on the happy path', async () => {
    stubReadyDraft()
    sinon.stub(purchaseDocService, 'confirmDraft').resolves({
      buyId: '507f1f77bcf86cd799439044',
      draftId: DRAFT_ID
    })

    const res = makeRes()
    await confirmPurchaseDoc(makeReq(), res)

    expect(res.status.calledWith(200)).to.equal(true)
    expect(res.json.firstCall.args[0].data.buyId).to.equal('507f1f77bcf86cd799439044')
  })
})
