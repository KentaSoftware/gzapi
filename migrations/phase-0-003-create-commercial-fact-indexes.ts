import { MIGRATION_IDS, MigrationSafetyError, parseMigrationArguments, printArtifact, readProof, runCreateCommercialFactIndexes, targetFingerprint, verifyCommercialFactIndexes, withTargetDatabase } from './phase-0-helpers'

export async function runCreateIndexes (argv: string[]): Promise<void> {
  const options = parseMigrationArguments(argv)
  if (options.preflightProof === undefined || options.preflightProof === '' || options.backupProof === undefined || options.backupProof === '') throw new MigrationSafetyError('Index migration requires --preflight-proof and --backup-proof')
  await readProof(options.preflightProof, MIGRATION_IDS.PREFLIGHT, options.uri)
  const backup = await readProof(options.backupProof, MIGRATION_IDS.BACKUP, options.uri)
  if (backup.restoreVerified !== true || typeof backup.archiveHash !== 'string') throw new MigrationSafetyError('Backup proof has no verified restore and hash')
  const result = await withTargetDatabase(options.uri, async (db) => {
    const indexResult = await runCreateCommercialFactIndexes(db, options.dryRun)
    if (!options.dryRun) await verifyCommercialFactIndexes(db)
    return indexResult
  })
  printArtifact({ migration: MIGRATION_IDS.INDEXES, status: options.dryRun ? 'dry-run' : 'passed', targetFingerprint: targetFingerprint(options.uri), generatedAt: new Date().toISOString(), ...result })
}

if (require.main === module) void runCreateIndexes(process.argv.slice(2)).catch((error: unknown) => { process.stderr.write(`${error instanceof Error ? error.message : 'Migration failed'}\n`); process.exitCode = 1 })
