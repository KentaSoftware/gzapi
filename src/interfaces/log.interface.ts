import { Types } from "mongoose";

export interface Log {
    _id: Types.ObjectId
    idColeccion: Types.ObjectId
    accion: string
    coleccion: string
    user: Types.ObjectId
    createdAt: Date
    valueBefore?: Object
}