import { expect } from 'chai'
import sinon from 'sinon'
import UserModel from '../../src/models/user'
import VehicleModel from '../../src/models/vehicle'
import RoutePlanModel from '../../src/models/routePlan'
import RoutePlanOperationalModel from '../../src/models/routePlanOperational'
import { getDashboard } from '../../src/services/routeDashboard'

describe('dashboard assignment labels', () => {
  afterEach(() => { sinon.restore() })
  it('uses authorized effective assignment IDs and projects only labels without modifying snapshots', async () => {
    const driver = '507f1f77bcf86cd799439011'
    const vehicle = '507f1f77bcf86cd799439012'
    const snapshot = { _id: '507f1f77bcf86cd799439013', assignments: { driverId: driver, vehicleId: '507f1f77bcf86cd799439014' }, zoneSnapshot: { code: 'N' }, selectedSaleIds: [], stops: [], metrics: { distanceMeters: 1, durationSeconds: 2 }, warnings: [] }
    const before = JSON.stringify(snapshot)
    sinon.stub(RoutePlanModel, 'aggregate').resolves([{ ...snapshot, operational: [{ snapshotId: snapshot._id, status: 'PENDING', assignments: { driverId: driver, vehicleId: vehicle } }] }] as never)
    sinon.stub(RoutePlanOperationalModel, 'find').throws(new Error('joined projection must be reused'))
    const userQuery: unknown = { lean: async () => [{ _id: driver, nickname: 'Driver', password: 'secret' }] }
    const vehicleQuery: unknown = { lean: async () => [{ _id: vehicle, code: 'VAN-1' }] }
    const users = sinon.stub(UserModel, 'find').returns(userQuery as never)
    const vehicles = sinon.stub(VehicleModel, 'find').returns(vehicleQuery as never)
    const result = await getDashboard({}, { driverId: driver })
    expect(result.routes[0].assignments).to.deep.equal({ driverId: driver, vehicleId: vehicle, driverName: 'Driver', vehicleName: 'VAN-1' })
    expect(JSON.stringify(users.firstCall.args)).not.to.include('507f1f77bcf86cd799439014')
    expect(users.firstCall.args[1]).to.deep.equal({ _id: 1, nickname: 1 })
    expect(vehicles.firstCall.args[1]).to.deep.equal({ _id: 1, code: 1 })
    expect(JSON.stringify(snapshot)).to.equal(before)
  })

  it('omits missing labels and never resurrects assignments from an unassigned projection', async () => {
    const driver = '507f1f77bcf86cd799439011'
    const base = { zoneSnapshot: { code: 'N' }, selectedSaleIds: [], stops: [], metrics: { distanceMeters: 1, durationSeconds: 2 }, warnings: [] }
    sinon.stub(RoutePlanModel, 'aggregate').resolves([
      { ...base, _id: '507f1f77bcf86cd799439013', assignments: { driverId: driver }, operational: [] },
      { ...base, _id: '507f1f77bcf86cd799439014', assignments: { driverId: driver }, operational: [{ snapshotId: '507f1f77bcf86cd799439014', status: 'PENDING', assignments: {} }] }
    ] as never)
    const empty: unknown = { lean: async () => [] }
    sinon.stub(UserModel, 'find').returns(empty as never)
    sinon.stub(VehicleModel, 'find').throws(new Error('Unexpected vehicle lookup'))
    const result = await getDashboard({}, { driverId: driver })
    expect(result.routes[0].assignments).to.deep.equal({ driverId: driver })
    expect(result.routes[1].assignments).to.deep.equal({})
  })
})
