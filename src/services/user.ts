import { Types } from 'mongoose'
import { User } from '../interfaces/auth.interface'
import UserModel from '../models/user'
import { encrypt } from '../utils/bcrypt.handle';

interface UserResponse {
  nickname: string;
  role: string;
  nameRole: string;
}


const getUserSearch = async (input: string): Promise<UserResponse[]> => {

  let query: any = {
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
          gain: 1
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
  console.log('skip getUsers service', skip, limit)
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
          gain: 1
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
  const response = await UserModel.findById(id, { nickname: 1, role: 1, _id: 0 }).populate('role')
  if (!response) return null
  return {
    nickname: response.nickname,
    role: response.role._id,
    nameRole: response.role.name
  }
}

const updateUser = async (id: Types.ObjectId, item: Partial<User>): Promise<any> => {
  let updateData = { ...item };

  console.log('updateData1', updateData, id)

  if (item.password && item.password !== '') {
    console.log('cambie password')
    updateData.password = await encrypt(item.password);
  } else {
    console.log('no cambie password')
    const { password, ...updateDataWithoutPassword } = updateData;
    updateData = updateDataWithoutPassword;
  }

  console.log('updateData2', updateData)

  const response: any = await UserModel.findByIdAndUpdate(
    id,
    updateData,
    { new: true }
  );

  console.log('response 123', response)

  if (!response) return null;

  const user = {
    ...response._doc,
    _id: response._id,
    password: undefined, // Nunca devolvemos la contraseña
    nameRole: typeof item.role === 'object' ? item.role?.name : undefined,
    role: typeof item.role === 'object' ? item.role?._id : item.role,
    isActive: item.isActive,
    nickname: item.nickname,
    email: ''
  };

  return user;
}

const deleteUser = async (id: Types.ObjectId): Promise<any> => {
  const response = await UserModel.findByIdAndDelete(id)
  return response
}

export { getUser, getUsers, updateUser, deleteUser, getUserSearch, qtyUsers } 