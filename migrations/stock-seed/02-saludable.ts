/**
 * Scenario 02 — Catálogo saludable (M1)
 * Todo dentro de parámetros: sin stock bajo, sin vencidos/por vencer, rotación OK.
 */

import type { Types } from 'mongoose'
import {
  addCivilDays,
  insertTrackedProduct,
  productNameAt,
  runScenario,
  seedRotationUnits,
  todayCivil,
  type StockCatalogIds
} from './lib'

async function load (adminId: Types.ObjectId, catalog: StockCatalogIds): Promise<void> {
  const today = todayCivil()
  const count = 20

  for (let index = 0; index < count; index += 1) {
    const minimum = 10 + (index % 5)
    const physical = minimum + 30 + index * 2
    const product = await insertTrackedProduct({
      adminId,
      catalog,
      name: productNameAt(index),
      categoryIndex: index % catalog.categories.length,
      brandIndex: index % catalog.brands.length,
      providerIndex: index % catalog.providers.length,
      minimum,
      expiryAlertDays: 21,
      buckets: [{ expiryCivil: addCivilDays(today, 120 + index), available: physical }],
      createdAtCivil: addCivilDays(today, -180),
      key: `saludable:${index + 1}`
    })
    await seedRotationUnits({
      adminId,
      productId: product.productId,
      totalUnits: minimum + 40 + index
    })
  }
  console.log(`   · ${count} productos saludables con nombres reales`)
}

runScenario(
  '02-saludable',
  'Empty state M1: "Todos los indicadores operan dentro de los parámetros normales".',
  load
).catch((err) => {
  console.error('❌', err instanceof Error ? err.message : err)
  process.exit(1)
})
