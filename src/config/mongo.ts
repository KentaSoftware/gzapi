import 'dotenv/config'
import { connect, connection } from 'mongoose'

export function getMongoUri (): string {
  const uri = process.env.MONGODB_URI?.trim()
  if (uri === undefined || uri.length === 0) {
    throw new Error('MONGODB_URI is required')
  }
  return uri
}

async function dbConnect (): Promise<void> {
  const mongoUri = getMongoUri()

  try {
    await connect(mongoUri, {
      // Configuración simplificada para MongoDB local
      serverSelectionTimeoutMS: 60000,
      socketTimeoutMS: 120000,
      connectTimeoutMS: 60000,
      maxPoolSize: 10,
      minPoolSize: 1,
      retryWrites: false,
      heartbeatFrequencyMS: 30000,
      maxIdleTimeMS: 60000
    })
    console.log('✅ Conexión exitosa a MongoDB Local')
  } catch (error: unknown) {
    console.error('❌ Error de conexión a MongoDB')
    console.error('⚠️  Verifica que MongoDB está ejecutándose y que MONGODB_URI es válido')
    throw error
  }
}

// Event listeners para monitorear conexión
connection.on('connected', () => {
  console.log('📡 MongoDB conectado')
})

connection.on('disconnected', () => {
  console.warn('⚠️  MongoDB desconectado')
})

connection.on('error', (error) => {
  console.error('❌ Error en MongoDB:', error.message)
})

connection.on('reconnected', () => {
  console.log('🔄 MongoDB reconectado')
})

export default dbConnect
