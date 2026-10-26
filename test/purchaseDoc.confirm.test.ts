/**
 * PS-T13 — confirmDraft: guards and purchase creation.
 * No database: the draft, the buy creation and ItemBuy insertion are stubbed.
 */

/* eslint-disable @typescript-eslint/no-var-requires */
const { expect } = require('chai')
const sinon = require('sinon')

const DraftPurchaseDocModel = require('../src/models/draftPurchaseDoc').default
const BuyModel = require('../src/models/buy').default
const ProductModel = require('../src/models/product').default
const itemBuyModule = require('../src/services/itemBuy')
const { confirmDraft } = require('../src/services/purchaseDoc')

const DRAFT_ID = '507f1f77bcf86cd799439011'
const BUY_ID = '507f1f77bcf86cd799439022'
const USER_ID = '507f1f77bcf86cd799439033'
const PROVIDER_ID = '507f1f77bcf86cd799439044'
const PRODUCT_A = '507f1f77bcf86cd799439055'
const PRODUCT_B = '507f1f77bcf86cd799439066'

function makeDraft (overrides: Record<string, any> = {}): any {
  return {
    _id: DRAFT_ID,
    status: 'READY',
    analysisResult: {
      header: {
        providerId: PROVIDER_ID,
        documentDate: '2026-01-15',
        documentNumber: 'A-0001',
        total: 700
      },
      items: [
        {
          itemId: 'line-1',
          quantity: 2,
          unitPrice: 100,
          subtotal: 200,
          catalogMatch: { productId: PRODUCT_A }
        },
        {
          itemId: 'line-2',
          quantity: 1,
          unitPrice: 500,
          subtotal: 500,
          catalogMatch: { productId: PRODUCT_B }
        }
      ]
    },
    possibleDuplicate: { requiresDecision: false },
    ...overrides
  }
}

function stubDraft (draft: any): void {
  sinon.stub(DraftPurchaseDocModel, 'findById').returns({
    lean: () => Promise.resolve(draft)
  } as any)
  sinon.stub(DraftPurchaseDocModel, 'findByIdAndUpdate').returns({
    lean: () => Promise.resolve(draft)
  } as any)
  sinon.stub(BuyModel, 'create').resolves({ _id: BUY_ID })
  sinon.stub(itemBuyModule, 'insertItemBuy').resolves({})
  sinon.stub(ProductModel, 'findByIdAndUpdate').resolves(null)
}

describe('PS-T13 — confirmDraft guards', () => {
  afterEach(() => sinon.restore())

  it('rejects a draft that is not READY', async () => {
    stubDraft(makeDraft({ status: 'PROCESSING' }))

    let error: any = null
    try {
      await confirmDraft(DRAFT_ID as any, USER_ID as any)
    } catch (e) {
      error = e
    }

    expect(error).to.be.instanceOf(Error)
    expect(error.message).to.match(/no está listo/i)
  })

  it('rejects a draft without analysis result', async () => {
    stubDraft(makeDraft({ analysisResult: null }))

    let error: any = null
    try {
      await confirmDraft(DRAFT_ID as any, USER_ID as any)
    } catch (e) {
      error = e
    }

    expect(error).to.be.instanceOf(Error)
    expect(error.message).to.match(/no tiene resultado/i)
  })

  it('requires an explicit decision when a duplicate was detected', async () => {
    stubDraft(makeDraft({ possibleDuplicate: { requiresDecision: true } }))

    let error: any = null
    try {
      await confirmDraft(DRAFT_ID as any, USER_ID as any)
    } catch (e) {
      error = e
    }

    expect(error).to.be.instanceOf(Error)
    expect(error.message).to.match(/decisión sobre duplicados/i)
  })

  it('rejects a CANCEL duplicate decision', async () => {
    stubDraft(makeDraft({ possibleDuplicate: { requiresDecision: true } }))

    let error: any = null
    try {
      await confirmDraft(DRAFT_ID as any, USER_ID as any, undefined, undefined, {
        decision: 'CANCEL'
      } as any)
    } catch (e) {
      error = e
    }

    expect(error).to.be.instanceOf(Error)
    expect(error.message).to.match(/cancelada por duplicado/i)
  })

  it('rejects an item without an assigned product', async () => {
    stubDraft(makeDraft())

    let error: any = null
    try {
      await confirmDraft(DRAFT_ID as any, USER_ID as any, undefined, [
        { lineId: 'line-1', quantity: 1, unitPrice: 10, subtotal: 10 }
      ] as any)
    } catch (e) {
      error = e
    }

    expect(error).to.be.instanceOf(Error)
    expect(error.message).to.match(/sin producto asignado/i)
  })
})

describe('PS-T13 — confirmDraft purchase creation', () => {
  afterEach(() => sinon.restore())

  it('creates the purchase with the analysis header and its items', async () => {
    stubDraft(makeDraft())

    const result = await confirmDraft(DRAFT_ID as any, USER_ID as any)

    const createBuy = BuyModel.create as any
    expect(createBuy.firstCall.args[0].total).to.equal(700)
    expect(createBuy.firstCall.args[0].proveedor).to.equal(PROVIDER_ID)

    const insertItem = itemBuyModule.insertItemBuy as any
    expect(insertItem.callCount).to.equal(2)
    expect(result.buyId).to.equal(BUY_ID)
  })

  it('uses the edited header over the analysis values', async () => {
    stubDraft(makeDraft())

    await confirmDraft(DRAFT_ID as any, USER_ID as any, {
      total: 999,
      documentNumber: 'A-9999'
    } as any)

    const createBuy = BuyModel.create as any
    expect(createBuy.firstCall.args[0].total).to.equal(999)
    expect(createBuy.firstCall.args[0].docNumber).to.equal('A-9999')
  })

  it('sends the edited quantity and price to ItemBuy', async () => {
    stubDraft(makeDraft())

    await confirmDraft(
      DRAFT_ID as any,
      USER_ID as any,
      undefined,
      [
        { lineId: 'line-1', chosenProductId: PRODUCT_A, quantity: 5, unitPrice: 120, subtotal: 600 },
        { lineId: 'line-2', chosenProductId: PRODUCT_B, quantity: 1, unitPrice: 500, subtotal: 500 }
      ] as any
    )

    const insertItem = itemBuyModule.insertItemBuy as any
    const firstItem = insertItem.firstCall.args[0]
    expect(firstItem.cantidad).to.equal(5)
    expect(firstItem.precio).to.equal(120)
    expect(firstItem.total).to.equal(600)
  })
})
