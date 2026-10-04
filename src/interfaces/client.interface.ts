import { Types } from 'mongoose'

export interface City {
  _id: Types.ObjectId
  descripcion: string
}

export interface Client {
  _id: Types.ObjectId
  nombreCompleto: string
  idCiudad: Types.ObjectId
  direccion?: string
  telefonos?: [number]
  lat?: number
  lng?: number
  address?: string
}
