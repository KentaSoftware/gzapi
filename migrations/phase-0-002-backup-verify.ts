import { createHash } from 'crypto'
import { createReadStream } from 'fs'
import { stat } from 'fs/promises'
import { collectDatabaseInventory, MIGRATION_IDS, MigrationSafetyError, parseMigrationArguments, printArtifact, readProof, runDatabaseTool, targetFingerprint, withTargetDatabase } from './phase-0-helpers'

async function sha256File (filePath: string): Promise<string> {
  await stat(filePath)
  return await new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    createReadStream(filePath).on('error', reject).on('data', (chunk: string | Buffer) => { hash.update(chunk) }).on('end', () => resolve(hash.digest('hex')))
  })
}

export async function runBackupVerification (argv: string[]): Promise<void> {
  const options = parseMigrationArguments(argv)
  if (options.preflightProof === undefined || options.preflightProof === '') throw new MigrationSafetyError('Missing required --preflight-proof')
  await readProof(options.preflightProof, MIGRATION_IDS.PREFLIGHT, options.uri)
  const { archive, restoreUri, backupId } = options
  if (archive === undefined || archive === '' || restoreUri === undefined || restoreUri === '' || backupId === undefined || backupId === '') throw new MigrationSafetyError('Backup requires --archive, --restore-uri, and --backup-id')
  if (targetFingerprint(options.uri) === targetFingerprint(restoreUri)) throw new MigrationSafetyError('Restore URI must be isolated from the target')
  if (options.dryRun) {
    printArtifact({ migration: MIGRATION_IDS.BACKUP, status: 'dry-run', targetFingerprint: targetFingerprint(options.uri), generatedAt: new Date().toISOString(), plannedActions: ['mongodump archive', 'sha256 archive', 'isolated mongorestore', 'compare inventory'] })
    return
  }
  const sourceInventory = await withTargetDatabase(options.uri, async (db) => await collectDatabaseInventory(db))
  await runDatabaseTool('mongodump', [`--uri=${options.uri}`, `--archive=${archive}`])
  const archiveHash = await sha256File(archive)
  await runDatabaseTool('mongorestore', [`--uri=${restoreUri}`, `--archive=${archive}`, '--drop'])
  const restoredInventory = await withTargetDatabase(restoreUri, async (db) => await collectDatabaseInventory(db))
  if (JSON.stringify(sourceInventory) !== JSON.stringify(restoredInventory)) throw new MigrationSafetyError('Backup restore inventory does not match the target')
  printArtifact({ migration: MIGRATION_IDS.BACKUP, status: 'passed', targetFingerprint: targetFingerprint(options.uri), generatedAt: new Date().toISOString(), backupId, archiveHash, restoreVerified: true, sourceInventory, restoredInventory })
}

if (require.main === module) void runBackupVerification(process.argv.slice(2)).catch((error: unknown) => { process.stderr.write(`${error instanceof Error ? error.message : 'Migration failed'}\n`); process.exitCode = 1 })
