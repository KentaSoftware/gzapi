import { Router } from 'express'
import { checkJwt } from '../middleware/session'
import {
  deleteSaleController,
  getItem,
  getItems,
  getSaleStatsByUserController,
  getSaleStatsOverviewController,
  postItem,
  postMultipleItem,
  printSale,
  printSales,
  updateItem
} from '../controllers/sale'
import { checkPermission } from '../middleware/checkPermission'

const router = Router()

router.get('/', (req, res, next) => { void checkJwt(req, res, next) }, (req, res, next) => { void checkPermission('read_sale')(req, res, next) }, (req, res) => { void getItems(req, res) })
router.post('/skip', (req, res, next) => { void checkJwt(req, res, next) }, (req, res, next) => { void checkPermission('read_sale')(req, res, next) }, (req, res) => { void getItems(req, res) })
router.post('/search', (req, res, next) => { void checkJwt(req, res, next) }, (req, res, next) => { void checkPermission('read_sale')(req, res, next) }, (req, res) => { void getItems(req, res) })
router.post('/stats/by-user', (req, res, next) => { void checkJwt(req, res, next) }, (req, res, next) => { void checkPermission('read_stats')(req, res, next) }, (req, res) => { void getSaleStatsByUserController(req, res) })
router.post('/stats/overview', (req, res, next) => { void checkJwt(req, res, next) }, (req, res, next) => { void checkPermission('read_stats')(req, res, next) }, (req, res) => { void getSaleStatsOverviewController(req, res) })
router.get('/:id', (req, res, next) => { void checkJwt(req, res, next) }, (req, res, next) => { void checkPermission('read_sale')(req, res, next) }, (req, res) => { void getItem(req, res) })
router.post('/', (req, res, next) => { void checkJwt(req, res, next) }, (req, res, next) => { void checkPermission('create_sale')(req, res, next) }, (req, res) => { void postItem(req, res) })
router.post('/multiple', (req, res, next) => { void checkJwt(req, res, next) }, (req, res, next) => { void checkPermission('create_sale')(req, res, next) }, (req, res) => { void postMultipleItem(req, res) })
router.patch('/:id', (req, res, next) => { void checkJwt(req, res, next) }, (req, res, next) => { void checkPermission('update_sale')(req, res, next) }, (req, res) => { void updateItem(req, res) })
router.get('/print/:id', (req, res, next) => { void checkJwt(req, res, next) }, (req, res, next) => { void checkPermission('read_sale')(req, res, next) }, (req, res) => { void printSale(req, res) })
router.post('/print', (req, res, next) => { void checkJwt(req, res, next) }, (req, res, next) => { void checkPermission('read_sale')(req, res, next) }, (req, res) => { void printSales(req, res) })
router.delete('/:id', (req, res, next) => { void checkJwt(req, res, next) }, (req, res, next) => { void checkPermission('delete_sale')(req, res, next) }, (req, res) => { void deleteSaleController(req, res) })

export { router }
