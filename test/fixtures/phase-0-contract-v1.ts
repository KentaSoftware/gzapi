import BuyModel from '../../src/models/buy'
import CommercialFactModel from '../../src/models/commercialFact'
import ItemBuyModel from '../../src/models/itemBuy'
import RoleModel from '../../src/models/role'
import SaleModel from '../../src/models/sale'
import UserModel from '../../src/models/user'

const PHASE0_CONTRACT_V1 = {
  version: 'phase-0-contract-v1',
  ids: {
    ownerRole: '650000000000000000000001',
    adminRole: '650000000000000000000002',
    salespersonRole: '650000000000000000000003',
    driverRole: '650000000000000000000004',
    ownerUser: '650000000000000000000011',
    adminUser: '650000000000000000000012',
    salespersonUser: '650000000000000000000013',
    driverUser: '650000000000000000000014',
    sale: '650000000000000000000021',
    otherSale: '650000000000000000000022',
    buy: '650000000000000000000031',
    buyItem: '650000000000000000000041',
    product: '650000000000000000000051'
  },
  businessDate: '2026-01-15T12:00:00.000Z',
  saleTotal: 1000,
  buyTotal: 800,
  buyQuantity: 20
} as const

const ALL_COMMERCIAL_PERMISSIONS = [
  'confirm_sale_payment',
  'refund_sale',
  'confirm_purchase_payment',
  'receive_purchase',
  'adjust_stock',
  'read_route_plan'
]

const resetPhase0ContractV1 = async (): Promise<void> => {
  await CommercialFactModel.deleteMany({})
  await ItemBuyModel.deleteMany({})
  await BuyModel.deleteMany({})
  await SaleModel.deleteMany({})
  await UserModel.deleteMany({})
  await RoleModel.deleteMany({})
}

const seedPhase0ContractV1 = async (): Promise<typeof PHASE0_CONTRACT_V1> => {
  await resetPhase0ContractV1()

  const { ids } = PHASE0_CONTRACT_V1
  await RoleModel.create([
    { _id: ids.ownerRole, name: 'Propietario', permissions: ALL_COMMERCIAL_PERMISSIONS, isActive: true },
    { _id: ids.adminRole, name: 'Administración', permissions: ALL_COMMERCIAL_PERMISSIONS, isActive: true },
    { _id: ids.salespersonRole, name: 'Preventista', permissions: ['confirm_sale_payment'], isActive: true },
    { _id: ids.driverRole, name: 'Repartidor', permissions: [], isActive: true }
  ])

  await UserModel.create([
    { _id: ids.ownerUser, nickname: 'fixture-owner', password: 'fixture-only', role: ids.ownerRole, isActive: true },
    { _id: ids.adminUser, nickname: 'fixture-admin', password: 'fixture-only', role: ids.adminRole, isActive: true },
    { _id: ids.salespersonUser, nickname: 'fixture-salesperson', password: 'fixture-only', role: ids.salespersonRole, isActive: true },
    { _id: ids.driverUser, nickname: 'fixture-driver', password: 'fixture-only', role: ids.driverRole, isActive: true }
  ])

  await SaleModel.create([
    { _id: ids.sale, estado: 'Pendiente', total: PHASE0_CONTRACT_V1.saleTotal, user: ids.salespersonUser },
    { _id: ids.otherSale, estado: 'Pendiente', total: PHASE0_CONTRACT_V1.saleTotal, user: ids.ownerUser }
  ])
  await BuyModel.create({ _id: ids.buy, estado: 'Pendiente', total: PHASE0_CONTRACT_V1.buyTotal, user: ids.adminUser })
  await ItemBuyModel.create({
    _id: ids.buyItem,
    idBuy: ids.buy,
    idProducto: ids.product,
    cantidad: PHASE0_CONTRACT_V1.buyQuantity,
    total: PHASE0_CONTRACT_V1.buyTotal,
    precio: PHASE0_CONTRACT_V1.buyTotal / PHASE0_CONTRACT_V1.buyQuantity,
    estado: true
  })

  return PHASE0_CONTRACT_V1
}

export {
  ALL_COMMERCIAL_PERMISSIONS,
  PHASE0_CONTRACT_V1,
  resetPhase0ContractV1,
  seedPhase0ContractV1
}
