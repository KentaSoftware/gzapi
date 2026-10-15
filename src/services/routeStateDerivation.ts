import { SALE_DELIVERY_STATUS, type SaleDeliveryStatus } from '../interfaces/sale.interface'
import {
  ROUTE_OPERATIONAL_STATUS,
  type RouteOperationalStatus
} from '../interfaces/routeOptimization.interface'

const deriveRouteStatus = (deliveries: SaleDeliveryStatus[]): RouteOperationalStatus => {
  if (deliveries.length === 0) throw new RangeError('Route status requires at least one selected sale')
  if (deliveries.every((delivery) => delivery === SALE_DELIVERY_STATUS.DELIVERED)) return ROUTE_OPERATIONAL_STATUS.COMPLETED
  if (deliveries.some((delivery) => delivery === SALE_DELIVERY_STATUS.DELIVERED)) return ROUTE_OPERATIONAL_STATUS.IN_PROGRESS
  return ROUTE_OPERATIONAL_STATUS.PENDING
}

export { deriveRouteStatus }
