import { Types } from 'mongoose'
import { User } from '../interfaces/auth.interface'
import UserModel from '../models/user'
import { encrypt } from '../utils/bcrypt.handle'

interface UserResponse {
  nickname: string
  role: string
  nameRole: string
  isActive?: boolean
}

const getAllUsers = async (): Promise<any[]> => {
  // Excluimos los campos 'password' y 'role' usando la proyección de Mongoose
  const response = await UserModel.find({}, { password: 0, role: 0 })
  return response
}

const getUserSearch = async (input: string): Promise<UserResponse[]> => {
  const query: any = {
  }

  if (input !== '') {
    query.nickname = {
      $regex: input,
      $options: 'i'
    }
  }

  const response = await UserModel.aggregate(
    [
      {
        $match: query
      },
      {
        $lookup: {
          from: 'roles',
          localField: 'role',
          foreignField: '_id',
          as: 'role'
        }
      },
      {
        $unwind: '$role'
      },
      {
        $lookup: {
          from: 'sales',
          localField: '_id',
          foreignField: 'user',
          as: 'sales'
        }
      },
      {
        $addFields: {
          currentMonthSales: {
            $filter: {
              input: '$sales',
              as: 'sale',
              cond: {
                $and: [
                  {
                    $eq: [{ $month: '$$sale.createdAt' }, { $month: new Date() }]
                  },
                  {
                    $eq: [{ $year: '$$sale.createdAt' }, { $year: new Date() }]
                  }
                ]
              }
            }
          }
        }
      },
      {
        $addFields: {
          qtySaleUser: { $size: '$currentMonthSales' },
          gain: {
            $multiply: [
              {
                $sum: {
                  $map: {
                    input: '$currentMonthSales',
                    as: 'sale',
                    in: '$$sale.total'
                  }
                }
              },
              0.05
            ]
          }
        }
      },
      {
        $project: {
          _id: 1,
          nickname: 1,
          role: '$role._id',
          nameRole: '$role.name',
          qtySaleUser: 1,
          gain: 1,
          isActive: 1
        }
      },
      {
        $sort: { nickname: 1 }
      }
    ]
  )

  return response
}

const getUsers = async (skip: number, limit: number): Promise<UserResponse[]> => {
  const response = await UserModel.aggregate(
    [
      {
        $lookup: {
          from: 'roles',
          localField: 'role',
          foreignField: '_id',
          as: 'role'
        }
      },
      {
        $unwind: {
          path: '$role',
          preserveNullAndEmptyArrays: true // importante para que no filtre usuarios sin rol
        }
      },
      {
        $lookup: {
          from: 'sales',
          localField: '_id',
          foreignField: 'user',
          as: 'sales'
        }
      },
      {
        $addFields: {
          currentMonthSales: {
            $filter: {
              input: '$sales',
              as: 'sale',
              cond: {
                $and: [
                  {
                    $eq: [{ $month: '$$sale.createdAt' }, { $month: new Date() }]
                  },
                  {
                    $eq: [{ $year: '$$sale.createdAt' }, { $year: new Date() }]
                  }
                ]
              }
            }
          }
        }
      },
      {
        $addFields: {
          qtySaleUser: { $size: '$currentMonthSales' },
          gain: {
            $multiply: [
              {
                $ifNull: [
                  {
                    $sum: {
                      $map: {
                        input: '$currentMonthSales',
                        as: 'sale',
                        in: '$$sale.total'
                      }
                    }
                  },
                  0
                ]
              },
              0.05
            ]
          }
        }
      },
      {
        $project: {
          _id: 1,
          nickname: 1,
          role: '$role._id',
          nameRole: '$role.name',
          qtySaleUser: 1,
          gain: 1,
          isActive: 1
        }
      }
    ]
  ).skip(skip).limit(limit)

  return response
}

const qtyUsers = async (): Promise<any> => {
  const response = await UserModel.countDocuments()
  return response
}

const getUser = async (id: Types.ObjectId): Promise<UserResponse | null> => {
  const response = await UserModel.findById(id, { nickname: 1, role: 1, _id: 0, isActive: 1 }).populate('role')
  if (response == null) return null
  return {
    nickname: response.nickname,
    role: response.role._id,
    nameRole: response.role.name,
    isActive: response.isActive
  }
}

const updateUser = async (id: Types.ObjectId, item: Partial<User>): Promise<any> => {
  let updateData = { ...item }

  if (item.password && item.password !== '') {
    updateData.password = await encrypt(item.password)
  } else {
    const { password, ...updateDataWithoutPassword } = updateData
    updateData = updateDataWithoutPassword
  }
  const response: any = await UserModel.findByIdAndUpdate(
    id,
    updateData,
    { new: true }
  )

  if (!response) return null

  const user = {
    ...response._doc,
    _id: response._id,
    password: undefined, // Nunca devolvemos la contraseña
    nameRole: typeof item.role === 'object' ? item.role?.name : undefined,
    role: typeof item.role === 'object' ? item.role?._id : item.role,
    isActive: item.isActive,
    nickname: item.nickname,
    email: ''
  }

  return user
}

const deleteUser = async (id: Types.ObjectId): Promise<any> => {
  const response = await UserModel.findByIdAndDelete(id)
  return response
}

export { getUser, getUsers, updateUser, deleteUser, getUserSearch, qtyUsers, getAllUsers }
