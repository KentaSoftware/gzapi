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

// Sale lifecycle — payment: JWT + contracts flag only (RBAC deferred for this iteration).
router.post('/sales/:saleId/payment', (req, res, next) => { void checkJwt(req, res, next) }, requireContractsEnabled, (req, res) => { void confirmSalePayment(req, res) })
router.post('/sales/:saleId/delivery', (req, res, next) => { void checkJwt(req, res, next) }, requireContractsEnabled, (req, res, next) => { void checkPermission('confirm_sale_payment')(req, res, next) }, (req, res) => { void recordSaleDelivery(req, res) })
router.post('/sales/:saleId/cancellation', (req, res, next) => { void checkJwt(req, res, next) }, requireContractsEnabled, (req, res, next) => { void checkPermission('confirm_sale_payment')(req, res, next) }, (req, res) => { void recordSaleCancellation(req, res) })

// Sale money movement and physical adjustment.
router.post('/sales/:saleId/refunds', (req, res, next) => { void checkJwt(req, res, next) }, requireContractsEnabled, (req, res, next) => { void checkPermission('refund_sale')(req, res, next) }, (req, res) => { void recordSaleRefund(req, res) })
router.post('/sales/:saleId/physical-return', (req, res, next) => { void checkJwt(req, res, next) }, requireContractsEnabled, (req, res, next) => { void checkPermission('adjust_stock')(req, res, next) }, (req, res) => { void applyPhysicalReturn(req, res) })

// Purchase lifecycle and physical adjustment.
router.post('/buys/:buyId/payment', (req, res, next) => { void checkJwt(req, res, next) }, requireContractsEnabled, (req, res, next) => { void checkPermission('confirm_purchase_payment')(req, res, next) }, (req, res) => { void confirmPurchasePayment(req, res) })
router.post('/buys/:buyId/receipt', (req, res, next) => { void checkJwt(req, res, next) }, requireContractsEnabled, (req, res, next) => { void checkPermission('receive_purchase')(req, res, next) }, (req, res) => { void receivePurchase(req, res) })
router.post('/buys/:buyId/adjustments', (req, res, next) => { void checkJwt(req, res, next) }, requireContractsEnabled, (req, res, next) => { void checkPermission('adjust_stock')(req, res, next) }, (req, res) => { void applyPurchaseAdjustment(req, res) })

export { router }
