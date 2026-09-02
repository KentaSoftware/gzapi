import { Router } from 'express'
import { readdirSync } from 'fs'

const PATH_ROUTER = `${__dirname}`
const router = Router()

const cleanFileName = (fileName: string): string => {
  const file = fileName.split('.').shift()
  return file ?? ''
}

readdirSync(PATH_ROUTER).map((fileName): string => {
  const cleanName = cleanFileName(fileName)

  if (cleanName !== 'index') {
    import(`./${cleanName}`).then((moduleRouter) => {
      router.use(`/${cleanName}`, moduleRouter.router)
    }).catch((e) => console.log('Ocurrio un error en la ruta', e))
  }
  return cleanName
})

/* import { router as authRouter } from './auth';
import { router as backupRouter } from './backup';
import { router as brandRouter } from './brand';
import { router as buyRouter } from './buy';
import { router as categorieRouter } from './categorie';
import { router as cityRouter } from './city';
import { router as clientRouter } from './client';
import { router as datasetRouter } from './dataset';
import { router as itemBuyRouter } from './itemBuy';
import { router as itemSaleRouter } from './itemSale';
import { router as logRouter } from './log';
import { router as productRouter } from './product';
import { router as providerRouter } from './provider';
import { router as saleRouter } from './sale';

const router = Router();

// Define las rutas
router.use('/auth', authRouter);
router.use('/backup', backupRouter);
router.use('/brand', brandRouter);
router.use('/buy', buyRouter);
router.use('/categorie', categorieRouter);
router.use('/city', cityRouter);
router.use('/client', clientRouter);
router.use('/dataset', datasetRouter);
router.use('/itemBuy', itemBuyRouter);
router.use('/itemSale', itemSaleRouter);
router.use('/log', logRouter);
router.use('/product', productRouter);
router.use('/provider', providerRouter);
router.use('/sale', saleRouter); */

export { router }
