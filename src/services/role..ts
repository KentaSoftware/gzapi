import { Types } from 'mongoose'
import { Role } from '../interfaces/auth.interface'
import RoleModel from '../models/role'

const insertRole = async (item: Role): Promise<Role> => {
  const responseInsert = await RoleModel.create(item)
  return responseInsert
}

const getRolesAll = async (): Promise<Role[]> => {
  const response = await RoleModel.find({ name: { $ne: 'admin' } })
  return response
}

const getRoles = async (skip: number, limit: number): Promise<Role[]> => {
  const response = await RoleModel.find({ name: { $ne: 'admin' } }).skip(skip).limit(limit)
  return response
}

const getRole = async (id: Types.ObjectId): Promise<any> => {
  const response = await RoleModel.findById(id)
  return response
}

const getRoleSearch = async (input: string): Promise<Role[]> => {
  const response = await RoleModel.find({
    name: {
      $regex: input,
      $options: 'i',
      $ne: 'admin'
    }
  })
  return response
}

const qtyRoles = async (): Promise<number> => {
  const response = await RoleModel.countDocuments({ name: { $ne: 'admin' } })
  return response
}

const updateRole = async (id: Types.ObjectId, item: Role): Promise<any> => {
  const response = await RoleModel.findByIdAndUpdate(id, item, { new: true })
  return response
}

const deleteRole = async (id: Types.ObjectId): Promise<any> => {
  const response = await RoleModel.findByIdAndDelete(id)
  return response
}

export { getRole, getRoles, insertRole, updateRole, deleteRole, getRoleSearch, qtyRoles, getRolesAll } 