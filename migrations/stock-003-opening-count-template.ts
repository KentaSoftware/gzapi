import { withTargetDatabase } from './phase-0-helpers'
import { buildOpeningTemplate, emitJson, parseStockMigrationArguments, type ProductTemplateSource } from './stock-helpers'

export async function runOpeningCountTemplate (argv: string[]): Promise<void> {
  const options = parseStockMigrationArguments(argv)
  if (options.dryRun) {
    await emitJson({ status: 'dry-run', plannedShape: { productId: 'ObjectId', descripcion: 'string', countedQuantity: null, expiryDate: null }, businessDataMutated: false }, options.output)
    return
  }
  const products = await withTargetDatabase(options.uri, async (db) => await db.collection<ProductTemplateSource>('products').find({}, { projection: { _id: 1, descripcion: 1 } }).sort({ _id: 1 }).toArray())
  await emitJson(buildOpeningTemplate(products), options.output)
}

if (require.main === module) void runOpeningCountTemplate(process.argv.slice(2)).catch((error: unknown) => { process.stderr.write(`${error instanceof Error ? error.message : 'Migration failed'}\n`); process.exitCode = 1 })
