import { ObjectId, Types } from 'mongoose'

export interface Buy {
  _id?: Types.ObjectId
  estado: string
  user: ObjectId
  proveedor: string
  total: Number
  itemsBuy: ItemBuy[]
  fecha?: Date
  docNumber?: string
  fingerprint?: string
}

export interface ItemBuy {
  _id?: Types.ObjectId
  idBuy: Types.ObjectId
  idProducto: Types.ObjectId
  cantidad: Number
  total: Number
  precio?: number
  estado: boolean
}
