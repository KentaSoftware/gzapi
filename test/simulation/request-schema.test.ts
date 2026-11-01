import { expect } from 'chai'

import { SIMULATION_ERROR_CODES } from '../../src/interfaces/simulation.interface'
import {
  simulationBaseScenarioInputSchema,
  simulationErrorEnvelopeSchema,
  simulationSaveRunInputSchema,
  simulationVariantInputSchema,
  simulationVersionedConfigurationInputSchema,
  simulationVersionedPresetInputSchema
} from '../../src/schemas/simulation.schema'
import {
  PRODUCT_ID,
  ROUTE_ID,
  validConfigurationInput,
  validVariant
} from './fixtures'

describe('Simulation contract - request schemas', () => {
  it('TC-030: accepts a base scenario request with one route identifier only', () => {
    expect(simulationBaseScenarioInputSchema.safeParse({ routeId: ROUTE_ID }).success).to.equal(true)
    expect(simulationBaseScenarioInputSchema.safeParse({ routeId: 'route-1' }).success).to.equal(false)
    expect(simulationBaseScenarioInputSchema.safeParse({ routeId: ROUTE_ID, extra: true }).success).to.equal(false)
  })

  it('TC-030: accepts structural variant inputs without homologated numeric limits', () => {
    expect(simulationVariantInputSchema.safeParse(validVariant).success).to.equal(true)
    expect(simulationVariantInputSchema.safeParse({ ...validVariant, overrides: [] }).success).to.equal(true)
    expect(simulationVariantInputSchema.safeParse({ ...validVariant, directLoad: [] }).success).to.equal(true)
  })

  it('TC-030: rejects duplicate override keys, unsafe values, and unknown keys', () => {
    const duplicate = {
      ...validVariant,
      overrides: [
        { key: 'fuelPricePerLiter', value: 1200.5 },
        { key: 'fuelPricePerLiter', value: 1300 }
      ]
    }
    expect(simulationVariantInputSchema.safeParse(duplicate).success).to.equal(false)
    expect(simulationVariantInputSchema.safeParse({
      ...validVariant,
      overrides: [{ key: 'fuelPricePerLiter', value: Number.POSITIVE_INFINITY }]
    }).success).to.equal(false)
    expect(simulationVariantInputSchema.safeParse({
      ...validVariant,
      overrides: [{ key: 'fuelPricePerLiter', value: -1 }]
    }).success).to.equal(false)
    expect(simulationVariantInputSchema.safeParse({
      ...validVariant,
      overrides: [{ key: 'fuelPricePerLiter', value: 1200.5, unit: 'ARS' }]
    }).success).to.equal(false)
  })

  it('TC-030: accepts fractional quantities while keeping finite non-negative validation', () => {
    expect(simulationVariantInputSchema.safeParse({
      ...validVariant,
      directLoad: [{ productId: PRODUCT_ID, quantity: 1.5, projectedSalesQuantity: 1.25 }]
    }).success).to.equal(true)
    expect(simulationVariantInputSchema.safeParse({
      ...validVariant,
      directLoad: [{ productId: PRODUCT_ID, quantity: -1, projectedSalesQuantity: 0 }]
    }).success).to.equal(false)
    expect(simulationVariantInputSchema.safeParse({
      ...validVariant,
      directLoad: [{ productId: PRODUCT_ID, quantity: Number.POSITIVE_INFINITY, projectedSalesQuantity: 0 }]
    }).success).to.equal(false)
  })

  it('TC-030: rejects projected sales above direct load and duplicate products', () => {
    expect(simulationVariantInputSchema.safeParse({
      ...validVariant,
      directLoad: [{ productId: PRODUCT_ID, quantity: 10, projectedSalesQuantity: 11 }]
    }).success).to.equal(false)
    expect(simulationVariantInputSchema.safeParse({
      ...validVariant,
      directLoad: [
        { productId: PRODUCT_ID, quantity: 10, projectedSalesQuantity: 1 },
        { productId: PRODUCT_ID, quantity: 5, projectedSalesQuantity: 1 }
      ]
    }).success).to.equal(false)
  })

  it('TC-030: accepts only opaque bounded save tokens', () => {
    const token = 'eyJhbGciOiJIUzI1NiJ9.payload.signature'
    expect(simulationSaveRunInputSchema.safeParse({ token, variant: validVariant }).success).to.equal(true)
    expect(simulationSaveRunInputSchema.safeParse({ token: '', variant: validVariant }).success).to.equal(false)
    expect(simulationSaveRunInputSchema.safeParse({ token: 'token with spaces', variant: validVariant }).success).to.equal(false)
  })

  it('TC-030: rejects invalid error envelopes', () => {
    expect(simulationErrorEnvelopeSchema.safeParse({
      code: SIMULATION_ERROR_CODES.DISABLED,
      message: 'Simulation is disabled'
    }).success).to.equal(true)
    expect(simulationErrorEnvelopeSchema.safeParse({
      code: 'UNKNOWN_CODE',
      message: 'Simulation is disabled'
    }).success).to.equal(false)
  })
})

describe('Simulation contract - versioned inputs', () => {
  it('TC-030: accepts a scoped, approved configuration version with a reason', () => {
    expect(simulationVersionedConfigurationInputSchema.safeParse(validConfigurationInput).success).to.equal(true)
    expect(simulationVersionedConfigurationInputSchema.safeParse({
      ...validConfigurationInput,
      values: {}
    }).success).to.equal(false)
    expect(simulationVersionedConfigurationInputSchema.safeParse({
      ...validConfigurationInput,
      period: { from: '2026-11-30', to: '2026-11-01' }
    }).success).to.equal(false)
    expect(simulationVersionedConfigurationInputSchema.safeParse({
      ...validConfigurationInput,
      approval: undefined
    }).success).to.equal(false)
    expect(simulationVersionedConfigurationInputSchema.safeParse({
      ...validConfigurationInput,
      reason: ' '
    }).success).to.equal(false)
    expect(simulationVersionedConfigurationInputSchema.safeParse({
      ...validConfigurationInput,
      values: { fuelPricePerLiter: 'expensive' }
    }).success).to.equal(false)
  })

  it('TC-030: accepts a versioned preset definition with a reason', () => {
    const preset = {
      name: 'Conservative',
      reason: 'Baseline preset',
      definition: { overrides: validVariant.overrides, directLoad: validVariant.directLoad }
    }
    expect(simulationVersionedPresetInputSchema.safeParse(preset).success).to.equal(true)
    expect(simulationVersionedPresetInputSchema.safeParse({ ...preset, name: '' }).success).to.equal(false)
    expect(simulationVersionedPresetInputSchema.safeParse({ ...preset, reason: '' }).success).to.equal(false)
    expect(simulationVersionedPresetInputSchema.safeParse({ ...preset, definition: undefined }).success).to.equal(false)
  })
})
