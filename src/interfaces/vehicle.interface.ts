export interface Vehicle {
  _id?: unknown
  code: string
  fuelConsumptionLitersPer100Km: number
  attributes: Record<string, string>
  active: boolean
  createdAt?: Date
  updatedAt?: Date
}

export interface SelectableVehicle {
  id: string
  code: string
  fuelConsumptionLitersPer100Km: number
  attributes: Record<string, string>
  availability: boolean
}
