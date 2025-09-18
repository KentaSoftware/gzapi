import { MongoClient } from 'mongodb'

export async function ensureLogTTL (): Promise<void> {
  const uri = process.env.LOG_MONGO_URI || process.env.MONGODB_URI
  const collection = process.env.LOG_COLLECTION || 'app_logs'
  const ttlDays = parseInt(process.env.LOG_TTL_DAYS || '14', 10)
  if (!uri) return

  const client = new MongoClient(uri)
  await client.connect()
  const db = client.db()

  await db.collection(collection).createIndex({ ts: 1 }, { expireAfterSeconds: ttlDays * 24 * 60 * 60 })

  // índices adicionales útiles
  await db.collection(collection).createIndex({ collection: 1, action: 1, ts: -1 })
  await db.collection(collection).createIndex({ requestId: 1 })
  await db.collection(collection).createIndex({ userId: 1, ts: -1 })

  await client.close()
}


