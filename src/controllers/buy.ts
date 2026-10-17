import { Request, Response } from 'express'
import { emitSocket } from '../socket'
import { handleHttp } from '../utils/error.handle'
import { JwtPayload } from 'jsonwebtoken'
import { Types } from 'mongoose'
import { getBuy, getBuys, getBuysLimit, insertBuy, qtyBuy, updateBuy } from '../services/buy'
import { getItemBuy, insertItemBuy, updateItemsBuy } from '../services/itemBuy'
import { updateProduct } from '../services/product'
import { ItemBuy } from '../interfaces/buy.interface'
import ExpenseService from '../services/expense'
import { RELATED_KIND } from '../interfaces/expense.interface'
import BuyModel from '../models/buy'
import { getBuyStatsByUser, getBuyStatsOverview } from '../services/buyStats'
import { parseSaleStatsRequest } from '../utils/statsDateRange'
import { STATS_SCOPE, type StatsValidationFailure } from '../interfaces/saleStats.interface'

interface RequestExt extends Request {
  user?: string | JwtPayload | undefined | any
}

const sendStatsValidationError = (res: Response, failure: StatsValidationFailure): void => {
  res.status(failure.status)
  res.send(failure.error)
}

const getBuyStatsByUserController = async ({ body }: RequestExt, res: Response): Promise<void> => {
  const parsedRequest = parseSaleStatsRequest(body, {
    allowUserId: true,
    scope: STATS_SCOPE.BY_USER
  })

  if (!parsedRequest.ok) {
    sendStatsValidationError(res, parsedRequest)
    return
  }

  try {
    const response = await getBuyStatsByUser(parsedRequest.value)
    res.send(response)
  } catch (e) {
    handleHttp(res, 'ERROR_GET_BUY_STATS_BY_USER', e)
  }
}

const getBuyStatsOverviewController = async ({ body }: RequestExt, res: Response): Promise<void> => {
  const parsedRequest = parseSaleStatsRequest(body, {
    allowUserId: false,
    scope: STATS_SCOPE.OVERVIEW
  })

  if (!parsedRequest.ok) {
    sendStatsValidationError(res, parsedRequest)
    return
  }

  try {
    const response = await getBuyStatsOverview(parsedRequest.value)
    res.send(response)
  } catch (e) {
    handleHttp(res, 'ERROR_GET_BUY_STATS_OVERVIEW', e)
  }
}

const postItem = async ({ body, user }: RequestExt, res: Response): Promise<void> => {
  try {
    const response = await insertBuy({ ...body, user: new Types.ObjectId(user.id) })
    await Promise.all(
      body.itemsBuy.map(async (item: ItemBuy) => await insertItemBuy({ idProducto: new Types.ObjectId(item.idProducto), total: item.total, cantidad: item.cantidad, precio: item.precio, idBuy: response._id as Types.ObjectId, estado: true }))
    )
    await Promise.all(
      body.itemsBuy.map(async (item: ItemBuy) => await updateProduct(new Types.ObjectId(item.idProducto), { precioCompra: item.precio }))
    )
    emitSocket('buy', {
      action: 'create',
      data: response
    })
    res.send(response)
  } catch (e) {
    handleHttp(res, 'ERROR_POST_ITEM', e)
  }
}

const getItem = async ({ params }: RequestExt, res: Response): Promise<void> => {
  try {
    const { id } = params
    const response = await getBuy(new Types.ObjectId(id))
    const response2 = await getItemBuy(new Types.ObjectId(id))
    res.send({ r: response[0], itemsBuy: response2 })
  } catch (e) {
    handleHttp(res, 'ERROR_GET_ITEM')
  }
}
const getItems = async ({ body }: RequestExt, res: Response): Promise<void> => {
  try {
    const { input, skip, limit } = body

    if (input !== undefined) {
      const response = await getBuys(input)
      res.send(response)
    } else {
      const response = await getBuysLimit(parseInt(skip), parseInt(limit))
      const cantidad = await qtyBuy()
      res.send({ array: response, longitud: cantidad })
    }
  } catch (e) {
    handleHttp(res, 'ERROR_GET_ITEMS')
  }
}

const updateItem = async ({ params, body, user }: RequestExt, res: Response): Promise<void> => {
  try {
    const { id } = params
    const response = await updateBuy(new Types.ObjectId(id), { ...body, user: new Types.ObjectId(user.id) })
    await Promise.all(
      body.itemsBuy.map(async (item: any) => {
        // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions
        if (item.idBuy) {
          await updateItemsBuy(new Types.ObjectId(item._id), { ...item })
        } else {
          await insertItemBuy({ idProducto: item.idProducto, total: item.total, cantidad: item.cantidad, idBuy: new Types.ObjectId(id), estado: true, precio: item.precio })
        }
      })
    )
    emitSocket('buy', {
      action: 'update',
      data: response
    })
    res.send(response)
  } catch (e) {
    handleHttp(res, 'ERROR_PATCH_ITEM', e)
  }
}

const patchItemBuy = async ({ params, body }: RequestExt, res: Response): Promise<void> => {
  try {
    const { id } = params
    const response = await updateItemsBuy(new Types.ObjectId(id), body)
    res.send(response)
  } catch (e) {
    handleHttp(res, 'ERROR_DELETE_ITEM')
  }
}

// Endpoints de conveniencia para egresos asociados a compras
const createBuyExpense = async ({ params, body, user }: RequestExt, res: Response): Promise<void> => {
  try {
    const { buyId } = params
    const userId = user?.id

    // Verificar que la compra existe
    const buy = await BuyModel.findById(buyId)
    if (buy == null) {
      res.status(404).json({ error: 'Compra no encontrada' })
      return
    }

    // Inyectar relatedTo y llamar al servicio
    const dto = {
      ...body,
      relatedTo: {
        kind: RELATED_KIND.BUY,
        id: buyId
      }
    }

    const expense = await ExpenseService.create(dto, userId)
    res.status(201).json({ expense })
  } catch (error: any) {
    handleHttp(res, 'ERROR_CREATE_BUY_EXPENSE', error)
  }
}

const listBuyExpenses = async ({ params, query }: RequestExt, res: Response): Promise<void> => {
  try {
    const { buyId } = params
    const result = await ExpenseService.listByBuy(buyId, query)
    res.json(result)
  } catch (error: any) {
    handleHttp(res, 'ERROR_LIST_BUY_EXPENSES', error)
  }
}

export { postItem, getItem, getItems, updateItem, patchItemBuy, createBuyExpense, listBuyExpenses, getBuyStatsByUserController, getBuyStatsOverviewController }
