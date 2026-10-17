import type { SelectableVehicle, Vehicle } from '../interfaces/vehicle.interface'
import VehicleModel from '../models/vehicle'

const toSelectableVehicle = (vehicle: Vehicle & { id?: string }): SelectableVehicle => ({
  id: vehicle.id ?? String(vehicle._id),
  code: vehicle.code,
  fuelConsumptionLitersPer100Km: vehicle.fuelConsumptionLitersPer100Km,
  attributes: vehicle.attributes,
  availability: vehicle.active
})

const listSelectableVehicles = async (): Promise<SelectableVehicle[]> => {
  const vehicles = await VehicleModel.find({ active: true })
    .select({ code: 1, fuelConsumptionLitersPer100Km: 1, attributes: 1, active: 1 })
    .sort({ code: 1 })
    .lean()

  return vehicles.map((vehicle) => toSelectableVehicle(vehicle))
}

const getVehicleById = async (id: string): Promise<SelectableVehicle | null> => {
  const vehicle = await VehicleModel.findById(id)
    .select({ code: 1, fuelConsumptionLitersPer100Km: 1, attributes: 1, active: 1 })
    .lean()

  return vehicle === null ? null : toSelectableVehicle(vehicle)
}

export { getVehicleById, listSelectableVehicles }
