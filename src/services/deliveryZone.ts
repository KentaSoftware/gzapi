import type { FilterQuery } from 'mongoose'
import DeliveryZoneModel from '../models/deliveryZone'
import { DELIVERY_ZONE_ERROR_CODES } from '../interfaces/routeOptimization.interface'
import type {
  DeliveryZone,
  DeliveryZoneCreateInput,
  DeliveryZoneErrorCode,
  DeliveryZoneListFilter,
  DeliveryZoneUpdateInput
} from '../interfaces/routeOptimization.interface'

class DeliveryZoneError extends Error {
  readonly code: DeliveryZoneErrorCode

  constructor (code: DeliveryZoneErrorCode, message: string) {
    super(message)
    this.name = 'DeliveryZoneError'
    this.code = code
  }
}

const normalizeCode = (code: string): string => code.trim().toUpperCase()
const normalizeName = (name: string): string => name.trim().toLowerCase()

const isDuplicateKeyError = (error: unknown): boolean => typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 11000

const duplicateError = (error: unknown): DeliveryZoneError => {
  const keyPattern = (error as { keyPattern?: Record<string, unknown> }).keyPattern
  return keyPattern?.normalizedName !== undefined
    ? new DeliveryZoneError(DELIVERY_ZONE_ERROR_CODES.DUPLICATE_DELIVERY_ZONE_NAME, 'Delivery zone name is already in use')
    : new DeliveryZoneError(DELIVERY_ZONE_ERROR_CODES.DUPLICATE_DELIVERY_ZONE_CODE, 'Delivery zone code is already in use')
}

const assertUnique = async (code: string, normalizedName: string, excludeId?: string): Promise<void> => {
  const filter: FilterQuery<DeliveryZone> = { $or: [{ code }, { normalizedName }] }
  if (excludeId !== undefined) filter._id = { $ne: excludeId }

  const existing = await DeliveryZoneModel.findOne(filter).lean()
  if (existing === null) return
  if (existing.code === code) throw new DeliveryZoneError(DELIVERY_ZONE_ERROR_CODES.DUPLICATE_DELIVERY_ZONE_CODE, 'Delivery zone code is already in use')
  throw new DeliveryZoneError(DELIVERY_ZONE_ERROR_CODES.DUPLICATE_DELIVERY_ZONE_NAME, 'Delivery zone name is already in use')
}

const listDeliveryZones = async (filter: DeliveryZoneListFilter = {}): Promise<DeliveryZone[]> => {
  const query: FilterQuery<DeliveryZone> = {}
  if (filter.active !== undefined) query.active = filter.active
  return await DeliveryZoneModel.find(query).sort({ code: 1 }).lean()
}

const createDeliveryZone = async (input: DeliveryZoneCreateInput): Promise<DeliveryZone> => {
  const code = normalizeCode(input.code)
  const name = input.name.trim()
  const normalizedName = normalizeName(input.name)
  await assertUnique(code, normalizedName)

  try {
    return await DeliveryZoneModel.create({ code, name, normalizedName, active: input.active ?? true })
  } catch (error) {
    if (isDuplicateKeyError(error)) throw duplicateError(error)
    throw error
  }
}

const updateDeliveryZone = async (id: string, input: DeliveryZoneUpdateInput): Promise<DeliveryZone> => {
  const zone = await DeliveryZoneModel.findById(id)
  if (zone === null) throw new DeliveryZoneError(DELIVERY_ZONE_ERROR_CODES.DELIVERY_ZONE_NOT_FOUND, 'Delivery zone was not found')

  if (input.name !== undefined) {
    const normalizedName = normalizeName(input.name)
    if (normalizedName !== zone.normalizedName) await assertUnique(zone.code, normalizedName, id)
    zone.name = input.name.trim()
    zone.normalizedName = normalizedName
  }
  if (input.active !== undefined) zone.active = input.active

  try {
    await zone.save()
  } catch (error) {
    if (isDuplicateKeyError(error)) throw duplicateError(error)
    throw error
  }
  return zone
}

export {
  createDeliveryZone,
  DeliveryZoneError,
  listDeliveryZones,
  updateDeliveryZone
}
