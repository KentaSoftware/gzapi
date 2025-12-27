import { Types } from "mongoose";

export interface Log {
    _id?: Types.ObjectId
    idColeccion: Types.ObjectId
    accion: string
    coleccion: string
    userId?: Types.ObjectId
    changedFields?: Record<string, { before: any; after: any }>
    metadata?: Record<string, any>
    createdAt?: Date
}