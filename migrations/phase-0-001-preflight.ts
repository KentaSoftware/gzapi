import { collectPreflight, finalizeArtifact, MIGRATION_IDS, parseMigrationArguments, printArtifact, targetFingerprint, withTargetDatabase } from './phase-0-helpers'

export async function runPreflight (argv: string[]): Promise<void> {
  const options = parseMigrationArguments(argv)
  if (options.dryRun) {
    printArtifact(finalizeArtifact({ migration: MIGRATION_IDS.PREFLIGHT, status: 'dry-run', targetFingerprint: targetFingerprint(options.uri), generatedAt: new Date().toISOString(), plannedActions: ['inventory collections', 'inspect indexes', 'check guarded drift', 'check orphan references'] }))
    return
  }
  const findings = await withTargetDatabase(options.uri, async (db) => await collectPreflight(db, options.driftFile))
  printArtifact(finalizeArtifact({ migration: MIGRATION_IDS.PREFLIGHT, status: 'passed', targetFingerprint: targetFingerprint(options.uri), generatedAt: new Date().toISOString(), approvalId: options.approvalId, ...findings }))
}

if (require.main === module) void runPreflight(process.argv.slice(2)).catch((error: unknown) => { process.stderr.write(`${error instanceof Error ? error.message : 'Migration failed'}\n`); process.exitCode = 1 })
