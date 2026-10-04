import { collectPreflight, MIGRATION_IDS, MigrationSafetyError, parseMigrationArguments, printArtifact, readProof, targetFingerprint, verifyCommercialFactIndexes, withTargetDatabase } from './phase-0-helpers'

export async function runVerification (argv: string[]): Promise<void> {
  const options = parseMigrationArguments(argv)
  if (options.preflightProof === undefined || options.preflightProof === '' || options.backupProof === undefined || options.backupProof === '') throw new MigrationSafetyError('Verification requires --preflight-proof and --backup-proof')
  await readProof(options.preflightProof, MIGRATION_IDS.PREFLIGHT, options.uri)
  await readProof(options.backupProof, MIGRATION_IDS.BACKUP, options.uri)
  if (options.dryRun) {
    printArtifact({ migration: MIGRATION_IDS.VERIFY, status: 'dry-run', targetFingerprint: targetFingerprint(options.uri), generatedAt: new Date().toISOString(), plannedActions: ['re-read inventory', 'verify commercialfacts indexes', 're-check guarded drift'] })
    return
  }
  const findings = await withTargetDatabase(options.uri, async (db) => {
    await verifyCommercialFactIndexes(db)
    return await collectPreflight(db, options.driftFile)
  })
  printArtifact({ migration: MIGRATION_IDS.VERIFY, status: 'passed', targetFingerprint: targetFingerprint(options.uri), generatedAt: new Date().toISOString(), ...findings })
}

if (require.main === module) void runVerification(process.argv.slice(2)).catch((error: unknown) => { process.stderr.write(`${error instanceof Error ? error.message : 'Migration failed'}\n`); process.exitCode = 1 })
