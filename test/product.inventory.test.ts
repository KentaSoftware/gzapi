import { expect } from 'chai'
import { Types } from 'mongoose'

import { BASELINE_STATUS, EXPIRY_TRACKING } from '../src/interfaces/stock.interface'
import ProductModel from '../src/models/product'
import { sanitizeProductUpdate } from '../src/services/product'

const baseProduct = {
  descripcion: 'Test product',
  stock: 12,
  precioUnitario: 10,
  categoria: new Types.ObjectId(),
  marca: new Types.ObjectId(),
  proveedor: new Types.ObjectId()
}

describe('Product inventory', () => {
  it('sanitizes stock from generic product updates while preserving other fields', () => {
    const update = {
      descripcion: 'Updated product',
      precioUnitario: 11,
      stock: 99
    }

    expect(sanitizeProductUpdate(update)).to.deep.equal({
      descripcion: 'Updated product',
      precioUnitario: 11
    })
    expect(update.stock).to.equal(99)
  })

  it('keeps legacy products valid without inventory and preserves physical stock', () => {
    const product = new ProductModel(baseProduct)

    expect(product.validateSync()).to.equal(undefined)
    expect(product.stock).to.equal(12)
    expect(product.inventory).to.equal(undefined)
    expect(ProductModel.schema.path('stock').instance).to.equal('Number')
    expect(ProductModel.schema.path('stock').isRequired).to.equal(true)
    expect(ProductModel.schema.path('inventory').isRequired).to.not.equal(true)
  })

  it('validates a complete inventory configuration', () => {
    const product = new ProductModel({
      ...baseProduct,
      inventory: {
        minimum: 5,
        expiryTracking: EXPIRY_TRACKING.TRACKED,
        baselineStatus: BASELINE_STATUS.RECONCILED,
        lastReconciledAt: new Date('2026-10-15T12:30:00.000Z'),
        lastReconciledBy: new Types.ObjectId()
      }
    })

    expect(product.validateSync()).to.equal(undefined)
    const inventorySchema = ProductModel.schema.path('inventory').schema
    expect(inventorySchema.path('lastReconciledAt').instance).to.equal('Date')
    expect(inventorySchema.path('lastReconciledBy').instance).to.equal('ObjectId')
    expect(inventorySchema.path('lastReconciledBy').options.ref).to.equal('user')
  })

  it('rejects invalid minimum, enum values, and reconciled user references', () => {
    const invalidMinimums = [-1, 1.5].map((minimum) => new ProductModel({
      ...baseProduct,
      inventory: {
        minimum,
        expiryTracking: EXPIRY_TRACKING.TRACKED,
        baselineStatus: BASELINE_STATUS.UNVERIFIED
      }
    }))
    const invalidExpiryTracking = new ProductModel({
      ...baseProduct,
      inventory: {
        minimum: 0,
        expiryTracking: 'OPTIONAL',
        baselineStatus: BASELINE_STATUS.UNVERIFIED
      }
    })
    const invalidBaselineStatus = new ProductModel({
      ...baseProduct,
      inventory: {
        minimum: 0,
        expiryTracking: EXPIRY_TRACKING.UNKNOWN,
        baselineStatus: 'PENDING'
      }
    })
    const invalidReconciledBy = new ProductModel({
      ...baseProduct,
      inventory: {
        minimum: 0,
        expiryTracking: EXPIRY_TRACKING.NOT_TRACKED,
        baselineStatus: BASELINE_STATUS.UNVERIFIED,
        lastReconciledBy: 'not-an-object-id'
      }
    })

    for (const invalidMinimum of invalidMinimums) {
      expect(invalidMinimum.validateSync()?.errors['inventory.minimum']).to.not.equal(undefined)
    }
    expect(invalidExpiryTracking.validateSync()?.errors['inventory.expiryTracking']).to.not.equal(undefined)
    expect(invalidBaselineStatus.validateSync()?.errors['inventory.baselineStatus']).to.not.equal(undefined)
    expect(invalidReconciledBy.validateSync()?.errors['inventory.lastReconciledBy']).to.not.equal(undefined)
  })
})
