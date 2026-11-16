/**
 * Scenario 05 — Panel rico (demo completa stock-smart)
 * ~90 productos con nombres reales, multi-lote, compromisos,
 * salidas densas 30 días, mezcla de todas las alertas + paginación.
 */

import type { Types } from 'mongoose'
import {
  addCivilDays,
  createRng,
  insertTrackedProduct,
  insertUntrackedProduct,
  pick,
  productNameAt,
  randInt,
  runScenario,
  seedRotationUnits,
  todayCivil,
  type StockCatalogIds
} from './lib'

async function load (adminId: Types.ObjectId, catalog: StockCatalogIds): Promise<void> {
  const today = todayCivil()
  const rng = createRng(991188)

  let critical = 0
  let media = 0
  let expired = 0
  let expiring = 0
  let lowRot = 0
  let ok = 0

  for (let i = 1; i <= 80; i += 1) {
    const name = productNameAt(i - 1)
    const bucket: Array<{ expiryCivil: string, available: number, committed?: number }> = []
    let minimum = randInt(rng, 12, 40)
    let expiryAlertDays = pick(rng, [7, 14, 21, 30] as const)
    let createdAtCivil = addCivilDays(today, -randInt(rng, 90, 240))
    let rotationUnits = 0
    const roll = rng()

    if (roll < 0.12) {
      critical += 1
      minimum = 40
      const physical = randInt(rng, 0, 15)
      bucket.push({ expiryCivil: addCivilDays(today, randInt(rng, 60, 180)), available: Math.max(1, physical) })
      rotationUnits = minimum + 20
    } else if (roll < 0.24) {
      media += 1
      minimum = 40
      const physical = randInt(rng, 20, 39)
      bucket.push({ expiryCivil: addCivilDays(today, randInt(rng, 70, 160)), available: physical })
      rotationUnits = minimum + 15
    } else if (roll < 0.36) {
      expired += 1
      bucket.push({ expiryCivil: addCivilDays(today, -randInt(rng, 1, 40)), available: randInt(rng, 5, 25) })
      if (rng() > 0.4) {
        bucket.push({ expiryCivil: addCivilDays(today, randInt(rng, 50, 140)), available: randInt(rng, 10, 40) })
      }
      rotationUnits = minimum + 10
    } else if (roll < 0.48) {
      expiring += 1
      const half = Math.floor(expiryAlertDays / 2)
      const days = rng() < 0.5
        ? randInt(rng, 0, Math.max(0, half - 1))
        : randInt(rng, half, expiryAlertDays)
      bucket.push({ expiryCivil: addCivilDays(today, days), available: randInt(rng, 8, 30) })
      rotationUnits = minimum + 12
    } else if (roll < 0.60) {
      lowRot += 1
      minimum = randInt(rng, 25, 45)
      bucket.push({ expiryCivil: addCivilDays(today, randInt(rng, 80, 200)), available: randInt(rng, 40, 90) })
      rotationUnits = randInt(rng, 0, minimum - 1)
      createdAtCivil = addCivilDays(today, -randInt(rng, 120, 300))
    } else if (roll < 0.68) {
      bucket.push({ expiryCivil: addCivilDays(today, randInt(rng, 70, 150)), available: randInt(rng, 20, 60) })
      createdAtCivil = addCivilDays(today, -randInt(rng, 1, 20))
      rotationUnits = 0
    } else {
      ok += 1
      const lots = randInt(rng, 1, 3)
      for (let lot = 0; lot < lots; lot += 1) {
        const committed = lot === 0 && rng() < 0.25 ? randInt(rng, 1, 6) : 0
        bucket.push({
          expiryCivil: addCivilDays(today, 45 + lot * 40 + randInt(rng, 0, 20)),
          available: randInt(rng, 15, 50),
          ...(committed > 0 ? { committed } : {})
        })
      }
      rotationUnits = minimum + randInt(rng, 20, 80)
    }

    const product = await insertTrackedProduct({
      adminId,
      catalog,
      name,
      categoryIndex: i % catalog.categories.length,
      brandIndex: i % catalog.brands.length,
      providerIndex: i % catalog.providers.length,
      minimum,
      expiryAlertDays,
      buckets: bucket,
      createdAtCivil,
      precioUnitario: randInt(rng, 800, 7500),
      key: `rico:${i}`
    })
    if (rotationUnits > 0) {
      await seedRotationUnits({
        adminId,
        productId: product.productId,
        totalUnits: rotationUnits,
        withinDays: 30,
        rng
      })
    }
  }

  for (let i = 1; i <= 12; i += 1) {
    await insertUntrackedProduct({
      adminId,
      catalog,
      name: productNameAt(80 + i - 1),
      stock: randInt(rng, 5, 120),
      minimum: randInt(rng, 10, 30),
      categoryIndex: i % catalog.categories.length,
      createdAtCivil: addCivilDays(today, -randInt(rng, 60, 200)),
      key: `rico:untracked:${i}`
    })
  }

  console.log(`   · mix aprox. crítico=${critical} media=${media} vencidos=${expired} porVencer=${expiring} bajaRot=${lowRot} ok=${ok} (+12 untracked)`)
}

runScenario(
  '05-panel-rico',
  'Dataset denso para demo: KPIs, alertas Crítica/Media/Info, paginación, consulta rápida, config y PDF.',
  load
).catch((err) => {
  console.error('❌', err instanceof Error ? err.message : err)
  process.exit(1)
})
