import { expect } from 'chai'
import sinon from 'sinon'

import {
  SIMULATION_CONTRACT_IDS,
  SIMULATION_ERROR_CODES,
  SIMULATION_ROUTE_SNAPSHOT_STATUSES
} from '../../src/interfaces/simulation.interface'
import { simulationErrorEnvelopeSchema } from '../../src/schemas/simulation.schema'
import {
  SimulationSnapshotError,
  loadSnapshots,
  reconcileRouteSnapshot,
  reconcileStockSnapshot
} from '../../src/services/simulationSnapshotAdapter'
import {
  CLIENT_ID,
  ROUTE_ID,
  validRouteSnapshot,
  validStockSnapshot
} from './fixtures'

const routeAllowlist = [SIMULATION_CONTRACT_IDS.ROUTE]
const stockAllowlist = [SIMULATION_CONTRACT_IDS.STOCK]

interface CapturedSnapshotError extends Error {
  code: string
  missingField?: string
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

const objectId = (value: number): string => value.toString(16).padStart(24, '0')

const removePath = (value: Record<string, unknown>, path: string): Record<string, unknown> => {
  const copy = clone(value)
  const segments = path.replace(/\[(\d+)\]/g, '.$1').split('.')
  let current = copy
  for (const segment of segments.slice(0, -1)) {
    current = current[segment] as Record<string, unknown>
  }
  Reflect.deleteProperty(current, segments[segments.length - 1])
  return copy
}

const envelope = (version: string, data: unknown): Record<string, unknown> => ({ version, data })

const captureError = (operation: () => unknown): CapturedSnapshotError => {
  try {
    operation()
  } catch (error) {
    expect(error).to.be.instanceOf(SimulationSnapshotError)
    return error as CapturedSnapshotError
  }
  throw new Error('Expected the snapshot operation to fail closed')
}

const captureAsyncError = async (operation: () => Promise<unknown>): Promise<CapturedSnapshotError> => {
  try {
    await operation()
  } catch (error) {
    expect(error).to.be.instanceOf(SimulationSnapshotError)
    return error as CapturedSnapshotError
  }
  throw new Error('Expected the snapshot operation to fail closed')
}

const ROUTE_REQUIRED_FIELDS = [
  'contractVersion',
  'capturedAt',
  'routeId',
  'status',
  'zoneCode',
  'stops',
  'stops[0].sequence',
  'stops[0].clientId',
  'stops[0].saleIds',
  'distanceMeters',
  'durationSeconds',
  'vehicle',
  'vehicle.vehicleCode',
  'vehicle.fuelConsumptionLitersPer100Km',
  'capacity',
  'capacity.maxWeight',
  'capacity.maxWeight.value',
  'capacity.maxWeight.unit',
  'capacity.maxVolume',
  'capacity.maxVolume.value',
  'capacity.maxVolume.unit',
  'tollsArs',
  'parkingArs'
] as const

const STOCK_REQUIRED_FIELDS = [
  'contractVersion',
  'capturedAt',
  'products',
  'products[0].productId',
  'products[0].availableQuantity',
  'products[0].unitCostArs',
  'products[0].presalePriceArs',
  'products[0].weight',
  'products[0].weight.value',
  'products[0].weight.unit',
  'products[0].volume',
  'products[0].volume.value',
  'products[0].volume.unit'
] as const

describe('Simulation read-only snapshot adapter', () => {
  it('S-01: creates a base scenario from validated route and stock snapshots without rewriting them', () => {
    const route = reconcileRouteSnapshot(clone(validRouteSnapshot), routeAllowlist)
    const stock = reconcileStockSnapshot(clone(validStockSnapshot), stockAllowlist)

    expect(route).to.deep.equal(validRouteSnapshot)
    expect(stock).to.deep.equal(validStockSnapshot)
    expect(Object.isFrozen(route)).to.equal(true)
    expect(Object.isFrozen(route.vehicle)).to.equal(true)
    expect(Object.isFrozen(route.capacity.maxWeight)).to.equal(true)
    expect(Object.isFrozen(stock)).to.equal(true)
    expect(Object.isFrozen(stock.products[0].weight)).to.equal(true)
  })

  it('TC-010: unwraps the declared producer envelope for both snapshot contracts', () => {
    const route = reconcileRouteSnapshot(envelope(SIMULATION_CONTRACT_IDS.ROUTE, clone(validRouteSnapshot)), routeAllowlist)
    const stock = reconcileStockSnapshot(envelope(SIMULATION_CONTRACT_IDS.STOCK, clone(validStockSnapshot)), stockAllowlist)

    expect(route).to.deep.equal(validRouteSnapshot)
    expect(stock).to.deep.equal(validStockSnapshot)
  })

  it('S-21a: rejects a flattened route contract version outside the configured allowlist', () => {
    const incompatibleVersion = { ...clone(validRouteSnapshot), contractVersion: 'SIM-ROUTE-SNAPSHOT-002' }

    const error = captureError(() => reconcileRouteSnapshot(incompatibleVersion, routeAllowlist))

    expect(error.code).to.equal(SIMULATION_ERROR_CODES.CONTRACT_NOT_APPROVED)
  })

  it('S-21b: rejects a flattened stock contract version outside the configured allowlist', () => {
    const incompatibleVersion = { ...clone(validStockSnapshot), contractVersion: 'SIM-STOCK-SNAPSHOT-002' }

    const error = captureError(() => reconcileStockSnapshot(incompatibleVersion, stockAllowlist))

    expect(error.code).to.equal(SIMULATION_ERROR_CODES.CONTRACT_NOT_APPROVED)
  })

  it('S-21a: rejects an envelope whose declared route version is outside the configured allowlist', () => {
    const error = captureError(() => reconcileRouteSnapshot(
      envelope('SIM-ROUTE-SNAPSHOT-002', clone(validRouteSnapshot)),
      routeAllowlist
    ))

    expect(error.code).to.equal(SIMULATION_ERROR_CODES.CONTRACT_NOT_APPROVED)
  })

  it('S-21a: rejects an envelope whose version differs from the payload contract version', () => {
    const payload = { ...clone(validRouteSnapshot), contractVersion: 'SIM-ROUTE-SNAPSHOT-002' }
    const allowlist = [SIMULATION_CONTRACT_IDS.ROUTE, 'SIM-ROUTE-SNAPSHOT-002']

    const error = captureError(() => reconcileRouteSnapshot(envelope(SIMULATION_CONTRACT_IDS.ROUTE, payload), allowlist))

    expect(error.code).to.equal(SIMULATION_ERROR_CODES.CONTRACT_INCOMPATIBLE)
  })

  it('S-21a: rejects a missing route allowlist entry instead of assuming approval', () => {
    const error = captureError(() => reconcileRouteSnapshot(clone(validRouteSnapshot), []))

    expect(error.code).to.equal(SIMULATION_ERROR_CODES.CONTRACT_NOT_APPROVED)
  })

  it('TC-030: rejects unsupported producer envelope shapes instead of deriving data', () => {
    const shapes: unknown[] = [
      null,
      [],
      'snapshot',
      { version: SIMULATION_CONTRACT_IDS.ROUTE },
      { data: clone(validRouteSnapshot) },
      { version: SIMULATION_CONTRACT_IDS.ROUTE, data: [] },
      { version: 1, data: clone(validRouteSnapshot) }
    ]

    for (const shape of shapes) {
      const error = captureError(() => reconcileRouteSnapshot(shape, routeAllowlist))
      expect(error.code).to.equal(SIMULATION_ERROR_CODES.CONTRACT_INCOMPATIBLE)
    }
  })

  it('TC-030: rejects structurally invalid snapshots through the existing Zod schema', () => {
    const negativeDistance = { ...clone(validRouteSnapshot), distanceMeters: -1 }
    const extraField = { ...clone(validRouteSnapshot), unexpectedField: true }
    const negativePrice = {
      ...clone(validStockSnapshot),
      products: [{ ...clone(validStockSnapshot.products[0]), presalePriceArs: -1 }]
    }

    expect(captureError(() => reconcileRouteSnapshot(negativeDistance, routeAllowlist)).code)
      .to.equal(SIMULATION_ERROR_CODES.CONTRACT_INCOMPATIBLE)
    expect(captureError(() => reconcileRouteSnapshot(extraField, routeAllowlist)).code)
      .to.equal(SIMULATION_ERROR_CODES.CONTRACT_INCOMPATIBLE)
    expect(captureError(() => reconcileStockSnapshot(negativePrice, stockAllowlist)).code)
      .to.equal(SIMULATION_ERROR_CODES.CONTRACT_INCOMPATIBLE)
  })

  it('S-07a: rejects a draft route snapshot', () => {
    const draft = { ...clone(validRouteSnapshot), status: SIMULATION_ROUTE_SNAPSHOT_STATUSES.DRAFT }

    const error = captureError(() => reconcileRouteSnapshot(draft, routeAllowlist))

    expect(error.code).to.equal(SIMULATION_ERROR_CODES.CONTRACT_INCOMPATIBLE)
  })

  it('S-07b: rejects a cancelled route snapshot', () => {
    const cancelled = { ...clone(validRouteSnapshot), status: SIMULATION_ROUTE_SNAPSHOT_STATUSES.CANCELLED }

    const error = captureError(() => reconcileRouteSnapshot(cancelled, routeAllowlist))

    expect(error.code).to.equal(SIMULATION_ERROR_CODES.CONTRACT_INCOMPATIBLE)
  })

  it('S-07c: rejects a route snapshot with an unrecognized status', () => {
    const unrecognized = { ...clone(validRouteSnapshot), status: 'UNRECOGNIZED' }

    const error = captureError(() => reconcileRouteSnapshot(unrecognized, routeAllowlist))

    expect(error.code).to.equal(SIMULATION_ERROR_CODES.CONTRACT_INCOMPATIBLE)
  })

  it('S-12a: treats an empty frozen-order list as an incomplete route snapshot', () => {
    const emptyStops = { ...clone(validRouteSnapshot), stops: [] }

    const error = captureError(() => reconcileRouteSnapshot(emptyStops, routeAllowlist))

    expect(error.code).to.equal(SIMULATION_ERROR_CODES.SNAPSHOT_INCOMPLETE)
    expect(error.missingField).to.equal('stops')
  })

  it('S-12a: treats an empty sale identifier list as an incomplete route snapshot', () => {
    const emptySaleIds = {
      ...clone(validRouteSnapshot),
      stops: [{ ...clone(validRouteSnapshot.stops[0]), saleIds: [] }]
    }

    const error = captureError(() => reconcileRouteSnapshot(emptySaleIds, routeAllowlist))

    expect(error.code).to.equal(SIMULATION_ERROR_CODES.SNAPSHOT_INCOMPLETE)
    expect(error.missingField).to.equal('stops[0].saleIds')
  })

  it('S-12b: treats an empty product list as an incomplete stock snapshot', () => {
    const emptyProducts = { ...clone(validStockSnapshot), products: [] }

    const error = captureError(() => reconcileStockSnapshot(emptyProducts, stockAllowlist))

    expect(error.code).to.equal(SIMULATION_ERROR_CODES.SNAPSHOT_INCOMPLETE)
    expect(error.missingField).to.equal('products')
  })

  it('TC-030: rejects an oversized route stop collection before traversing it', () => {
    const oversizedStops = {
      ...clone(validRouteSnapshot),
      stops: Array.from({ length: 1001 }, () => null)
    }

    const error = captureError(() => reconcileRouteSnapshot(oversizedStops, routeAllowlist))

    expect(error.code).to.equal(SIMULATION_ERROR_CODES.CONTRACT_INCOMPATIBLE)
    expect(error.message).to.contain('stops')
    expect(error.message).to.contain('supported bound')
  })

  it('TC-030: rejects an oversized stop sale identifier collection before schema traversal', () => {
    const oversizedSaleIds = {
      ...clone(validRouteSnapshot),
      stops: [{
        sequence: 1,
        clientId: CLIENT_ID,
        saleIds: Array.from({ length: 1001 }, () => 'x')
      }]
    }

    const error = captureError(() => reconcileRouteSnapshot(oversizedSaleIds, routeAllowlist))

    expect(error.code).to.equal(SIMULATION_ERROR_CODES.CONTRACT_INCOMPATIBLE)
    expect(error.message).to.contain('stops[0].saleIds')
    expect(error.message).to.contain('supported bound')
  })

  it('TC-030: accepts an aggregate sale identifier collection within the declared schema bounds', () => {
    const wideRoute = {
      ...clone(validRouteSnapshot),
      stops: Array.from({ length: 11 }, (_, stopIndex) => ({
        sequence: stopIndex + 1,
        clientId: objectId(stopIndex + 1),
        saleIds: Array.from({ length: 1000 }, (_, saleIndex) => objectId(
          100000 + stopIndex * 1000 + saleIndex
        ))
      }))
    }

    const route = reconcileRouteSnapshot(wideRoute, routeAllowlist)
    const totalSaleIds = route.stops.reduce((total, stop) => total + stop.saleIds.length, 0)

    expect(route.stops).to.have.lengthOf(11)
    expect(totalSaleIds).to.equal(11000)
  })

  it('TC-030: rejects an oversized stock product collection before traversing it', () => {
    const oversizedProducts = {
      ...clone(validStockSnapshot),
      products: Array.from({ length: 10001 }, () => null)
    }

    const error = captureError(() => reconcileStockSnapshot(oversizedProducts, stockAllowlist))

    expect(error.code).to.equal(SIMULATION_ERROR_CODES.CONTRACT_INCOMPATIBLE)
    expect(error.message).to.contain('products')
    expect(error.message).to.contain('supported bound')
  })

  it('S-21a: bounds an oversized route contract version in the rejection message', () => {
    const oversizedVersion = 'V'.repeat(5000)
    const snapshot = { ...clone(validRouteSnapshot), contractVersion: oversizedVersion }

    const error = captureError(() => reconcileRouteSnapshot(snapshot, routeAllowlist))

    expect(error.code).to.equal(SIMULATION_ERROR_CODES.CONTRACT_NOT_APPROVED)
    expect(error.message).to.not.contain(oversizedVersion)
    expect(error.message.length).to.be.lessThan(500)
  })

  it('bounds aggregated schema issues to the error-envelope message limit', () => {
    const invalidStops = {
      ...clone(validRouteSnapshot),
      stops: Array.from({ length: 1000 }, (_, index) => ({
        sequence: -1,
        clientId: `invalid-client-${index}`,
        saleIds: [`invalid-sale-${index}`]
      }))
    }

    const error = captureError(() => reconcileRouteSnapshot(invalidStops, routeAllowlist))
    const envelope = simulationErrorEnvelopeSchema.safeParse({
      code: error.code,
      message: error.message
    })

    expect(error.code).to.equal(SIMULATION_ERROR_CODES.CONTRACT_INCOMPATIBLE)
    expect(error.message.length).to.be.at.most(500)
    expect(envelope.success).to.equal(true)
  })

  for (const field of ROUTE_REQUIRED_FIELDS) {
    it(`S-12a: fails closed as incomplete when the required route field ${field} is missing`, () => {
      const incomplete = removePath(clone(validRouteSnapshot) as Record<string, unknown>, field)

      const error = captureError(() => reconcileRouteSnapshot(incomplete, routeAllowlist))

      expect(error.code).to.equal(SIMULATION_ERROR_CODES.SNAPSHOT_INCOMPLETE)
      expect(error.missingField).to.equal(field)
    })
  }

  for (const field of STOCK_REQUIRED_FIELDS) {
    it(`S-12b: fails closed as incomplete when the required stock field ${field} is missing`, () => {
      const incomplete = removePath(clone(validStockSnapshot) as Record<string, unknown>, field)

      const error = captureError(() => reconcileStockSnapshot(incomplete, stockAllowlist))

      expect(error.code).to.equal(SIMULATION_ERROR_CODES.SNAPSHOT_INCOMPLETE)
      expect(error.missingField).to.equal(field)
    })
  }

  it('S-12a: classifies null required route fields as incomplete snapshots', () => {
    const nullFields = [
      { field: 'routeId', snapshot: { ...clone(validRouteSnapshot), routeId: null } },
      { field: 'capturedAt', snapshot: { ...clone(validRouteSnapshot), capturedAt: null } },
      { field: 'distanceMeters', snapshot: { ...clone(validRouteSnapshot), distanceMeters: null } },
      { field: 'tollsArs', snapshot: { ...clone(validRouteSnapshot), tollsArs: null } },
      { field: 'parkingArs', snapshot: { ...clone(validRouteSnapshot), parkingArs: null } },
      {
        field: 'stops[0].sequence',
        snapshot: {
          ...clone(validRouteSnapshot),
          stops: [{ ...clone(validRouteSnapshot.stops[0]), sequence: null }]
        }
      },
      {
        field: 'capacity.maxWeight.value',
        snapshot: {
          ...clone(validRouteSnapshot),
          capacity: {
            ...clone(validRouteSnapshot.capacity),
            maxWeight: { value: null, unit: 'kg' }
          }
        }
      }
    ]

    for (const { field, snapshot } of nullFields) {
      const error = captureError(() => reconcileRouteSnapshot(snapshot, routeAllowlist))

      expect(error.code).to.equal(SIMULATION_ERROR_CODES.SNAPSHOT_INCOMPLETE)
      expect(error.missingField).to.equal(field)
    }
  })

  it('S-12b: classifies null required stock fields as incomplete snapshots', () => {
    const nullFields = [
      { field: 'capturedAt', snapshot: { ...clone(validStockSnapshot), capturedAt: null } },
      {
        field: 'products[0].availableQuantity',
        snapshot: {
          ...clone(validStockSnapshot),
          products: [{ ...clone(validStockSnapshot.products[0]), availableQuantity: null }]
        }
      },
      {
        field: 'products[0].unitCostArs',
        snapshot: {
          ...clone(validStockSnapshot),
          products: [{ ...clone(validStockSnapshot.products[0]), unitCostArs: null }]
        }
      },
      {
        field: 'products[0].weight.value',
        snapshot: {
          ...clone(validStockSnapshot),
          products: [{
            ...clone(validStockSnapshot.products[0]),
            weight: { value: null, unit: 'kg' }
          }]
        }
      }
    ]

    for (const { field, snapshot } of nullFields) {
      const error = captureError(() => reconcileStockSnapshot(snapshot, stockAllowlist))

      expect(error.code).to.equal(SIMULATION_ERROR_CODES.SNAPSHOT_INCOMPLETE)
      expect(error.missingField).to.equal(field)
    }
  })

  it('TC-011: reads only through injected producer ports and never writes or mutates producer data', async () => {
    const routeFixture = clone(validRouteSnapshot)
    const stockFixture = clone(validStockSnapshot)
    const routeBefore = clone(routeFixture)
    const stockBefore = clone(stockFixture)
    const routeProducer = {
      readRouteSnapshot: sinon.stub().resolves(clone(routeFixture)),
      writeRouteSnapshot: sinon.spy(),
      deleteRouteSnapshot: sinon.spy()
    }
    const stockProducer = {
      readStockSnapshot: sinon.stub().resolves(clone(stockFixture)),
      writeStockSnapshot: sinon.spy()
    }

    const result = await loadSnapshots(
      { routeId: ROUTE_ID },
      {
        routeProducer,
        stockProducer,
        routeContractAllowlist: routeAllowlist,
        stockContractAllowlist: stockAllowlist
      }
    )

    expect(routeProducer.readRouteSnapshot.calledOnceWith(ROUTE_ID)).to.equal(true)
    expect(stockProducer.readStockSnapshot.calledOnce).to.equal(true)
    expect(routeProducer.writeRouteSnapshot.called).to.equal(false)
    expect(routeProducer.deleteRouteSnapshot.called).to.equal(false)
    expect(stockProducer.writeStockSnapshot.called).to.equal(false)
    expect(routeFixture).to.deep.equal(routeBefore)
    expect(stockFixture).to.deep.equal(stockBefore)
    expect(result.routeSnapshot).to.deep.equal(routeBefore)
    expect(result.stockSnapshot).to.deep.equal(stockBefore)
    expect(Object.isFrozen(result.routeSnapshot)).to.equal(true)
    expect(Object.isFrozen(result.stockSnapshot)).to.equal(true)
  })

  it('S-01: fails closed when the producer route identity does not match the requested route', async () => {
    const mismatchedRoute = { ...clone(validRouteSnapshot), routeId: '507f1f77bcf86cd799439099' }
    const routeProducer = { readRouteSnapshot: sinon.stub().resolves(mismatchedRoute) }
    const stockProducer = { readStockSnapshot: sinon.stub().resolves(clone(validStockSnapshot)) }

    const error = await captureAsyncError(async () => await loadSnapshots(
      { routeId: ROUTE_ID },
      {
        routeProducer,
        stockProducer,
        routeContractAllowlist: routeAllowlist,
        stockContractAllowlist: stockAllowlist
      }
    ))

    expect(error.code).to.equal(SIMULATION_ERROR_CODES.CONTRACT_INCOMPATIBLE)
    expect(stockProducer.readStockSnapshot.called).to.equal(false)
  })

  it('S-01: accepts a route identity that differs only by case or surrounding whitespace', async () => {
    const equivalentRouteId = `  ${ROUTE_ID.toUpperCase()}  `
    const routeProducer = {
      readRouteSnapshot: sinon.stub().resolves({ ...clone(validRouteSnapshot), routeId: equivalentRouteId })
    }
    const stockProducer = { readStockSnapshot: sinon.stub().resolves(clone(validStockSnapshot)) }
    const dependencies = {
      routeProducer,
      stockProducer,
      routeContractAllowlist: routeAllowlist,
      stockContractAllowlist: stockAllowlist
    }

    const fromProducer = await loadSnapshots({ routeId: ROUTE_ID }, dependencies)
    expect(fromProducer.routeSnapshot.routeId).to.equal(equivalentRouteId.trim())

    routeProducer.readRouteSnapshot.resolves(clone(validRouteSnapshot))
    const fromRequest = await loadSnapshots({ routeId: equivalentRouteId }, dependencies)
    expect(fromRequest.routeSnapshot.routeId).to.equal(ROUTE_ID)
    expect(routeProducer.readRouteSnapshot.lastCall.args[0]).to.equal(ROUTE_ID)
  })

  it('S-01b: rejects malformed or oversized route identifiers before calling the producer', async () => {
    const routeProducer = { readRouteSnapshot: sinon.stub().resolves(clone(validRouteSnapshot)) }
    const stockProducer = { readStockSnapshot: sinon.stub().resolves(clone(validStockSnapshot)) }
    const dependencies = {
      routeProducer,
      stockProducer,
      routeContractAllowlist: routeAllowlist,
      stockContractAllowlist: stockAllowlist
    }
    const malformedRouteIds = ['not-an-object-id', '507f1f77bcf86cd79943901z', 'a'.repeat(5000), '   ']

    for (const routeId of malformedRouteIds) {
      const error = await captureAsyncError(async () => await loadSnapshots({ routeId }, dependencies))

      expect(error.code).to.equal(SIMULATION_ERROR_CODES.CONTRACT_INCOMPATIBLE)
    }
    expect(routeProducer.readRouteSnapshot.called).to.equal(false)
    expect(stockProducer.readStockSnapshot.called).to.equal(false)
  })

  it('fails closed with the declared producer-unavailable code and writes nothing', async () => {
    const routeProducer = {
      readRouteSnapshot: sinon.stub().rejects(new Error('route producer offline')),
      writeRouteSnapshot: sinon.spy()
    }
    const stockProducer = {
      readStockSnapshot: sinon.stub().resolves(clone(validStockSnapshot)),
      writeStockSnapshot: sinon.spy()
    }

    const error = await captureAsyncError(async () => await loadSnapshots(
      { routeId: ROUTE_ID },
      {
        routeProducer,
        stockProducer,
        routeContractAllowlist: routeAllowlist,
        stockContractAllowlist: stockAllowlist
      }
    ))

    expect(error.code).to.equal(SIMULATION_ERROR_CODES.PRODUCER_UNAVAILABLE)
    expect(routeProducer.writeRouteSnapshot.called).to.equal(false)
    expect(stockProducer.writeStockSnapshot.called).to.equal(false)
    expect(stockProducer.readStockSnapshot.called).to.equal(false)
  })

  it('sanitizes and bounds producer error text in the declared envelope', async () => {
    const marker = 'SENSITIVE-PRODUCER-DETAIL'
    const producerFailure = new Error(`${marker}\u0000${'\u0001'.repeat(2000)}`)
    const routeProducer = { readRouteSnapshot: sinon.stub().rejects(producerFailure) }
    const stockProducer = { readStockSnapshot: sinon.stub().resolves(clone(validStockSnapshot)) }

    const error = await captureAsyncError(async () => await loadSnapshots(
      { routeId: ROUTE_ID },
      {
        routeProducer,
        stockProducer,
        routeContractAllowlist: routeAllowlist,
        stockContractAllowlist: stockAllowlist
      }
    ))
    const envelope = simulationErrorEnvelopeSchema.safeParse({
      code: error.code,
      message: error.message
    })

    expect(error.code).to.equal(SIMULATION_ERROR_CODES.PRODUCER_UNAVAILABLE)
    expect(error.message).to.not.contain(marker)
    expect(error.message.length).to.be.at.most(500)
    expect(envelope.success).to.equal(true)
  })
})
