import { withTargetDatabase } from './phase-0-helpers'
import { assertStockMutationProofs, createStockIndexes, parseStockMigrationArguments, printStockArtifact, STOCK_MIGRATION_IDS, verifyExpectedStockIndexes } from './stock-helpers'

export async function runStockIndexes (argv: string[]): Promise<void> {
  const options = parseStockMigrationArguments(argv)
  if (options.dryRun) {
    const result = await createStockIndexes({ collection: () => { throw new Error('Dry-run collection access is forbidden') } }, true)
    printStockArtifact(STOCK_MIGRATION_IDS.INDEXES, 'dry-run', options.uri, { approvalId: options.approvalId, ...result, businessDataMutated: false })
    return
  }
  await assertStockMutationProofs(options)
  const result = await withTargetDatabase(options.uri, async (db) => {
    const applied = await createStockIndexes(db, false)
    const verification = await verifyExpectedStockIndexes(db)
    if (!verification.passed) throw new Error(`Stock index verification failed: ${verification.missingCollections.concat(verification.missingIndexes).join(', ')}`)
    return { ...applied, verification }
  })
  printStockArtifact(STOCK_MIGRATION_IDS.INDEXES, 'passed', options.uri, { approvalId: options.approvalId, ...result })
}

if (require.main === module) void runStockIndexes(process.argv.slice(2)).catch((error: unknown) => { process.stderr.write(`${error instanceof Error ? error.message : 'Migration failed'}\n`); process.exitCode = 1 })
