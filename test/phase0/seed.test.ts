import { expect } from 'chai'
import mongoose from 'mongoose'
import RoleModel from '../../src/models/role'
import UserModel from '../../src/models/user'
import { seedDatabase } from '../../src/services/seed'

const TEST_DB_URI = 'mongodb://localhost:27017/gzapi_phase0_test'

const PHASE_0_GRANTS = {
  Propietario: ['confirm_sale_payment', 'refund_sale', 'confirm_purchase_payment', 'receive_purchase', 'adjust_stock', 'read_route_plan'],
  Administración: ['confirm_sale_payment', 'refund_sale', 'confirm_purchase_payment', 'receive_purchase', 'adjust_stock', 'read_route_plan'],
  Preventista: ['confirm_sale_payment'],
  Repartidor: ['read_route_plan']
}

const EXPECTED_ROLE_NAMES = ['Administración', 'Preventista', 'Propietario', 'Repartidor', 'admin']
const PHASE_0_PERMISSIONS = [...new Set(Object.values(PHASE_0_GRANTS).flat())]

const stringAscending = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0

async function clearCollections (): Promise<void> {
  await RoleModel.deleteMany({})
  await UserModel.deleteMany({})
}

async function roleNames (): Promise<string[]> {
  const roles = await RoleModel.find().lean()
  return roles.map((role) => role.name).sort(stringAscending)
}

async function permissionsOf (name: string): Promise<string[]> {
  const role = await RoleModel.findOne({ name }).lean()
  return ((role?.permissions) ?? []).slice().sort(stringAscending)
}

async function snapshot (): Promise<Record<string, string[]>> {
  const roles = await RoleModel.find().lean()
  const result: Record<string, string[]> = {}
  for (const role of roles) {
    result[role.name] = (role.permissions ?? []).slice().sort(stringAscending)
  }
  return result
}

describe('Phase 0 — role seed idempotency', () => {
  before(async () => {
    process.env.ADMIN_PASSWORD = 'phase0-test-password'
    await mongoose.connect(TEST_DB_URI)
  })

  after(async () => {
    const dbName = mongoose.connection.db?.databaseName
    if (dbName?.endsWith('_test') === true) {
      await mongoose.connection.dropDatabase()
    }
    await mongoose.disconnect()
  })

  it('S-06a: seed on an empty DB creates admin plus the four business roles exactly once', async () => {
    await clearCollections()

    await seedDatabase()
    await seedDatabase()

    const names = await roleNames()
    expect(names).to.deep.equal(EXPECTED_ROLE_NAMES)

    for (const name of names) {
      const count = await RoleModel.countDocuments({ name })
      expect(count).to.equal(1)
    }

    for (const name of Object.keys(PHASE_0_GRANTS)) {
      expect(await permissionsOf(name)).to.deep.equal([...PHASE_0_GRANTS[name]].sort(stringAscending))
    }

    const adminPerms = await permissionsOf('admin')
    expect(adminPerms.length).to.be.greaterThan(0)
    expect(adminPerms).to.not.include.members(PHASE_0_PERMISSIONS)
  })

  it('S-06b: seed on a pre-existing DB appends grants without removing existing permissions', async () => {
    await clearCollections()

    await RoleModel.create({ name: 'admin', permissions: ['read_user', 'custom_admin_perm'] })
    await RoleModel.create({ name: 'Propietario', permissions: ['confirm_sale_payment', 'custom_owner_perm'] })

    await seedDatabase()
    await seedDatabase()

    const names = await roleNames()
    expect(names).to.deep.equal(EXPECTED_ROLE_NAMES)

    for (const name of names) {
      const count = await RoleModel.countDocuments({ name })
      expect(count).to.equal(1)
    }

    const adminPerms = await permissionsOf('admin')
    expect(adminPerms).to.include('custom_admin_perm')
    expect(adminPerms).to.include('read_user')
    expect(adminPerms).to.not.include.members(PHASE_0_PERMISSIONS)

    const ownerPerms = await permissionsOf('Propietario')
    expect(ownerPerms).to.include('custom_owner_perm')

    for (const name of Object.keys(PHASE_0_GRANTS)) {
      const perms = await permissionsOf(name)
      for (const grant of PHASE_0_GRANTS[name]) {
        expect(perms).to.include(grant)
      }
    }
  })

  it('S-06: seed twice on empty and existing DBs is stable and duplicate-free', async () => {
    await clearCollections()
    await seedDatabase()
    const emptyFirst = await snapshot()
    await seedDatabase()
    const emptySecond = await snapshot()
    expect(emptySecond).to.deep.equal(emptyFirst)

    await clearCollections()
    await RoleModel.create({ name: 'Repartidor', permissions: ['read_route_plan', 'legacy_delivery_perm'] })
    await seedDatabase()
    const existingFirst = await snapshot()
    await seedDatabase()
    const existingSecond = await snapshot()
    expect(existingSecond).to.deep.equal(existingFirst)

    for (const name of EXPECTED_ROLE_NAMES) {
      const count = await RoleModel.countDocuments({ name })
      expect(count).to.equal(1)
    }
  })
})
