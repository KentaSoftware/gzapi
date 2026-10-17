import { collectStockPreflight, parseStockMigrationArguments, printStockArtifact, STOCK_MIGRATION_IDS } from './stock-helpers'
import { withTargetDatabase } from './phase-0-helpers'

export async function runStockPreflight (argv: string[]): Promise<void> {
  const options = parseStockMigrationArguments(argv)
  if (options.dryRun) {
    printStockArtifact(STOCK_MIGRATION_IDS.PREFLIGHT, 'dry-run', options.uri, {
      approvalId: options.approvalId,
      plannedActions: [
        'count products',
        'count sales',
        'count itemsales',
        'count buys',
        'count itembuys',
        'count inventorymovements',
        'count stockexpirybuckets',
        'inspect indexes for every existing Stock source collection',
        'report required Stock fields',
        'report orphan item-sale and item-buy references'
      ],
      businessDataMutated: false
    })
    return
  }
  const report = await withTargetDatabase(options.uri, async (db) => await collectStockPreflight(db))
  printStockArtifact(STOCK_MIGRATION_IDS.PREFLIGHT, 'passed', options.uri, {
    approvalId: options.approvalId,
    approvalEvidence: { environment: options.environment, confirmation: options.confirmation },
    ...report,
    businessDataMutated: false
  })
}

if (require.main === module) void runStockPreflight(process.argv.slice(2)).catch((error: unknown) => { process.stderr.write(`${error instanceof Error ? error.message : 'Migration failed'}\n`); process.exitCode = 1 })
