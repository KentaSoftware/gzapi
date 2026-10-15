import type { SelectableVehicle } from '../interfaces/routeOptimization.interface'

const isFiniteNonNegative = (value: number): boolean => Number.isFinite(value) && value >= 0

const calculateFuelLiters = (distanceKm: number, consumptionLitersPer100Km: number): number => {
  if (!isFiniteNonNegative(distanceKm) || !isFiniteNonNegative(consumptionLitersPer100Km)) {
    throw new RangeError('Fuel calculation requires finite non-negative values')
  }

  return Number((distanceKm * consumptionLitersPer100Km / 100).toFixed(12))
}

const resolveAssignedConsumption = (vehicle: SelectableVehicle | null): number | null => {
  if (vehicle === null || !isFiniteNonNegative(vehicle.fuelConsumptionLitersPer100Km)) return null
  return vehicle.fuelConsumptionLitersPer100Km
}

export {
  calculateFuelLiters,
  resolveAssignedConsumption
}
