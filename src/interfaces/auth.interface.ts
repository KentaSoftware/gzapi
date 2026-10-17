
export interface Auth {
  nickname: string
  password: string
}

export interface AuthWithToken {
  token: string
  nickname: string
}

export interface Role {
  _id: string
  name: string
  description?: string
  permissions: string[]
  isActive: boolean
}

export interface User {
  _id: string
  nickname: string
  email?: string
  password: string
  role: Role
  nameRole: string
  createdAt: Date
  updatedAt: Date
  isActive: boolean
}
