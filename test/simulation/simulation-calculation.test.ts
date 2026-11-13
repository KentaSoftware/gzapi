import { strict as assert } from 'node:assert'

import { createInMemorySimulationDemoRepository } from '../../src/models/simulationDemoFixture'
import { simulateDemoScenario } from '../../src/services/simulation'
import { calculateDemoSimulation } from '../../src/services/simulationCalculation'

describe('demo simulation calculation', () => {
  const route = { fuelLiters: 0.5, durationHours: 0 }
  const products = [{ unitPrice: 1.25, quantity: 1.2 }]
  const parameters = { fuelPricePerLiter: 1, hourlyRate: 0, generalCosts: 0, includeSurplus: false }

  it('rounds revenue and cost separately while using unrounded revenue for margin', () => {
    assert.deepEqual(calculateDemoSimulation(route, products, parameters), {
      estimatedRevenue: 2, operatingCost: 1, grossMargin: 1
    })
  })

  it('calculates margin from unrounded revenue at a negative half boundary', () => {
    const result = calculateDemoSimulation(
      { fuelLiters: 2, durationHours: 0 },
      [{ unitPrice: 1.5, quantity: 1 }],
      parameters
    )
    assert.equal(result.estimatedRevenue, 2)
    assert.equal(result.operatingCost, 2)
    assert.ok(Object.is(result.grossMargin, -0))
    assert.ok(!Object.is(result.estimatedRevenue - result.operatingCost, -0))
  })

  it('does not change the calculation when includeSurplus changes', () => {
    assert.deepEqual(calculateDemoSimulation(route, products, { ...parameters, includeSurplus: true }),
      calculateDemoSimulation(route, products, parameters))
  })

  it('propagates missing numeric input without defaulting it', () => {
    const result = calculateDemoSimulation(route, [{ unitPrice: undefined as unknown as number, quantity: 1 }], parameters)
    assert.ok(Number.isNaN(result.estimatedRevenue))
    assert.equal(result.operatingCost, 1)
    assert.ok(Number.isNaN(result.grossMargin))
  })

  it('preserves the demo service response and persisted detail', async () => {
    const repository = createInMemorySimulationDemoRepository()
    const input = {
      routeId: 'R-001',
      parameters: { fuelPricePerLiter: 1, hourlyRate: 1, generalCosts: 0, includeSurplus: false },
      products: [{ id: 'p', name: 'Product', stock: 10, unitPrice: 1.25, quantity: 1.2 }]
    }
    const result = await simulateDemoScenario(input, new Date('2025-05-26T12:00:00Z'), repository)
    assert.deepEqual(result, {
      id: 'ESC-015',
      date: '26/05/2025',
      routeId: 'R-001',
      zone: 'Norte',
      driver: 'Juan Pérez',
      vehicle: 'Móvil 1',
      estimatedRevenue: 2,
      operatingCost: 25,
      grossMargin: -23
    })
    const detail = (await repository.read())?.scenarioDetails?.[result.id]
    assert.deepEqual(detail, { ...result, orderCount: 12, fuelLiters: 18.5, distanceKm: 102.4, durationHours: 6.5, parameters: input.parameters, products: input.products })
  })
})
