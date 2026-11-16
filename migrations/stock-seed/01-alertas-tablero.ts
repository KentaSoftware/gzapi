/**
 * Scenario 01 — Tablero de alertas (CUR-3)
 * Mix explícito: stock crítico/media, vencidos, por vencer (crítica/media),
 * baja rotación, historial insuficiente y productos OK.
 */

import type { Types } from 'mongoose'
import {
  addCivilDays,
  insertTrackedProduct,
  insertUntrackedProduct,
  productNameAt,
  runScenario,
  seedRotationUnits,
  todayCivil,
  type StockCatalogIds
} from './lib'

async function load (adminId: Types.ObjectId, catalog: StockCatalogIds): Promise<void> {
  const today = todayCivil()
  const halfHorizon = 7 // alertDays=14 → half=7
  let n = 0
  const nextName = (): string => productNameAt(n++)

  for (let i = 1; i <= 6; i += 1) {
    const minimum = 40
    const physical = 5 + i
    const product = await insertTrackedProduct({
      adminId,
      catalog,
      name: nextName(),
      categoryIndex: i % catalog.categories.length,
      brandIndex: i % catalog.brands.length,
      minimum,
      expiryAlertDays: 14,
      buckets: [{ expiryCivil: addCivilDays(today, 90), available: physical }],
      key: `alertas:critical-stock:${i}`
    })
    await seedRotationUnits({ adminId, productId: product.productId, totalUnits: minimum + 20 })
  }

  for (let i = 1; i <= 6; i += 1) {
    const minimum = 40
    const physical = 20 + i
    const product = await insertTrackedProduct({
      adminId,
      catalog,
      name: nextName(),
      categoryIndex: (i + 2) % catalog.categories.length,
      brandIndex: (i + 1) % catalog.brands.length,
      minimum,
      expiryAlertDays: 14,
      buckets: [{ expiryCivil: addCivilDays(today, 120), available: physical }],
      key: `alertas:low-stock:${i}`
    })
    await seedRotationUnits({ adminId, productId: product.productId, totalUnits: minimum + 10 })
  }

  for (let i = 1; i <= 5; i += 1) {
    const product = await insertTrackedProduct({
      adminId,
      catalog,
      name: nextName(),
      categoryIndex: 1,
      minimum: 10,
      expiryAlertDays: 14,
      buckets: [
        { expiryCivil: addCivilDays(today, -i), available: 8 + i },
        { expiryCivil: addCivilDays(today, 60), available: 20 }
      ],
      key: `alertas:expired:${i}`
    })
    await seedRotationUnits({ adminId, productId: product.productId, totalUnits: 25 })
  }

  for (let i = 1; i <= 4; i += 1) {
    const days = Math.max(0, halfHorizon - i)
    const product = await insertTrackedProduct({
      adminId,
      catalog,
      name: nextName(),
      categoryIndex: 2,
      minimum: 8,
      expiryAlertDays: 14,
      buckets: [{ expiryCivil: addCivilDays(today, days), available: 12 + i }],
      key: `alertas:expiring-critical:${i}`
    })
    await seedRotationUnits({ adminId, productId: product.productId, totalUnits: 30 })
  }

  for (let i = 1; i <= 4; i += 1) {
    const days = halfHorizon + i
    const product = await insertTrackedProduct({
      adminId,
      catalog,
      name: nextName(),
      categoryIndex: 3,
      minimum: 8,
      expiryAlertDays: 14,
      buckets: [{ expiryCivil: addCivilDays(today, days), available: 15 }],
      key: `alertas:expiring-media:${i}`
    })
    await seedRotationUnits({ adminId, productId: product.productId, totalUnits: 30 })
  }

  for (let i = 1; i <= 5; i += 1) {
    const minimum = 30
    const product = await insertTrackedProduct({
      adminId,
      catalog,
      name: nextName(),
      categoryIndex: 4,
      minimum,
      expiryAlertDays: 21,
      buckets: [{ expiryCivil: addCivilDays(today, 100), available: 55 }],
      createdAtCivil: addCivilDays(today, -150),
      key: `alertas:low-rotation:${i}`
    })
    await seedRotationUnits({ adminId, productId: product.productId, totalUnits: 3 + i })
  }

  for (let i = 1; i <= 4; i += 1) {
    await insertTrackedProduct({
      adminId,
      catalog,
      name: nextName(),
      categoryIndex: 5,
      minimum: 20,
      expiryAlertDays: 14,
      buckets: [{ expiryCivil: addCivilDays(today, 80), available: 40 }],
      createdAtCivil: addCivilDays(today, -10),
      key: `alertas:insufficient:${i}`
    })
  }

  for (let i = 1; i <= 6; i += 1) {
    const minimum = 15
    const product = await insertTrackedProduct({
      adminId,
      catalog,
      name: nextName(),
      categoryIndex: i % catalog.categories.length,
      minimum,
      expiryAlertDays: 14,
      buckets: [{ expiryCivil: addCivilDays(today, 150), available: 40 + i * 3 }],
      key: `alertas:ok:${i}`
    })
    await seedRotationUnits({ adminId, productId: product.productId, totalUnits: minimum + 25 })
  }

  await insertUntrackedProduct({
    adminId,
    catalog,
    name: nextName(),
    stock: 2,
    minimum: 20,
    categoryIndex: 0,
    key: 'alertas:untracked-critical'
  })
  await insertUntrackedProduct({
    adminId,
    catalog,
    name: nextName(),
    stock: 80,
    minimum: 10,
    categoryIndex: 1,
    key: 'alertas:untracked-ok'
  })

  console.log('   · escenario 01: alertas mixtas con nombres de catálogo')
}

runScenario(
  '01-alertas-tablero',
  'Tablero con Crítica/Media de stock y vencimiento, vencidos, baja rotación e historial insuficiente.',
  load
).catch((err) => {
  console.error('❌', err instanceof Error ? err.message : err)
  process.exit(1)
})
