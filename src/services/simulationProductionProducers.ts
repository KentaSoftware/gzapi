import { getSimulationConfig } from '../config/simulation'
import RoutePlanModel from '../models/routePlan'
import VehicleModel from '../models/vehicle'
import ProductModel from '../models/product'
import type { SimulationBaseScenarioInput } from '../interfaces/simulation.interface'
import { createSimulationSnapshotHandleMongoRepository } from './simulationSnapshotHandleMongoRepository'
import { loadSnapshots, type ValidatedSnapshots } from './simulationSnapshotAdapter'
import {
  issueBaseScenarioToken,
  verifyBaseScenarioToken,
  type BaseScenarioRequestContext,
  type BaseScenarioTokenDependencies,
  type ValidatedBaseScenario
} from './simulationToken'

interface SimulationProductionDataSources {
  routePlans: { findById: (id: string) => Promise<unknown | null> }
  vehicles: { findById: (id: string) => Promise<unknown | null> }
  products: { findAll: () => Promise<unknown[]> }
}

interface SimulationProductionProducers {
  routeProducer: { readRouteSnapshot: (routeId: string) => Promise<unknown> }
  stockProducer: { readStockSnapshot: () => Promise<unknown> }
  loadSnapshots: (input: SimulationBaseScenarioInput) => Promise<ValidatedSnapshots>
}

interface SimulationProductionService extends SimulationProductionProducers {
  issueBaseScenarioToken: (base: ValidatedBaseScenario, context: BaseScenarioRequestContext) => Promise<string>
  verifyBaseScenarioToken: (token: string, context: BaseScenarioRequestContext) => Promise<ValidatedBaseScenario>
}

interface SimulationProductionConfiguration {
  routeContractAllowlist: readonly string[]
  stockContractAllowlist: readonly string[]
}

const productionDataSources: SimulationProductionDataSources = {
  routePlans: { findById: async (id) => await RoutePlanModel.findById(id).lean() },
  vehicles: { findById: async (id) => await VehicleModel.findById(id).lean() },
  products: { findAll: async () => await ProductModel.find({}).lean() }
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined

const optionalString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value : undefined

const optionalNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

const idString = (value: unknown): string | undefined => {
  if (typeof value === 'string') return optionalString(value)
  if (typeof value === 'object' && value !== null && 'toHexString' in value && typeof value.toHexString === 'function') {
    return optionalString(value.toHexString())
  }
  return undefined
}

const createSimulationProductionProducers = (
  sources: SimulationProductionDataSources = productionDataSources,
  getConfiguration: () => SimulationProductionConfiguration = () => getSimulationConfig()
): SimulationProductionProducers => {
  const producers = {
    routeProducer: {
      readRouteSnapshot: async (routeId: string): Promise<unknown> => {
        const route = asRecord(await sources.routePlans.findById(routeId))
        if (route === undefined) throw new Error('Route plan was not found')

        const snapshot: Record<string, unknown> = { routeId }
        const zone = asRecord(route.zoneSnapshot)
        const zoneCode = optionalString(zone?.code)
        if (zoneCode !== undefined) snapshot.zoneCode = zoneCode

        if (Array.isArray(route.stops)) {
          snapshot.stops = route.stops.map((value) => {
            const stop = asRecord(value)
            if (stop === undefined) return {}
            return {
              ...(optionalNumber(stop.sequence) === undefined ? {} : { sequence: stop.sequence }),
              ...(idString(stop.clientId) === undefined ? {} : { clientId: idString(stop.clientId) }),
              ...(Array.isArray(stop.saleIds) ? { saleIds: stop.saleIds } : {})
            }
          })
        }

        const metrics = asRecord(route.metrics)
        const distanceMeters = optionalNumber(metrics?.distanceMeters)
        const durationSeconds = optionalNumber(metrics?.durationSeconds)
        if (distanceMeters !== undefined) snapshot.distanceMeters = distanceMeters
        if (durationSeconds !== undefined) snapshot.durationSeconds = durationSeconds

        const assignments = asRecord(route.assignments)
        const vehicleId = idString(assignments?.vehicleId)
        if (vehicleId !== undefined) {
          const vehicle = asRecord(await sources.vehicles.findById(vehicleId))
          const vehicleCode = optionalString(vehicle?.code)
          const fuelConsumption = optionalNumber(vehicle?.fuelConsumptionLitersPer100Km)
          if (vehicleCode !== undefined || fuelConsumption !== undefined) {
            snapshot.vehicle = {
              ...(vehicleCode === undefined ? {} : { vehicleCode }),
              ...(fuelConsumption === undefined ? {} : { fuelConsumptionLitersPer100Km: fuelConsumption })
            }
          }
        }

        return snapshot
      }
    },
    stockProducer: {
      readStockSnapshot: async (): Promise<unknown> => ({
        products: (await sources.products.findAll()).flatMap((value) => {
          const product = asRecord(value)
          const productId = idString(product?._id)
          if (product === undefined || productId === undefined) return []

          const entry: Record<string, unknown> = { productId }
          const unitCostArs = optionalNumber(product.precioCompra)
          const presalePriceArs = optionalNumber(product.precioUnitario)
          if (unitCostArs !== undefined) entry.unitCostArs = unitCostArs
          if (presalePriceArs !== undefined) entry.presalePriceArs = presalePriceArs

          const weight = asRecord(product.peso)
          const weightValue = optionalNumber(weight?.cantidad)
          const weightUnit = optionalString(weight?.unidad)
          if (weightValue !== undefined && weightUnit !== undefined) {
            entry.weight = { value: weightValue, unit: weightUnit }
          }
          return [entry]
        })
      })
    }
  }
  return {
    ...producers,
    loadSnapshots: async (input) => {
      const configuration = getConfiguration()
      return await loadSnapshots(input, {
        ...producers,
        routeContractAllowlist: configuration.routeContractAllowlist,
        stockContractAllowlist: configuration.stockContractAllowlist
      })
    }
  }
}

const createSimulationProductionService = (
  sources: SimulationProductionDataSources = productionDataSources,
  getConfiguration: () => SimulationProductionConfiguration = () => getSimulationConfig()
): SimulationProductionService => {
  const producers = createSimulationProductionProducers(sources, getConfiguration)
  const repository = createSimulationSnapshotHandleMongoRepository()
  const tokenDependencies = (): BaseScenarioTokenDependencies => ({
    secret: process.env.SIMULATION_TOKEN_SECRET ?? '',
    clock: () => new Date(),
    repository,
    ...getConfiguration()
  })

  return {
    ...producers,
    issueBaseScenarioToken: async (base, context) => await issueBaseScenarioToken(base, context, tokenDependencies()),
    verifyBaseScenarioToken: async (token, context) => await verifyBaseScenarioToken(token, context, tokenDependencies())
  }
}

export { createSimulationProductionProducers, createSimulationProductionService }
export type { SimulationProductionDataSources, SimulationProductionProducers, SimulationProductionConfiguration, SimulationProductionService }
