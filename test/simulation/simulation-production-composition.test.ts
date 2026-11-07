import { expect } from 'chai'
import { readSimulationConfig } from '../../src/config/simulation'
import { SIMULATION_CONTRACT_IDS, SIMULATION_ERROR_CODES } from '../../src/interfaces/simulation.interface'
import { reconcileRouteSnapshot, SimulationSnapshotError } from '../../src/services/simulationSnapshotAdapter'
import { createSimulationProductionService } from '../../src/services/simulationProductionProducers'
import { SimulationTokenError, type ValidatedBaseScenario } from '../../src/services/simulationToken'
import { BASE_HASH, USER_ID, validRouteSnapshot, validStockSnapshot } from './fixtures'

describe('production simulation producer composition', () => {
  it('uses only route, vehicle, and product facts and leaves unsupported fields absent', async () => {
    const producers = createSimulationProductionService({
      routePlans: {
        findById: async () => ({
          _id: '507f1f77bcf86cd799439011',
          zoneSnapshot: { code: 'NORTH' },
          selectedSaleIds: ['507f1f77bcf86cd799439012'],
          stops: [{ sequence: 1, clientId: '507f1f77bcf86cd799439013', saleIds: ['507f1f77bcf86cd799439012'] }],
          metrics: { distanceMeters: 1200, durationSeconds: 900 },
          assignments: { vehicleId: '507f1f77bcf86cd799439014' }
        })
      },
      vehicles: {
        findById: async () => ({ code: 'VAN-1', fuelConsumptionLitersPer100Km: 8 })
      },
      products: {
        findAll: async () => [{
          _id: '507f1f77bcf86cd799439015',
          stock: 50,
          precioCompra: 10,
          precioUnitario: 15,
          peso: { cantidad: 1, unidad: 'kg' },
          bulto: 6
        }]
      }
    }, () => ({ routeContractAllowlist: [], stockContractAllowlist: [] }))

    expect(producers.issueBaseScenarioToken).to.be.a('function')
    expect(producers.verifyBaseScenarioToken).to.be.a('function')

    const route = await producers.routeProducer.readRouteSnapshot('507f1f77bcf86cd799439011') as Record<string, unknown>
    expect(route).not.to.have.property('status')
    expect(route).not.to.have.property('capacity')
    expect(route).not.to.have.property('tollsArs')
    expect(route).not.to.have.property('parkingArs')

    const stock = await producers.stockProducer.readStockSnapshot() as { products: Array<Record<string, unknown>> }
    expect(stock.products[0]).not.to.have.property('availableQuantity')
    expect(stock.products[0]).not.to.have.property('volume')
    expect(stock.products[0]).not.to.have.property('stock')

    try {
      await producers.loadSnapshots({ routeId: '507f1f77bcf86cd799439011' })
      expect.fail('incomplete local data must not produce a simulation snapshot')
    } catch (error) {
      expect(error).to.be.instanceOf(SimulationSnapshotError)
      expect((error as SimulationSnapshotError).code).to.equal(SIMULATION_ERROR_CODES.SNAPSHOT_INCOMPLETE)
      expect((error as SimulationSnapshotError).missingField).to.equal('contractVersion')
    }
  })

  it('keeps disabled defaults and unapproved contracts fail-closed', () => {
    expect(readSimulationConfig({}).enabled).to.equal(false)

    try {
      reconcileRouteSnapshot(validRouteSnapshot, [])
      expect.fail('an unapproved route contract must be rejected')
    } catch (error) {
      expect(error).to.be.instanceOf(SimulationSnapshotError)
      expect((error as SimulationSnapshotError).code).to.equal(SIMULATION_ERROR_CODES.CONTRACT_NOT_APPROVED)
    }
  })

  it('rejects missing and short token secrets before accessing the handle repository', async () => {
    const service = createSimulationProductionService(undefined, () => ({
      routeContractAllowlist: [SIMULATION_CONTRACT_IDS.ROUTE],
      stockContractAllowlist: [SIMULATION_CONTRACT_IDS.STOCK]
    }))
    const base: ValidatedBaseScenario = {
      routeSnapshot: validRouteSnapshot,
      stockSnapshot: validStockSnapshot,
      versions: {
        routeContractVersion: SIMULATION_CONTRACT_IDS.ROUTE,
        stockContractVersion: SIMULATION_CONTRACT_IDS.STOCK,
        rulesVersion: 'simulation-rules-v1'
      },
      baseScenarioHash: BASE_HASH
    }
    const previousSecret = process.env.SIMULATION_TOKEN_SECRET

    try {
      for (const secret of [undefined, 'short']) {
        if (secret === undefined) delete process.env.SIMULATION_TOKEN_SECRET
        else process.env.SIMULATION_TOKEN_SECRET = secret

        try {
          await service.issueBaseScenarioToken(base, { actorId: USER_ID })
          expect.fail('missing or short production secrets must be rejected')
        } catch (error) {
          expect(error).to.be.instanceOf(SimulationTokenError)
          expect((error as SimulationTokenError).code).to.equal(SIMULATION_ERROR_CODES.CONFIGURATION_UNAVAILABLE)
        }
      }
    } finally {
      if (previousSecret === undefined) delete process.env.SIMULATION_TOKEN_SECRET
      else process.env.SIMULATION_TOKEN_SECRET = previousSecret
    }
  })
})
