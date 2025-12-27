import { Router } from 'express'
import { checkJwt } from '../middleware/session'
import { getItem, getItems, postItem, updateItem, createBuyExpense, listBuyExpenses } from '../controllers/buy'
import { checkPermission } from '../middleware/checkPermission'

const router = Router()

router.get('/', checkJwt, checkPermission('read_buy'), getItems)
router.post('/skip', checkJwt, checkPermission('read_buy'), getItems)
router.post('/search', checkJwt, checkPermission('read_buy'), getItems)
router.get('/:id', checkJwt, checkPermission('read_buy'), getItem)
router.post('/', checkJwt, checkPermission('create_buy'), postItem)
router.patch('/:id', checkJwt, checkPermission('update_buy'), updateItem)

// Sub-rutas de conveniencia para egresos asociados a compras
router.post('/:buyId/expenses', checkJwt, checkPermission('create_expense'), createBuyExpense)
router.get('/:buyId/expenses', checkJwt, checkPermission('read_expense'), listBuyExpenses)

export { router }
