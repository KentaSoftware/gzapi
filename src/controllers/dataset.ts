import { Request, Response } from 'express'
import { handleHttp } from '../utils/error.handle'
import {
  getDailyData, getWeeklyData, getMonthlyData, getAnnuallyData,
  getDailyDataGraph, getWeeklyDataGraph, getMonthlyDataGraph, getAnnuallyDataGraph,
  bestSelling, highProfit, dataProduct, getCustomData, getCustomDataGraph,
  resolveDatasetPeriod
} from '../services/dataset'
/* import { JwtPayload } from 'jsonwebtoken' */

/* interface RequestExt extends Request {
  user?: string | JwtPayload | undefined | any
} */

const dailyCtrl = async (_: Request, res: Response): Promise<void> => {
  try {
    const period = resolveDatasetPeriod('daily')
    const [response, response2] = await Promise.all([
      getDailyData(),
      getDailyDataGraph()
    ])
    res.send({ period, simple: response, graph: response2 })
  } catch (e) {
    handleHttp(res, 'ERROR_GET_DAILY_DATA', e)
  }
}

const weeklyCtrl = async (_: Request, res: Response): Promise<void> => {
  try {
    const period = resolveDatasetPeriod('weekly')
    const [response, response2] = await Promise.all([
      getWeeklyData(),
      getWeeklyDataGraph()
    ])
    res.send({ period, simple: response, graph: response2 })
  } catch (e) {
    handleHttp(res, 'ERROR_GET_WEEKLY_DATA', e)
  }
}

const monthlyCtrl = async (_: Request, res: Response): Promise<void> => {
  try {
    const period = resolveDatasetPeriod('monthly')
    const [response, response2] = await Promise.all([
      getMonthlyData(),
      getMonthlyDataGraph()
    ])
    res.send({ period, simple: response, graph: response2 })
  } catch (e) {
    handleHttp(res, 'ERROR_GET_MONTHLY_DATA', e)
  }
}

const annuallyCtrl = async (_: Request, res: Response): Promise<void> => {
  try {
    const period = resolveDatasetPeriod('annually')
    const [response, response2] = await Promise.all([
      getAnnuallyData(),
      getAnnuallyDataGraph()
    ])
    res.send({ period, simple: response, graph: response2 })
  } catch (e) {
    handleHttp(res, 'ERROR_GET_ANNUALLY_DATA', e)
  }
}

const customCtrl = async ({ params }: Request, res: Response): Promise<void> => {
  try {
    const { from, to } = params
    // resolveDatasetPeriod throws INVALID_DATE_FORMAT for malformed YYYY-MM-DD params
    const period = resolveDatasetPeriod('custom', from, to)
    const [response, response2] = await Promise.all([
      getCustomData(from, to),
      getCustomDataGraph(from, to)
    ])
    res.send({ period, simple: response, graph: response2 })
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('INVALID_DATE_FORMAT')) {
      res.status(400).send({ error: e.message })
      return
    }
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
