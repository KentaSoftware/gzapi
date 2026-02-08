import 'dotenv/config'
import { connect, connection } from 'mongoose'

async function dbConnect (): Promise<void> {
  const MONGODB_URI = process.env.MONGODB_URI as string
  
  try {
    await connect(MONGODB_URI, {
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
  } catch (error: any) {
    console.error('❌ Error de conexión a MongoDB:', error.message)
    console.error('⚠️  Verifica que MongoDB está ejecutándose en localhost:27017')
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
