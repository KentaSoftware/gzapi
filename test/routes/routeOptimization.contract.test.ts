import { expect } from 'chai'
import DeliveryZoneModel from '../../src/models/deliveryZone'
import RoutePlanModel from '../../src/models/routePlan'
import RoutingConfigModel from '../../src/models/routingConfig'
import SaleModel from '../../src/models/sale'
import { routePlanSnapshotSchema, saleDeliverySchema } from '../../src/schemas/routeOptimization'

describe('Route optimization data contracts', () => {
  it('enforces unique zone and singleton configuration indexes', () => {
    const deliveryZoneIndexes = DeliveryZoneModel.schema.indexes()
    const routingConfigIndexes = RoutingConfigModel.schema.indexes()

    expect(deliveryZoneIndexes.some(([keys, options]) => keys.code === 1 && options.name === 'idx_unique_delivery_zone_code' && options.unique === true)).to.equal(true)
    expect(deliveryZoneIndexes.some(([keys, options]) => keys.normalizedName === 1 && options.name === 'idx_unique_delivery_zone_normalized_name' && options.unique === true)).to.equal(true)
    expect(routingConfigIndexes.some(([keys, options]) => keys.key === 1 && options.name === 'idx_unique_routing_config_key' && options.unique === true)).to.equal(true)
  })

  it('accepts complete route-plan snapshots and rejects incomplete snapshots (TC-032)', () => {
    const snapshot = {
      planningDate: new Date('2026-10-04T00:00:00.000Z'),
      zoneSnapshot: { code: 'NORTE', normalizedName: 'norte', name: 'Norte' },
      selectedSaleIds: ['sale-1'],
      depot: { name: 'Main depot', latitude: -34.6, longitude: -58.4 },
      stops: [{ saleId: 'sale-1', sequence: 1, latitude: -34.61, longitude: -58.41 }],
      segments: [{ fromStopSequence: 0, toStopSequence: 1, distanceMeters: 1000, durationSeconds: 300 }],
      metrics: { distanceMeters: 1000, durationSeconds: 300, stopCount: 1 },
      algorithm: { name: 'nearest-neighbor', version: '1.0.0', provider: 'internal' },
      routingConfigRevision: 1,
      warnings: [],
      audit: { createdBy: 'user-1', createdAt: new Date('2026-10-04T10:00:00.000Z') }
    }

    expect(routePlanSnapshotSchema.safeParse(snapshot).success).to.equal(true)
    expect(routePlanSnapshotSchema.safeParse({ ...snapshot, selectedSaleIds: [] }).success).to.equal(false)
  })

  it('indexes route plans for zone/date and creator/date while keeping snapshots immutable (TC-031)', () => {
    const routePlanIndexes = RoutePlanModel.schema.indexes()

    expect(routePlanIndexes.some(([keys, options]) => keys['zoneSnapshot.code'] === 1 && keys.planningDate === 1 && options.name === 'idx_route_plan_zone_date')).to.equal(true)
    expect(routePlanIndexes.some(([keys, options]) => keys['audit.createdBy'] === 1 && keys.createdAt === -1 && options.name === 'idx_route_plan_creator_date')).to.equal(true)
    expect(RoutePlanModel.schema.path('planningDate').options.immutable).to.equal(true)
    expect(RoutePlanModel.schema.path('selectedSaleIds').options.immutable).to.equal(true)
  })

  it('rejects route-plan updates to preserve append-only snapshots', async () => {
    try {
      await RoutePlanModel.updateOne({}, { $set: { warnings: ['recalculated'] } }).exec()
      expect.fail('Expected RoutePlan update to be rejected')
    } catch (error: unknown) {
      expect(error).to.be.an('error')
      expect((error as Error).message).to.equal('Route plans are append-only')
    }
  })

  it('validates delivery states without defaulting historical sales into delivery workflows (TC-013)', async () => {
    const sale = {
      estado: 'Pendiente',
      total: 100,
      user: '507f1f77bcf86cd799439011'
    }

    expect(await SaleModel.validate(sale)).to.not.have.property('delivery')
    expect(saleDeliverySchema.safeParse({ status: 'PENDING', serviceDate: new Date() }).success).to.equal(true)
    expect(saleDeliverySchema.safeParse({ status: 'DELIVERED' }).success).to.equal(false)
    expect(saleDeliverySchema.safeParse({ status: 'DELIVERED', deliveredAt: new Date() }).success).to.equal(true)

    let pendingWithoutClientError: unknown
    try {
      await new SaleModel({
        ...sale,
        delivery: { status: 'PENDING', serviceDate: new Date() }
      }).validate()
    } catch (error: unknown) {
      pendingWithoutClientError = error
    }
    expect(pendingWithoutClientError).to.be.an('error')
  })
})
