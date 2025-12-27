import RoleModel from '../models/role';
import UserModel from '../models/user';
import { encrypt } from '../utils/bcrypt.handle';

export const seedDatabase = async () => {

  console.log('Iniciando seed de la base de datos')

  // Crear permisos básicos
  const permissions = [
    //Usuarios  x
    'create_user',
    'delete_user',
    'update_user',
    'read_user',
    //Roles x
    'create_role',
    'delete_role',
    'update_role',
    'read_role',
    //Productos x
    'create_product',
    'delete_product',
    'update_product',
    'read_product',
    //Clientes x
    'create_client',
    'delete_client',
    'update_client',
    'read_client',
    //Ventas x
    'create_sale',
    'delete_sale',
    'update_sale',
    'read_sale',
    //Compras x
    'create_buy',
    'delete_buy',
    'update_buy',
    'read_buy',
    //Egresos x
    'create_expense',
    'delete_expense',
    'update_expense',
    'read_expense',
    //Datasets x
    'read_dataset',
    //Logs x
    'read_log',
  ];


  // Crear o actualizar rol admin
  const adminRole = await RoleModel.findOne({ name: 'admin' });
  if (!adminRole) {
    // Si no existe el rol admin, crearlo
    await RoleModel.create({
      nickname: 'admin',
      permissions: permissions
    });
  } else {
    // Si existe, verificar y actualizar permisos faltantes
    const missingPermissions = permissions.filter(
      permission => !adminRole.permissions.includes(permission)
    );

    if (missingPermissions.length > 0) {
      adminRole.permissions = [...new Set([...adminRole.permissions, ...missingPermissions])];
      await adminRole.save();
    } else {
    }
  }

  // Crear usuario admin
  const adminUser = await UserModel.findOne({ nickname: 'admin' });
  if (!adminUser) {
    const passHash = await encrypt(process.env.ADMIN_PASSWORD! as string)
    const currentAdminRole = await RoleModel.findOne({ name: 'admin' });

    if (!currentAdminRole) {
      throw new Error('No se pudo encontrar el rol de administrador');
    }

    await UserModel.create({
      nickname: 'admin',
      password: passHash,
      role: currentAdminRole._id
    });
  } else {
    // Verificar si el usuario admin tiene el rol correcto
    const currentAdminRole = await RoleModel.findOne({ name: 'admin' });
    if (currentAdminRole && adminUser.role?.toString() !== currentAdminRole._id.toString()) {
      adminUser.role = currentAdminRole;
      await adminUser.save();
    }
  }
};
