import { Router } from 'express'
import { checkJwt } from '../middleware/session'
import { checkPermission } from '../middleware/checkPermission'
import {
  createExpense,
  listExpenses,
  getExpense,
  updateExpense,
  deleteExpense,
  getExpensesKPI,
  getSimpleResultKPI
} from '../controllers/expense'

const router = Router()

router.post('/', (req, res, next) => { void checkJwt(req, res, next) }, (req, res, next) => { void checkPermission('create_expense')(req, res, next) }, (req, res) => { void createExpense(req, res) })
router.get('/kpi/total', (req, res, next) => { void checkJwt(req, res, next) }, (req, res, next) => { void checkPermission('read_expense')(req, res, next) }, (req, res) => { void getExpensesKPI(req, res) })
router.get('/kpi/simple-result', (req, res, next) => { void checkJwt(req, res, next) }, (req, res, next) => { void checkPermission('read_expense')(req, res, next) }, (req, res) => { void getSimpleResultKPI(req, res) })
router.get('/', (req, res, next) => { void checkJwt(req, res, next) }, (req, res, next) => { void checkPermission('read_expense')(req, res, next) }, (req, res) => { void listExpenses(req, res) })
router.get('/:id', (req, res, next) => { void checkJwt(req, res, next) }, (req, res, next) => { void checkPermission('read_expense')(req, res, next) }, (req, res) => { void getExpense(req, res) })
router.patch('/:id', (req, res, next) => { void checkJwt(req, res, next) }, (req, res, next) => { void checkPermission('update_expense')(req, res, next) }, (req, res) => { void updateExpense(req, res) })
router.delete('/:id', (req, res, next) => { void checkJwt(req, res, next) }, (req, res, next) => { void checkPermission('delete_expense')(req, res, next) }, (req, res) => { void deleteExpense(req, res) })

export { router }
