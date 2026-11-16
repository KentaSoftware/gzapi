/**
 * Scenario 04 — Rotación y calidad de historial
 * Contrasta: baja rotación completa, rotación sana, historial insuficiente,
 * ventas canceladas (no cuentan), y productos recién creados.
 */

import type { Types } from 'mongoose'
import {
  addCivilDays,
  insertSaleLines,
  insertTrackedProduct,
  productNameAt,
  runScenario,
  seedRotationUnits,
  todayCivil,
  type StockCatalogIds
} from './lib'

async function load (adminId: Types.ObjectId, catalog: StockCatalogIds): Promise<void> {
  const today = todayCivil()
  let n = 0
  const nextName = (): string => productNameAt(n++)

  for (let i = 1; i <= 12; i += 1) {
    const minimum = 25
    const product = await insertTrackedProduct({
      adminId,
      catalog,
      name: nextName(),
      categoryIndex: i % catalog.categories.length,
      minimum,
      expiryAlertDays: 14,
      buckets: [{ expiryCivil: addCivilDays(today, 100), available: 50 }],
      createdAtCivil: addCivilDays(today, -200),
      key: `rotacion:baja:${i}`
    })
    if (i % 3 === 1) {
      await seedRotationUnits({ adminId, productId: product.productId, totalUnits: 2 })
    } else if (i % 3 === 2) {
      await insertSaleLines({
        adminId,
        productId: product.productId,
        lines: [
          { civilDate: addCivilDays(today, -5), quantity: 40, cancelled: true },
          { civilDate: addCivilDays(today, -12), quantity: 20, cancelled: true }
        ]
      })
    }
  }

  for (let i = 1; i <= 10; i += 1) {
    const minimum = 15
    const product = await insertTrackedProduct({
      adminId,
      catalog,
      name: nextName(),
      categoryIndex: (i + 1) % catalog.categories.length,
      minimum,
      expiryAlertDays: 14,
      buckets: [{ expiryCivil: addCivilDays(today, 110), available: 60 }],
      createdAtCivil: addCivilDays(today, -200),
      key: `rotacion:ok:${i}`
    })
    await seedRotationUnits({ adminId, productId: product.productId, totalUnits: minimum + 30 + i })
  }

  for (let i = 1; i <= 10; i += 1) {
    await insertTrackedProduct({
      adminId,
      catalog,
      name: nextName(),
      categoryIndex: (i + 2) % catalog.categories.length,
      minimum: 20,
      expiryAlertDays: 14,
      buckets: [{ expiryCivil: addCivilDays(today, 90), available: 35 }],
      createdAtCivil: addCivilDays(today, -(5 + i)),
      key: `rotacion:nuevo:${i}`
    })
  }

  console.log('   · baja rotación / sana / insuficiente con nombres reales')
}

runScenario(
  '04-rotacion-historial',
  'Enfocá KPI Baja rotación y alertas Media LOW_ROTATION + copy de historial de salidas insuficiente.',
  load
).catch((err) => {
  console.error('❌', err instanceof Error ? err.message : err)
  process.exit(1)
})
