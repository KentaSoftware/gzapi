/**
 * Scenario 03 — Vencidos para CUR-4 / CU-006
 * Muchos lotes vencidos (catálogo completo) + algunos sanos para contraste.
 */

import type { Types } from 'mongoose'
import {
  addCivilDays,
  createRng,
  insertTrackedProduct,
  productNameAt,
  randInt,
  runScenario,
  seedRotationUnits,
  todayCivil,
  type StockCatalogIds
} from './lib'

async function load (adminId: Types.ObjectId, catalog: StockCatalogIds): Promise<void> {
  const today = todayCivil()
  const rng = createRng(20261115)
  let n = 0
  const nextName = (): string => productNameAt(n++)

  for (let i = 1; i <= 36; i += 1) {
    const expiredQty = randInt(rng, 4, 28)
    const freshQty = randInt(rng, 0, 15)
    const buckets = [
      { expiryCivil: addCivilDays(today, -randInt(rng, 1, 45)), available: expiredQty }
    ]
    if (freshQty > 0) {
      buckets.push({ expiryCivil: addCivilDays(today, randInt(rng, 40, 180)), available: freshQty })
    }
    const product = await insertTrackedProduct({
      adminId,
      catalog,
      name: nextName(),
      categoryIndex: i % catalog.categories.length,
      brandIndex: i % catalog.brands.length,
      minimum: 12,
      expiryAlertDays: 14,
      buckets,
      key: `vencidos:${i}`
    })
    await seedRotationUnits({ adminId, productId: product.productId, totalUnits: randInt(rng, 15, 40), rng })
  }

  for (let i = 1; i <= 8; i += 1) {
    const product = await insertTrackedProduct({
      adminId,
      catalog,
      name: nextName(),
      categoryIndex: i % catalog.categories.length,
      minimum: 10,
      expiryAlertDays: 14,
      buckets: [{ expiryCivil: addCivilDays(today, 90 + i * 3), available: 40 }],
      key: `vencidos:ok:${i}`
    })
    await seedRotationUnits({ adminId, productId: product.productId, totalUnits: 35 })
  }

  for (let i = 1; i <= 4; i += 1) {
    await insertTrackedProduct({
      adminId,
      catalog,
      name: nextName(),
      categoryIndex: 0,
      minimum: 5,
      expiryAlertDays: 14,
      buckets: [{
        expiryCivil: addCivilDays(today, -2 - i),
        available: 6,
        committed: 4
      }],
      key: `vencidos:committed:${i}`
    })
  }

  console.log('   · ~48 productos con nombres reales; mayoría con lotes vencidos')
}

runScenario(
  '03-vencidos-retiro',
  'Configuración CUR-4: lista densa de vencidos, retiro individual y masivo (algunos parciales por compromiso).',
  load
).catch((err) => {
  console.error('❌', err instanceof Error ? err.message : err)
  process.exit(1)
})
