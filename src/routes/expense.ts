import { Router } from 'express'
import { checkJwt } from '../middleware/session'
import { checkPermission } from '../middleware/checkPermission'
import {
  createExpense,
  listExpenses,
  getExpense,
  updateExpense,
  deleteExpense,
  getExpensesKPI
} from '../controllers/expense'

const router = Router()

router.post('/', checkJwt, checkPermission('create_expense'), createExpense)
router.get('/kpi/total', checkJwt, checkPermission('read_expense'), getExpensesKPI)
router.get('/', checkJwt, checkPermission('read_expense'), listExpenses)
router.get('/:id', checkJwt, checkPermission('read_expense'), getExpense)
router.patch('/:id', checkJwt, checkPermission('update_expense'), updateExpense)
router.delete('/:id', checkJwt, checkPermission('delete_expense'), deleteExpense)

export { router }
