import type { SimulationDemoRoute, SimulationDemoRunInput, SimulationDemoScenario } from './simulation'

export const calculateDemoSimulation = (
  route: Pick<SimulationDemoRoute, 'fuelLiters' | 'durationHours'>,
  products: Array<Pick<SimulationDemoRunInput['products'][number], 'unitPrice' | 'quantity'>>,
  parameters: SimulationDemoRunInput['parameters']
): Pick<SimulationDemoScenario, 'estimatedRevenue' | 'operatingCost' | 'grossMargin'> => {
  const estimatedRevenue = products.reduce((total, product) => total + product.unitPrice * product.quantity, 0)
  const operatingCost = Math.round(route.fuelLiters * parameters.fuelPricePerLiter + route.durationHours * parameters.hourlyRate + parameters.generalCosts)
  return {
    estimatedRevenue: Math.round(estimatedRevenue),
    operatingCost,
    grossMargin: Math.round(estimatedRevenue - operatingCost)
  }
}
