import { Server } from 'socket.io'
import {
  ClientToServerEvents,
  InterServerEvents,
  ServerToClientEvents,
  ServerType,
  SocketData
} from '../src/interfaces/Socket.types'

let io: ServerType | undefined

export function init (httpServer: any): ServerType {
  io = new Server<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>(httpServer, {
    // @ts-expect-error
    method: 'GET',
    cors: {
      origin: '*'
    }
  })
  return io
}

export function getIO (): ServerType {
  if (io === undefined) {
    throw new Error('Socket IO not defined!')
  }
  return io
}

export function emitSocket (type: string, params: Object): void {
  try {
    /* if (params.res._id) {
      controller.addReg({
        coleccion: type,
        accion: params.action,
        idColeccion: params.res._id,
        fechaHora: fechaHora
      })
    } */
    // @ts-expect-error
    getIO().emit(type, params)
  } catch (error) {
    console.log(error)
  }
}
