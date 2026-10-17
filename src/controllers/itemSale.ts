import { Request, Response } from 'express'
import { emitSocket } from '../socket'
import { handleHttp } from '../utils/error.handle'
import { JwtPayload } from 'jsonwebtoken'
import { Types } from 'mongoose'
import { deleteItemsSale, getItemSale, getItemSales, getListBuyAvg, getListBuyByDateRange, insertItemSale, updateItemsSale } from '../services/itemSale'

interface RequestExt extends Request {
  user?: string | JwtPayload | undefined | any
}

const postItem = async ({ body }: Request, res: Response): Promise<void> => {
  try {
    const response = await insertItemSale(body)
    emitSocket('itemSale', {
      action: 'create',
      data: response
    })
    res.send(response)
  } catch (e) {
    handleHttp(res, 'ERROR_CREATE_ITEM_SALE', e)
  }
}

const getItem = async ({ params }: RequestExt, res: Response): Promise<void> => {
  try {
    const { id } = params
    const response = await getItemSale(new Types.ObjectId(id))
    res.send(response)
  } catch (e) {
    handleHttp(res, 'ERROR_GET_ITEM_SALE_BY_ID', e)
  }
}

const getItems = async (_: RequestExt, res: Response): Promise<void> => {
  try {
    const response = await getItemSales()
    res.send(response)
  } catch (e) {
    handleHttp(res, 'ERROR_GET_ITEMS_SALE_LIST', e)
  }
}

const deleteItem = async ({ params }: RequestExt, res: Response): Promise<void> => {
  try {
    const { id } = params
    const response = await deleteItemsSale(new Types.ObjectId(id))
    res.send(response)
  } catch (e) {
    handleHttp(res, 'ERROR_DELETE_ITEM_SALE', e)
  }
}

const patchItem = async ({ params, body }: RequestExt, res: Response): Promise<void> => {
  try {
    const { id } = params
    const response = await updateItemsSale(new Types.ObjectId(id), body)
    res.send(response)
  } catch (e) {
    handleHttp(res, 'ERROR_UPDATE_ITEM_SALE', e)
  }
}

const getListBuyByDateRangeCtrl = async ({ params }: RequestExt, res: Response): Promise<void> => {
  try {
    const { start, end, prov } = params
    const response = await getListBuyByDateRange(start, end, prov)
    res.send(response)
  } catch (e) {
    handleHttp(res, 'ERROR_GET_LISTBUY')
  }
}

const getListBuyAvgCtrl = async ({ params }: RequestExt, res: Response): Promise<void> => {
  try {
    const { prov } = params
    const response = await getListBuyAvg(prov)
    res.send(response)
  } catch (e) {
    handleHttp(res, 'ERROR_GET_LISTBUYAVG')
  }
}

export { postItem, getItem, getItems, deleteItem, patchItem, getListBuyByDateRangeCtrl, getListBuyAvgCtrl }
