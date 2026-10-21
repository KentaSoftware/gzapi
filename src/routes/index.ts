import { Router, type Router as ExpressRouter } from 'express'

import { router as authRouter } from './auth'
import { router as backupRouter } from './backup'
import { router as brandRouter } from './brand'
import { router as buyRouter } from './buy'
import { router as cashflowRouter } from './cashflow'
import { router as catalogRouter } from './catalog'
import { router as categorieRouter } from './categorie'
import { router as cityRouter } from './city'
import { router as clientRouter } from './client'
import { router as commercialFactRouter } from './commercialFact'
import { router as datasetRouter } from './dataset'
import { router as deliveryZoneRouter } from './deliveryZone'
import { router as duplicateCheckRouter } from './duplicateCheck'
import { router as expenseRouter } from './expense'
import { router as financeRouter } from './finance'
import { router as itemBuyRouter } from './itemBuy'
import { router as itemSaleRouter } from './itemSale'
import { router as logRouter } from './log'
import { router as pingRouter } from './ping'
import { router as productRouter } from './product'
import { router as providerRouter } from './provider'
import { router as roleRouter } from './role'
import { router as routePlanRouter } from './routePlan'
import { router as saleRouter } from './sale'
import { router as stockRouter } from './stock'
import { router as userRouter } from './user'

interface RouteEntry {
  prefix: string
  router: ExpressRouter
}

const routeRegistry: RouteEntry[] = [
  { prefix: '/auth', router: authRouter },
  { prefix: '/backup', router: backupRouter },
  { prefix: '/brand', router: brandRouter },
  { prefix: '/buy', router: buyRouter },
  { prefix: '/cashflow', router: cashflowRouter },
  { prefix: '/catalog', router: catalogRouter },
  { prefix: '/categorie', router: categorieRouter },
  { prefix: '/city', router: cityRouter },
  { prefix: '/client', router: clientRouter },
  { prefix: '/commercialFact', router: commercialFactRouter },
  { prefix: '/dataset', router: datasetRouter },
  { prefix: '/deliveryZone', router: deliveryZoneRouter },
  { prefix: '/duplicateCheck', router: duplicateCheckRouter },
  { prefix: '/expense', router: expenseRouter },
  { prefix: '/finance', router: financeRouter },
  { prefix: '/itemBuy', router: itemBuyRouter },
  { prefix: '/itemSale', router: itemSaleRouter },
  { prefix: '/log', router: logRouter },
  { prefix: '/ping', router: pingRouter },
  { prefix: '/product', router: productRouter },
  { prefix: '/provider', router: providerRouter },
  { prefix: '/role', router: roleRouter },
  { prefix: '/routePlan', router: routePlanRouter },
  { prefix: '/sale', router: saleRouter },
  { prefix: '/stock', router: stockRouter },
  { prefix: '/user', router: userRouter }
]

const loadRoutes = async (): Promise<ExpressRouter> => {
  const router = Router()

  for (const route of routeRegistry) {
    router.use(route.prefix, route.router)
  }

  return router
}

export { loadRoutes, routeRegistry }
