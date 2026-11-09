import { expect } from 'chai'
import sinon from 'sinon'
import RoleModel from '../../src/models/role'
import UserModel from '../../src/models/user'
import * as simulation from '../../src/services/simulation'
import { seedDatabase } from '../../src/services/seed'

describe('route admin seed grants', () => {
  afterEach(() => { sinon.restore() })

  it('creates a new admin role with route permissions and a new admin user', async () => {
    const roles = new Map<string, { _id: string, permissions: string[] }>()
    sinon.stub(RoleModel, 'findOne').callsFake((query: unknown) => Promise.resolve(roles.get((query as { name: string }).name) ?? null) as never)
    sinon.stub(RoleModel, 'create').callsFake((value: unknown) => {
      const role = value as { name: string, permissions: string[] }
      roles.set(role.name, { _id: role.name, permissions: role.permissions })
      return Promise.resolve(role) as never
    })
    sinon.stub(UserModel, 'findOne').resolves(null)
    const createdUser: unknown = {}
    const createUser = sinon.stub(UserModel, 'create').resolves(createdUser as never)
    sinon.stub(simulation, 'seedSimulationDemoFixtures').resolves()
    await seedDatabase({ seedDemoFixtures: async () => {} })
    expect(roles.get('admin')?.permissions).to.include.members(['read_route_plan', 'create_route_plan', 'manage_route_config', 'manage_delivery_zone', 'confirm_client_location'])
    expect(createUser.calledOnce).to.equal(true)
    expect((createUser.firstCall.args[0] as { role: string }).role).to.equal('admin')
  })

  it('adds route grants idempotently without replacing custom grants or password', async () => {
    const roles = new Map<string, { _id: string, permissions: string[], save: () => Promise<void> }>()
    const admin = { _id: 'admin-role', permissions: ['custom_grant'], save: async () => {} }
    roles.set('admin', admin)
    const user = { role: 'admin-role', password: 'existing-hash', save: sinon.spy() }
    sinon.stub(RoleModel, 'findOne').callsFake((query: unknown) => Promise.resolve(roles.get((query as { name: string }).name) ?? null) as never)
    sinon.stub(RoleModel, 'create').callsFake((value: unknown) => {
      const role = value as { name: string, permissions: string[] }
      roles.set(role.name, { _id: role.name, permissions: role.permissions, save: async () => {} })
      return Promise.resolve(role) as never
    })
    sinon.stub(UserModel, 'findOne').resolves(user as never)
    sinon.stub(simulation, 'seedSimulationDemoFixtures').resolves()
    await seedDatabase({ seedDemoFixtures: async () => {} })
    await seedDatabase({ seedDemoFixtures: async () => {} })
    for (const permission of ['read_route_plan', 'create_route_plan', 'manage_route_config', 'manage_delivery_zone', 'confirm_client_location', 'custom_grant']) {
      expect(admin.permissions.filter((value) => value === permission)).to.have.length(1)
    }
    expect(user.password).to.equal('existing-hash')
    expect(user.save.called).to.equal(false)
    expect(roles.get('Repartidor')?.permissions).to.include('read_route_plan')
    expect(admin.permissions).not.to.include('simulation:read')
  })
})
