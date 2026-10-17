import { ObjectId, Types } from 'mongoose'

export const SALE_DELIVERY_STATUS = {
  PENDING: 'PENDING',
  DELIVERED: 'DELIVERED'
} as const

export type SaleDeliveryStatus = (typeof SALE_DELIVERY_STATUS)[keyof typeof SALE_DELIVERY_STATUS]

export interface SaleDelivery {
  status: SaleDeliveryStatus
  serviceDate?: Date
  deliveredAt?: Date
  notes?: string
}

export interface Sale {
  _id: Types.ObjectId
  estado: string
  user: ObjectId
  cliente: string
  total: number
  createdAt: string
  itemsSale: ItemSale[]
  porcentaje?: number
  idCliente?: ObjectId
  paidAt?: Date
  delivery?: SaleDelivery
}

export interface ItemSale {
  _id?: Types.ObjectId
  idVenta: Types.ObjectId
  idProducto: Types.ObjectId
  cantidad: number
  total: number
  estado: boolean
  descripcion?: string
  precioUnitario: number
  precio?: number
}
