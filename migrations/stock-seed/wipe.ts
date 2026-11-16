/**
 * Wipe ONLY test_route_plan (safety-locked), then recreate admin/roles.
 * Usage: npm run seed:stock:wipe
 */

import { wipeStockTestDatabase, disconnect } from './lib'

async function main (): Promise<void> {
  await wipeStockTestDatabase()
  await disconnect()
}

main().catch(async (err) => {
  console.error('❌', err instanceof Error ? err.message : err)
  try { await disconnect() } catch { /* ignore */ }
  process.exit(1)
})
