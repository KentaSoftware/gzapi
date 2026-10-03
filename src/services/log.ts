import { Log } from '../interfaces/log.interface'
import LogModel from '../models/log'

const insertLog = async (item: Log): Promise<Log> => {
  const responseInsert = await LogModel.create(item)
  return responseInsert
}

const getLogs = async (skip: number, limit: number): Promise<Log[]> => {
  const response = await LogModel.find({}).skip(skip).limit(limit)
  return response
}

export { insertLog, getLogs }
