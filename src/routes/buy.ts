import { Router } from 'express'
import { checkJwt } from '../middleware/session'
import { getItem, getItems, postItem, updateItem, createBuyExpense, listBuyExpenses, getBuyStatsByUserController, getBuyStatsOverviewController } from '../controllers/buy'
import { checkPermission } from '../middleware/checkPermission'

const router = Router()

router.get('/', (req, res, next) => { void checkJwt(req, res, next) }, (req, res, next) => { void checkPermission('read_buy')(req, res, next) }, (req, res) => { void getItems(req, res) })
router.post('/skip', (req, res, next) => { void checkJwt(req, res, next) }, (req, res, next) => { void checkPermission('read_buy')(req, res, next) }, (req, res) => { void getItems(req, res) })
router.post('/search', (req, res, next) => { void checkJwt(req, res, next) }, (req, res, next) => { void checkPermission('read_buy')(req, res, next) }, (req, res) => { void getItems(req, res) })
router.get('/:id', (req, res, next) => { void checkJwt(req, res, next) }, (req, res, next) => { void checkPermission('read_buy')(req, res, next) }, (req, res) => { void getItem(req, res) })
router.post('/', (req, res, next) => { void checkJwt(req, res, next) }, (req, res, next) => { void checkPermission('create_buy')(req, res, next) }, (req, res) => { void postItem(req, res) })
router.patch('/:id', (req, res, next) => { void checkJwt(req, res, next) }, (req, res, next) => { void checkPermission('update_buy')(req, res, next) }, (req, res) => { void updateItem(req, res) })

router.post('/stats/by-user', (req, res, next) => { void checkJwt(req, res, next) }, (req, res, next) => { void checkPermission('read_stats')(req, res, next) }, (req, res) => { void getBuyStatsByUserController(req, res) })
router.post('/stats/overview', (req, res, next) => { void checkJwt(req, res, next) }, (req, res, next) => { void checkPermission('read_stats')(req, res, next) }, (req, res) => { void getBuyStatsOverviewController(req, res) })

// Sub-rutas de conveniencia para egresos asociados a compras
router.post('/:buyId/expenses', (req, res, next) => { void checkJwt(req, res, next) }, (req, res, next) => { void checkPermission('create_expense')(req, res, next) }, (req, res) => { void createBuyExpense(req, res) })
router.get('/:buyId/expenses', (req, res, next) => { void checkJwt(req, res, next) }, (req, res, next) => { void checkPermission('read_expense')(req, res, next) }, (req, res) => { void listBuyExpenses(req, res) })

export { router }
