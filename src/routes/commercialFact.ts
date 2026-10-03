import { Router } from 'express'
import { checkJwt } from '../middleware/session'
import { checkPermission } from '../middleware/checkPermission'
import {
  applyPhysicalReturn,
  applyPurchaseAdjustment,
  confirmPurchasePayment,
  confirmSalePayment,
  receivePurchase,
  recordSaleCancellation,
  recordSaleDelivery,
  recordSaleRefund,
  requireContractsEnabled
} from '../controllers/commercialFact'

const router = Router()

// Sale lifecycle — gated by sale access (confirm_sale_payment) plus ownership.
// eslint-disable-next-line @typescript-eslint/no-misused-promises
router.post('/sales/:saleId/payment', checkJwt, requireContractsEnabled, checkPermission('confirm_sale_payment'), confirmSalePayment)
// eslint-disable-next-line @typescript-eslint/no-misused-promises
router.post('/sales/:saleId/delivery', checkJwt, requireContractsEnabled, checkPermission('confirm_sale_payment'), recordSaleDelivery)
// eslint-disable-next-line @typescript-eslint/no-misused-promises
router.post('/sales/:saleId/cancellation', checkJwt, requireContractsEnabled, checkPermission('confirm_sale_payment'), recordSaleCancellation)

// Sale money movement and physical adjustment.
// eslint-disable-next-line @typescript-eslint/no-misused-promises
router.post('/sales/:saleId/refunds', checkJwt, requireContractsEnabled, checkPermission('refund_sale'), recordSaleRefund)
// eslint-disable-next-line @typescript-eslint/no-misused-promises
router.post('/sales/:saleId/physical-return', checkJwt, requireContractsEnabled, checkPermission('adjust_stock'), applyPhysicalReturn)

// Purchase lifecycle and physical adjustment.
// eslint-disable-next-line @typescript-eslint/no-misused-promises
router.post('/buys/:buyId/payment', checkJwt, requireContractsEnabled, checkPermission('confirm_purchase_payment'), confirmPurchasePayment)
// eslint-disable-next-line @typescript-eslint/no-misused-promises
router.post('/buys/:buyId/receipt', checkJwt, requireContractsEnabled, checkPermission('receive_purchase'), receivePurchase)
// eslint-disable-next-line @typescript-eslint/no-misused-promises
router.post('/buys/:buyId/adjustments', checkJwt, requireContractsEnabled, checkPermission('adjust_stock'), applyPurchaseAdjustment)

export { router }
