import { Request, Response } from 'express'
import { handleHttp } from '../utils/error.handle'
import { getDailyData, getWeeklyData, getMonthlyData, getAnnuallyData, getDailyDataGraph, getWeeklyDataGraph, getMonthlyDataGraph, getAnnuallyDataGraph, bestSelling, highProfit, dataProduct, getCustomData, getCustomDataGraph } from '../services/dataset'
/* import { JwtPayload } from 'jsonwebtoken' */

/* interface RequestExt extends Request {
  user?: string | JwtPayload | undefined | any
} */

const dailyCtrl = async (_: Request, res: Response): Promise<void> => {
  try {
    const response = await getDailyData()
    const response2 = await getDailyDataGraph()
    res.send({ simple: response, graph: response2 })
  } catch (e) {
    handleHttp(res, 'ERROR_GET_DAILY_DATA', e)
  }
}

const weeklyCtrl = async (_: Request, res: Response): Promise<void> => {
  try {
    const response = await getWeeklyData()
    const response2 = await getWeeklyDataGraph()
    res.send({ simple: response, graph: response2 })
  } catch (e) {
    handleHttp(res, 'ERROR_GET_WEEKLY_DATA', e)
  }
}

const monthlyCtrl = async (_: Request, res: Response): Promise<void> => {
  try {
    const response = await getMonthlyData()
    const response2 = await getMonthlyDataGraph()
    res.send({ simple: response, graph: response2 })
  } catch (e) {
    handleHttp(res, 'ERROR_GET_MONTHLY_DATA', e)
  }
}

const annuallyCtrl = async (_: Request, res: Response): Promise<void> => {
  try {
    const response = await getAnnuallyData()
    const response2 = await getAnnuallyDataGraph()
    res.send({ simple: response, graph: response2 })
  } catch (e) {
    handleHttp(res, 'ERROR_GET_ANNUALLY_DATA', e)
  }
}

const customCtrl = async ({ params }: Request, res: Response): Promise<void> => {
  try {
    const { start, end } = params
    const response = await getCustomData(start, end)
    const response2 = await getCustomDataGraph(start, end)
    res.send({ simple: response, graph: response2 })
  } catch (e) {
    handleHttp(res, 'ERROR_GET_CUSTOM_DATA', e)
  }
}

const bestSellingCtrl = async (_: Request, res: Response): Promise<void> => {
  try {
    const response = await bestSelling()
    res.send(response)
  } catch (e) {
    handleHttp(res, 'ERROR_GET_BEST_SELLING', e)
  }
}

const highProfitCtrl = async (_: Request, res: Response): Promise<void> => {
  try {
    const response = await highProfit()
    res.send(response)
  } catch (e) {
    handleHttp(res, 'ERROR_GET_HIGH_PROFIT', e)
  }
}

const dataProductCtrl = async (_: Request, res: Response): Promise<void> => {
  try {
    const response = await dataProduct()
    res.send(response)
  } catch (e) {
    handleHttp(res, 'ERROR_GET_BEST_SELLING')
  }
}

export { dailyCtrl, weeklyCtrl, monthlyCtrl, annuallyCtrl, bestSellingCtrl, highProfitCtrl, dataProductCtrl, customCtrl }
