/**
 * Shared helpers for stock scenario seeds (avance 2 / CUR-3–CUR-4).
 * SAFETY: only allows mongodb://localhost|127.0.0.1/.../test_route_plan
 */

import 'dotenv/config'
import mongoose, { Types } from 'mongoose'
import { fromZonedTime } from 'date-fns-tz'
import { seedDatabase } from '../../src/services/seed'
import UserModel from '../../src/models/user'
import CategorieModel from '../../src/models/categorie'
import BrandModel from '../../src/models/brand'
import ProviderModel from '../../src/models/provider'
import ProductModel from '../../src/models/product'
import StockExpiryBucketModel from '../../src/models/stockExpiryBucket'
import InventoryMovementModel from '../../src/models/inventoryMovement'
import SaleModel from '../../src/models/sale'
import ItemSaleModel from '../../src/models/itemSale'
import {
  BASELINE_STATUS,
  EXPIRY_TRACKING,
  INVENTORY_MOVEMENT_TYPES
} from '../../src/interfaces/stock.interface'
import { STOCK_RULES_VERSION, STOCK_TIME_ZONE } from '../../src/config/stock'

export const TARGET_DATABASE = 'test_route_plan'
export const STOCK_SEED_NAMESPACE = 'gzapi-stock-seed-v1'

export function assertSafeMongoUri (uri: string): void {
  let parsed: URL
  try {
    parsed = new URL(uri)
  } catch {
    throw new Error(`MONGODB_URI is not a valid connection string: ${uri}`)
  }
  const host = parsed.hostname
  const isLocal = host === 'localhost' || host === '127.0.0.1'
  const database = parsed.pathname.replace(/^\//, '')
  if (parsed.protocol !== 'mongodb:' || !isLocal || database !== TARGET_DATABASE) {
    throw new Error(
      `Refusing to run stock seed/wipe on "${uri}". ` +
      `Only mongodb://localhost|127.0.0.1/${TARGET_DATABASE} is allowed.`
    )
  }
}

export async function connectStockSeedDb (): Promise<string> {
  const uri = process.env.MONGODB_URI
  if (uri == null || uri === '') {
    throw new Error('MONGODB_URI is required (load .env)')
  }
  assertSafeMongoUri(uri)
  await mongoose.connect(uri)
  const dbName = mongoose.connection.name
  if (dbName !== TARGET_DATABASE) {
    await mongoose.disconnect()
    throw new Error(`Connected to unexpected database "${dbName}"`)
  }
  console.log(`✅ Connected to ${uri}`)
  return uri
}

/** Drop entire test_route_plan DB, then recreate admin/roles via seedDatabase. */
export async function wipeStockTestDatabase (): Promise<void> {
  await connectStockSeedDb()
  console.log(`🗑️  Dropping database "${TARGET_DATABASE}"...`)
  await mongoose.connection.dropDatabase()
  console.log('🌱 Bootstrapping roles + admin (seedDatabase, sin demo fixtures)...')
  // Skip seedDemoFixtures: they require replica-set transactions.
  await seedDatabase({ seedDemoFixtures: async () => {} })
  const admin = await UserModel.findOne({ nickname: 'admin' })
  if (admin == null) {
    throw new Error('admin user was not created after wipe')
  }
  console.log(`✅ Wipe complete. admin id=${String(admin._id)} (re-login in the UI if session was open)`)
}

export async function getAdminUserId (): Promise<Types.ObjectId> {
  const admin = await UserModel.findOne({ nickname: 'admin' })
  if (admin == null) throw new Error('admin user not found — run wipe/bootstrap first')
  return new Types.ObjectId(String(admin._id))
}

export function todayCivil (now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: STOCK_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(now)
}

export function addCivilDays (civil: string, days: number): string {
  const [y, m, d] = civil.split('-').map(Number)
  const date = new Date(Date.UTC(y, m - 1, d))
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

export function civilToUtcDate (civil: string): Date {
  const [y, m, d] = civil.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d))
}

/** Instant in STOCK_TIME_ZONE for a civil date at local noon (stable for sale.createdAt). */
export function civilToLocalNoon (civil: string): Date {
  return fromZonedTime(`${civil}T12:00:00`, STOCK_TIME_ZONE)
}

export function createRng (seed: number): () => number {
  let state = seed
  return () => {
    state = (state + 0x6D2B79F5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export const randInt = (rng: () => number, min: number, max: number): number =>
  min + Math.floor(rng() * (max - min + 1))

export const pick = <T>(rng: () => number, items: readonly T[]): T =>
  items[Math.floor(rng() * items.length)]

export interface StockCatalogIds {
  categories: Types.ObjectId[]
  brands: Types.ObjectId[]
  providers: Types.ObjectId[]
  categoryNames: string[]
}

const DEFAULT_CATEGORIES = ['Bebidas', 'Almacén', 'Snacks', 'Limpieza', 'Cuidado personal', 'Lácteos', 'Congelados', 'Fiambres'] as const
const DEFAULT_BRANDS = ['Andes', 'Norte', 'Pampa', 'Sol', 'Río', 'Valle', 'Campo', 'Luna', 'Cumbre', 'Oasis'] as const
const DEFAULT_PROVIDERS = ['Distribuidora Norte', 'Regional Supply', 'Valle Mayorista', 'Central Goods', 'Mercadería del Sur'] as const

/**
 * Nombres reales reutilizados de demo seed + finance 05-panel-rico,
 * ampliados con variantes de presentación para poder cargar catálogos densos.
 */
export const PRODUCT_NAMES = [
  // demo seed (seed.ts PRODUCT_FIXTURES)
  'Agua mineral sin gas 1,5 l',
  'Agua mineral con gas 500 ml',
  'Jugo de naranja 1 l',
  'Gaseosa de pomelo 2,25 l',
  'Arroz largo fino 1 kg',
  'Fideos secos tirabuzón 500 g',
  'Harina de trigo 1 kg',
  'Azúcar blanca 1 kg',
  'Aceite de girasol 900 ml',
  'Yerba mate 1 kg',
  'Detergente líquido 750 ml',
  'Lavandina 1 l',
  'Jabón de tocador 125 g',
  'Papas fritas clásicas 150 g',
  'Galletitas de agua 200 g',
  // finance seed 05-panel-rico
  'Gaseosa cola 1.5 L',
  'Gaseosa lima-limón 1.5 L',
  'Agua mineral 2 L',
  'Jugo de naranja 1 L',
  'Cerveza rubia pack x6',
  'Vino tinto reserva 750 ml',
  'Fideos spaghetti 500 g',
  'Aceite de girasol 1.5 L',
  'Harina 000 1 kg',
  'Azúcar 1 kg',
  'Galletitas dulces 300 g',
  'Papas fritas 180 g',
  'Alfajores x6',
  'Maní salado 200 g',
  'Detergente 750 ml',
  'Jabón líquido 3 L',
  'Papel higiénico x4',
  'Shampoo 400 ml',
  'Dentífrico 90 g',
  'Helado pote 1 kg',
  'Milanesas congeladas 1 kg',
  // variantes / ampliaciones al mismo estilo
  'Agua saborizada manzana 1.5 L',
  'Agua saborizada pomelo 1.5 L',
  'Gaseosa cola 2.25 L',
  'Gaseosa naranja 2.25 L',
  'Jugo de manzana 1 L',
  'Jugo multifruta 1 L',
  'Cerveza negra pack x6',
  'Vino blanco chardonnay 750 ml',
  'Sidra dulce 1 L',
  'Energizante 473 ml',
  'Yerba mate con palo 500 g',
  'Yerba mate suave 1 kg',
  'Café molido 500 g',
  'Té en saquitos x25',
  'Arroz doble carolina 1 kg',
  'Arroz integral 1 kg',
  'Fideos mostachol 500 g',
  'Fideos tallarín 500 g',
  'Polenta 500 g',
  'Avena arrollada 500 g',
  'Lentejas 400 g',
  'Porotos alubia 400 g',
  'Garbanzos 400 g',
  'Puré de tomate 520 g',
  'Salsa de tomate 340 g',
  'Mayonesa 500 g',
  'Ketchup 500 g',
  'Mostaza 250 g',
  'Aceite de oliva 500 ml',
  'Aceite mezcla 900 ml',
  'Vinagre de alcohol 1 L',
  'Sal fina 500 g',
  'Pimienta negra 50 g',
  'Azúcar impalpable 250 g',
  'Edulcorante líquido 200 ml',
  'Harina leudante 1 kg',
  'Maicena 200 g',
  'Cacao en polvo 180 g',
  'Leche entera 1 L',
  'Leche descremada 1 L',
  'Leche chocolatada 1 L',
  'Yogur natural 190 g',
  'Yogur frutilla 190 g',
  'Crema de leche 200 ml',
  'Manteca 200 g',
  'Queso cremoso 300 g',
  'Queso rallado 120 g',
  'Dulce de leche 400 g',
  'Jamón cocido 200 g',
  'Salame picado fino 150 g',
  'Panceta ahumada 200 g',
  'Salchichas x6',
  'Huevos blancos x12',
  'Pan lactal 500 g',
  'Tostadas de arroz 150 g',
  'Galletitas saladas 300 g',
  'Galletitas rellenas 250 g',
  'Barra de cereal x6',
  'Chocolate con leche 100 g',
  'Caramelos surtidos 150 g',
  'Chicles menta x20',
  'Palitos salados 100 g',
  'Nachos con queso 150 g',
  'Pochoclo para microondas 100 g',
  'Helado cucurucho x4',
  'Papas fritas congeladas 1 kg',
  'Nuggets de pollo 400 g',
  'Pizza congelada muzzarella',
  'Hamburguesas vacunas x4',
  'Verduras mixtas congeladas 400 g',
  'Espinaca congelada 400 g',
  'Detergente limón 1.25 L',
  'Lavavajillas concentrado 500 ml',
  'Suavizante ropa 900 ml',
  'Jabón en polvo 800 g',
  'Lavandina gel 750 ml',
  'Limpiador multiuso 900 ml',
  'Desodorante de ambiente 360 ml',
  'Esponja multiuso x3',
  'Bolsas de residuo 50x70 x20',
  'Papel film 30 m',
  'Papel aluminio 10 m',
  'Servilletas x100',
  'Shampoo anticaspa 400 ml',
  'Acondicionador 400 ml',
  'Jabón líquido manos 250 ml',
  'Desodorante aerosol 150 ml',
  'Crema dental blanqueadora 90 g',
  'Enjuague bucal 500 ml',
  'Hisopos x100',
  'Algodón 100 g',
  'Pañuelos descartables x6',
  'Toallitas húmedas x80'
] as const

/** Nombre único y legible: cicla el catálogo y agrega presentación solo si hace falta. */
export function productNameAt (index: number, suffix?: string): string {
  const base = PRODUCT_NAMES[index % PRODUCT_NAMES.length]
  const lap = Math.floor(index / PRODUCT_NAMES.length)
  const labeled = lap === 0 ? base : `${base} (${lap + 1})`
  return suffix === undefined || suffix === '' ? labeled : `${labeled} — ${suffix}`
}

export async function ensureCatalog (opts?: {
  categories?: readonly string[]
  brands?: readonly string[]
  providers?: readonly string[]
}): Promise<StockCatalogIds> {
  const categories = opts?.categories ?? DEFAULT_CATEGORIES
  const brands = opts?.brands ?? DEFAULT_BRANDS
  const providers = opts?.providers ?? DEFAULT_PROVIDERS

  const categoryIds: Types.ObjectId[] = []
  for (const name of categories) {
    const row = await CategorieModel.create({ descripcion: name })
    categoryIds.push(row._id as Types.ObjectId)
  }
  const brandIds: Types.ObjectId[] = []
  for (const name of brands) {
    const row = await BrandModel.create({ descripcion: name })
    brandIds.push(row._id as Types.ObjectId)
  }
  const providerIds: Types.ObjectId[] = []
  for (const name of providers) {
    const row = await ProviderModel.create({ descripcion: name })
    providerIds.push(row._id as Types.ObjectId)
  }
  console.log(`   · catálogo: ${categories.length} categorías, ${brands.length} marcas, ${providers.length} proveedores`)
  return { categories: categoryIds, brands: brandIds, providers: providerIds, categoryNames: [...categories] }
}

export interface BucketSpec {
  expiryCivil: string
  available: number
  committed?: number
}

export interface InsertTrackedProductOpts {
  adminId: Types.ObjectId
  catalog: StockCatalogIds
  name: string
  categoryIndex?: number
  brandIndex?: number
  providerIndex?: number
  minimum: number
  expiryAlertDays: number
  buckets: BucketSpec[]
  /** Product age for rotation history completeness. Default: 120 days before today. */
  createdAtCivil?: string
  precioUnitario?: number
  precioCompra?: number
  key?: string
}

export interface InsertedProduct {
  productId: Types.ObjectId
  name: string
  physical: number
  minimum: number
  expiryAlertDays: number
}

export async function insertTrackedProduct (opts: InsertTrackedProductOpts): Promise<InsertedProduct> {
  const today = todayCivil()
  const createdAtCivil = opts.createdAtCivil ?? addCivilDays(today, -120)
  const createdAt = civilToLocalNoon(createdAtCivil)
  const key = opts.key ?? `stock-seed:${opts.name}`
  const buckets = opts.buckets.filter((bucket) => bucket.available + (bucket.committed ?? 0) > 0)
  if (buckets.length === 0) throw new Error(`Product ${opts.name} needs at least one non-empty bucket`)

  const physical = buckets.reduce((sum, bucket) => sum + bucket.available + (bucket.committed ?? 0), 0)
  const category = opts.catalog.categories[opts.categoryIndex ?? 0] ?? opts.catalog.categories[0]
  const brand = opts.catalog.brands[opts.brandIndex ?? 0] ?? opts.catalog.brands[0]
  const provider = opts.catalog.providers[opts.providerIndex ?? 0] ?? opts.catalog.providers[0]
  const precioUnitario = opts.precioUnitario ?? 1500
  const precioCompra = opts.precioCompra ?? Math.round(precioUnitario * 0.65)

  const product = await ProductModel.create({
    descripcion: opts.name,
    stock: physical,
    precioUnitario,
    precioCompra,
    categoria: category,
    marca: brand,
    proveedor: provider,
    inventory: {
      minimum: opts.minimum,
      expiryAlertDays: opts.expiryAlertDays,
      expiryTracking: EXPIRY_TRACKING.TRACKED,
      baselineStatus: BASELINE_STATUS.RECONCILED,
      lastReconciledAt: createdAt,
      lastReconciledBy: opts.adminId
    },
    fixtureNamespace: STOCK_SEED_NAMESPACE,
    fixtureKey: key,
    createdAt,
    updatedAt: createdAt
  })

  const productId = product._id as Types.ObjectId
  let bucketIndex = 0
  for (const bucket of buckets) {
    bucketIndex += 1
    const committed = bucket.committed ?? 0
    const received = bucket.available + committed
    const expiryDate = civilToUtcDate(bucket.expiryCivil)
    const bucketDoc = await StockExpiryBucketModel.create({
      productId,
      expiryDate,
      receivedQuantity: received,
      availableQuantity: bucket.available,
      committedQuantity: committed,
      createdAt,
      updatedAt: createdAt
    })
    await InventoryMovementModel.create({
      productId,
      expiryBucketId: bucketDoc._id,
      type: INVENTORY_MOVEMENT_TYPES.OPENING,
      quantity: received,
      occurredAt: createdAt,
      sourceType: 'SYSTEM_SEED',
      sourceId: STOCK_SEED_NAMESPACE,
      sourceEvent: 'STOCK_SEED_OPENING',
      operationId: `${key}:open:${bucketIndex}`,
      idempotencyKey: `${STOCK_SEED_NAMESPACE}:${key}:open:${bucketIndex}`,
      rulesVersion: STOCK_RULES_VERSION,
      createdBy: opts.adminId,
      createdAt,
      updatedAt: createdAt
    })
  }

  return {
    productId,
    name: opts.name,
    physical,
    minimum: opts.minimum,
    expiryAlertDays: opts.expiryAlertDays
  }
}

export async function insertUntrackedProduct (opts: {
  adminId: Types.ObjectId
  catalog: StockCatalogIds
  name: string
  stock: number
  minimum: number
  categoryIndex?: number
  createdAtCivil?: string
  key?: string
}): Promise<InsertedProduct> {
  const today = todayCivil()
  const createdAtCivil = opts.createdAtCivil ?? addCivilDays(today, -120)
  const createdAt = civilToLocalNoon(createdAtCivil)
  const key = opts.key ?? `stock-seed-ut:${opts.name}`
  const product = await ProductModel.create({
    descripcion: opts.name,
    stock: opts.stock,
    precioUnitario: 1200,
    precioCompra: 800,
    categoria: opts.catalog.categories[opts.categoryIndex ?? 0] ?? opts.catalog.categories[0],
    marca: opts.catalog.brands[0],
    proveedor: opts.catalog.providers[0],
    inventory: {
      minimum: opts.minimum,
      expiryAlertDays: 14,
      expiryTracking: EXPIRY_TRACKING.NOT_TRACKED,
      baselineStatus: BASELINE_STATUS.RECONCILED,
      lastReconciledAt: createdAt,
      lastReconciledBy: opts.adminId
    },
    fixtureNamespace: STOCK_SEED_NAMESPACE,
    fixtureKey: key,
    createdAt,
    updatedAt: createdAt
  })
  const productId = product._id as Types.ObjectId
  if (opts.stock > 0) {
    await InventoryMovementModel.create({
      productId,
      type: INVENTORY_MOVEMENT_TYPES.OPENING,
      quantity: opts.stock,
      occurredAt: createdAt,
      sourceType: 'SYSTEM_SEED',
      sourceId: STOCK_SEED_NAMESPACE,
      sourceEvent: 'STOCK_SEED_OPENING_UNTRACKED',
      operationId: `${key}:open`,
      idempotencyKey: `${STOCK_SEED_NAMESPACE}:${key}:open`,
      rulesVersion: STOCK_RULES_VERSION,
      createdBy: opts.adminId,
      createdAt,
      updatedAt: createdAt
    })
  }
  return { productId, name: opts.name, physical: opts.stock, minimum: opts.minimum, expiryAlertDays: 14 }
}

export async function insertSaleLines (opts: {
  adminId: Types.ObjectId
  productId: Types.ObjectId
  /** One sale per entry; quantity units on that day. */
  lines: Array<{ civilDate: string, quantity: number, cancelled?: boolean }>
  cliente?: string
}): Promise<number> {
  let created = 0
  for (const [index, line] of opts.lines.entries()) {
    if (!Number.isSafeInteger(line.quantity) || line.quantity <= 0) continue
    const occurredAt = civilToLocalNoon(line.civilDate)
    const sale = await SaleModel.create({
      estado: line.cancelled === true ? 'Cancelado' : 'Confirmado',
      total: line.quantity * 1500,
      user: opts.adminId,
      cliente: opts.cliente ?? 'Cliente seed stock',
      paidAt: line.cancelled === true ? undefined : occurredAt,
      createdAt: occurredAt,
      updatedAt: occurredAt
    })
    await ItemSaleModel.create({
      idVenta: sale._id,
      idProducto: opts.productId,
      cantidad: line.quantity,
      total: line.quantity * 1500,
      precioUnitario: 1500,
      estado: line.cancelled !== true,
      createdAt: occurredAt,
      updatedAt: occurredAt
    })
    created += 1
    void index
  }
  return created
}

/** Spread N units as several sales across the last `withinDays` complete days (excludes today). */
export async function seedRotationUnits (opts: {
  adminId: Types.ObjectId
  productId: Types.ObjectId
  totalUnits: number
  withinDays?: number
  rng?: () => number
}): Promise<void> {
  const today = todayCivil()
  const window = opts.withinDays ?? 30
  const rng = opts.rng ?? createRng(42)
  if (opts.totalUnits <= 0) return
  const saleCount = Math.min(12, Math.max(1, Math.ceil(opts.totalUnits / 4)))
  const base = Math.floor(opts.totalUnits / saleCount)
  let remaining = opts.totalUnits
  const lines: Array<{ civilDate: string, quantity: number }> = []
  for (let i = 0; i < saleCount; i += 1) {
    const qty = i === saleCount - 1 ? remaining : Math.max(1, base + randInt(rng, -1, 2))
    const capped = Math.min(qty, remaining)
    if (capped <= 0) break
    remaining -= capped
    const daysAgo = randInt(rng, 1, window)
    lines.push({ civilDate: addCivilDays(today, -daysAgo), quantity: capped })
  }
  await insertSaleLines({ adminId: opts.adminId, productId: opts.productId, lines })
}

export async function disconnect (): Promise<void> {
  await mongoose.disconnect()
}

export async function runScenario (
  name: string,
  description: string,
  load: (adminId: Types.ObjectId, catalog: StockCatalogIds) => Promise<void>
): Promise<void> {
  console.log(`\n═══ Stock seed: ${name} ═══`)
  console.log(description)
  await wipeStockTestDatabase()
  const adminId = await getAdminUserId()
  const catalog = await ensureCatalog()
  await load(adminId, catalog)
  const productCount = await ProductModel.countDocuments({})
  const alertHint = todayCivil()
  console.log(`\n✅ Scenario "${name}" loaded (${productCount} productos).`)
  console.log(`   Business date hoy (BA): ${alertHint}`)
  console.log('   Login: admin / (ADMIN_PASSWORD or 123) — re-login after wipe')
  console.log('   Open /stock-smart → Actualizar')
  await disconnect()
}
