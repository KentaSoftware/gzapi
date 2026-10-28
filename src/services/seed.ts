import RoleModel from '../models/role'
import UserModel from '../models/user'
import { encrypt } from '../utils/bcrypt.handle'

const BASE_PERMISSIONS = [
  'create_user', 'delete_user', 'update_user', 'read_user',
  'create_role', 'delete_role', 'update_role', 'read_role',
  'create_product', 'delete_product', 'update_product', 'read_product',
  'create_client', 'delete_client', 'update_client', 'read_client',
  'create_sale', 'delete_sale', 'update_sale', 'read_sale', 'read_stats',
  'create_buy', 'delete_buy', 'update_buy', 'read_buy',
  'create_expense', 'delete_expense', 'update_expense', 'read_expense',
  'read_dataset',
  'read_log',
  'catalog_read', 'catalog_write',
  'read_cashflow', 'configure_cashflow',
  'confirm_client_location'
]

const PHASE_0_ROLE_GRANTS = [
  {
    name: 'Propietario',
    permissions: [
      'confirm_sale_payment', 'refund_sale', 'confirm_purchase_payment',
      'receive_purchase', 'adjust_stock', 'read_route_plan', 'create_route_plan',
      'confirm_client_location', 'manage_route_config', 'manage_delivery_zone'
    ]
  },
  {
    name: 'Administración',
    permissions: [
      'confirm_sale_payment', 'refund_sale', 'confirm_purchase_payment',
      'receive_purchase', 'adjust_stock', 'read_route_plan', 'create_route_plan',
      'confirm_client_location', 'manage_route_config', 'manage_delivery_zone'
    ]
  },
  {
    name: 'Preventista',
    permissions: ['confirm_sale_payment']
  },
  {
    name: 'Repartidor',
    permissions: ['read_route_plan']
  }
]

const upsertRole = async (name: string, permissions: string[]): Promise<void> => {
  const existing = await RoleModel.findOne({ name })

  if (existing === null) {
    await RoleModel.create({ name, permissions })
    return
  }

  const missing = permissions.filter((permission) => !existing.permissions.includes(permission))
  if (missing.length > 0) {
    existing.permissions = [...new Set([...existing.permissions, ...missing])]
    await existing.save()
  }
}

export const seedDatabase = async (): Promise<void> => {
  console.log('Iniciando seed de la base de datos')

  await upsertRole('admin', BASE_PERMISSIONS)

  for (const grant of PHASE_0_ROLE_GRANTS) {
    await upsertRole(grant.name, grant.permissions)
  }

  const adminUser = await UserModel.findOne({ nickname: 'admin' })

  if (adminUser === null) {
    const configuredAdminPassword = process.env.ADMIN_PASSWORD
    const adminPassword = configuredAdminPassword === undefined || configuredAdminPassword === ''
      ? '123'
      : configuredAdminPassword
    const passHash = await encrypt(adminPassword)
    const adminRole = await RoleModel.findOne({ name: 'admin' })
    if (adminRole === null) {
      throw new Error('No se pudo encontrar el rol de administrador')
    }

    try {
      await UserModel.create({
        nickname: 'admin',
        password: passHash,
        role: adminRole._id
      })
    } catch (error) {
      // Another instance created the admin between our read and write: that is the desired end state.
      if ((error as { code?: number }).code !== 11000) throw error
    }
  } else {
    const adminRole = await RoleModel.findOne({ name: 'admin' })
    if (adminRole !== null && String(adminUser.role) !== String(adminRole._id)) {
      adminUser.role = adminRole
      await adminUser.save()
    }
  }
}
