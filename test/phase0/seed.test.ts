import { expect } from 'chai'
import mongoose from 'mongoose'
import RoleModel from '../../src/models/role'
import UserModel from '../../src/models/user'
import ItemSaleModel from '../../src/models/itemSale'
import ProductModel from '../../src/models/product'
import { seedDatabase } from '../../src/services/seed'
import { verified } from '../../src/utils/bcrypt.handle'
import { seed as seedRoutePlanFixtures } from '../../migrations/route-plan-002-seed-test-data'

const TEST_DB_URI = 'mongodb://localhost:27017/gzapi_phase0_test'
const ROUTE_TEST_DB_URI = 'mongodb://127.0.0.1:27017/test_route_plan'

const PHASE_0_GRANTS = {
  Propietario: ['confirm_sale_payment', 'refund_sale', 'confirm_purchase_payment', 'receive_purchase', 'adjust_stock', 'read_route_plan', 'create_route_plan', 'confirm_client_location', 'manage_route_config', 'manage_delivery_zone'],
  Administración: ['confirm_sale_payment', 'refund_sale', 'confirm_purchase_payment', 'receive_purchase', 'adjust_stock', 'read_route_plan', 'create_route_plan', 'confirm_client_location', 'manage_route_config', 'manage_delivery_zone'],
  Preventista: ['confirm_sale_payment'],
  Repartidor: ['read_route_plan']
}

const EXPECTED_ROLE_NAMES = ['Administración', 'Preventista', 'Propietario', 'Repartidor', 'admin']
const PHASE_0_PERMISSIONS = [...new Set(Object.values(PHASE_0_GRANTS).flat())]
const initialAdminPassword = process.env.ADMIN_PASSWORD

const stringAscending = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0

async function withAdminPassword (password: string, action: () => Promise<void>): Promise<void> {
  const previousPassword = process.env.ADMIN_PASSWORD
  process.env.ADMIN_PASSWORD = password
  try {
    await action()
  } finally {
    if (previousPassword === undefined) {
      delete process.env.ADMIN_PASSWORD
    } else {
      process.env.ADMIN_PASSWORD = previousPassword
    }
  }
}

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
    if (initialAdminPassword === undefined) {
      delete process.env.ADMIN_PASSWORD
    } else {
      process.env.ADMIN_PASSWORD = initialAdminPassword
    }
  })

  it('creates the admin user with the default password when ADMIN_PASSWORD is empty', async () => {
    await clearCollections()

    await withAdminPassword('', async () => {
      await seedDatabase()
      const admin = await UserModel.findOne({ nickname: 'admin' }).lean()
      expect(admin).to.not.equal(null)
      if (admin !== null) {
        expect(await verified('123', admin.password)).to.equal(true)
      }
    })
  })

  it('creates the admin user with the explicit ADMIN_PASSWORD value', async () => {
    await clearCollections()
    const explicitPassword = 'phase0-explicit-admin-password'

    await withAdminPassword(explicitPassword, async () => {
      await seedDatabase()
      const admin = await UserModel.findOne({ nickname: 'admin' }).lean()
      expect(admin).to.not.equal(null)
      if (admin !== null) {
        expect(await verified(explicitPassword, admin.password)).to.equal(true)
      }
    })
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
    expect(adminPerms).to.include.members(PHASE_0_PERMISSIONS)
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
    expect(adminPerms).to.include.members(PHASE_0_PERMISSIONS)

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

describe('Route plan fixture item seed idempotency', () => {
  before(async () => {
    await mongoose.connect(ROUTE_TEST_DB_URI)
    await mongoose.connection.dropDatabase()
    await mongoose.disconnect()
  })

  after(async () => {
    await mongoose.connect(ROUTE_TEST_DB_URI)
    await mongoose.connection.dropDatabase()
    await mongoose.disconnect()
  })

  it('seeds active item sales once per route sale with stable product and unit counts', async () => {
    const first = await seedRoutePlanFixtures()
    expect(first.summary.sales.inserted).to.equal(34)
    expect(first.summary.itemSales.inserted).to.equal(34)
    expect(first.summary.products.inserted).to.equal(1)

    await mongoose.connect(ROUTE_TEST_DB_URI)
    const firstItems = await ItemSaleModel.find({ estado: true }).lean()
    expect(firstItems).to.have.length(34)
    expect(new Set(firstItems.map((item) => String(item.idVenta))).size).to.equal(34)
    expect(firstItems.reduce((total, item) => total + item.cantidad, 0)).to.equal(67)
    expect(await ProductModel.countDocuments({ codigoBarra: 'ROUTE-TEST-PRODUCT-001' })).to.equal(1)
    await mongoose.disconnect()

    const second = await seedRoutePlanFixtures()
    expect(second.summary.sales.updated).to.equal(34)
    expect(second.summary.itemSales.updated).to.equal(34)
    expect(second.summary.products.updated).to.equal(1)

    await mongoose.connect(ROUTE_TEST_DB_URI)
    const secondItems = await ItemSaleModel.find({ estado: true }).lean()
    expect(secondItems).to.have.length(34)
    expect(new Set(secondItems.map((item) => String(item.idVenta))).size).to.equal(34)
    expect(secondItems.reduce((total, item) => total + item.cantidad, 0)).to.equal(67)
    await mongoose.disconnect()
  })
})
