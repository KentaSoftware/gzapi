import { ObjectId, Types } from 'mongoose'

export interface Product {
  _id: Types.ObjectId
  descripcion: string
  stock: number
  codigoBarra?: String
  peso?: Peso
  bulto?: number
  sabor?: String
  precioCompra?: number
  precioUnitario: number
  precioBulto?: number
  categoria: ObjectId
  marca: ObjectId
  proveedor: ObjectId
  path?: string
  precioDescuento?: number
  NameProveedor?: string,
  NameMarca?: string,
  NameCategoria?: string
  createdAt?: Date
  updatedAt?: Date
}

interface Peso {
  cantidad: number
  unidad: String
}

export interface Categorie {
  descripcion: string
}

export interface Brand {
  descripcion: string
}

export interface Provider {
  descripcion: string
}
