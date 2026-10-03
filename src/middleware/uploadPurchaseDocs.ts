import { Request, Response, NextFunction } from 'express'
import multer, { StorageEngine } from 'multer'
import path from 'path'
import fs from 'fs'

// Configuración de límites y tipos permitidos
const UPLOAD_MAX_SIZE = parseInt(process.env.UPLOAD_MAX_SIZE || '10485760', 10) // 10MB por defecto
const ALLOWED_MIMES = (process.env.UPLOAD_ALLOWED_MIMES || 'image/jpeg,image/png,image/webp,application/pdf').split(',')

// Directorio de almacenamiento
const UPLOAD_DIR = path.join(process.cwd(), 'public', 'uploads', 'purchase-docs')

// Crear directorio si no existe
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true })
}

/**
 * Sanitiza el nombre de archivo removiendo caracteres especiales
 */
const sanitizeFilename = (filename: string): string => {
  return filename
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // Quitar acentos
    .replace(/[^a-zA-Z0-9._-]/g, '_') // Reemplazar caracteres especiales
    .toLowerCase()
}

/**
 * Configuración de almacenamiento para multer
 */
const storage: StorageEngine = multer.diskStorage({
  destination: (_req: Request, _file: Express.Multer.File, cb) => {
    cb(null, UPLOAD_DIR)
  },
  filename: (_req: Request, file: Express.Multer.File, cb) => {
    const ext = path.extname(file.originalname)
    const nameWithoutExt = path.basename(file.originalname, ext)
    const sanitizedName = sanitizeFilename(nameWithoutExt)
    const timestamp = Date.now()
    const randomSuffix = Math.random().toString(36).substring(2, 8)
    const uniqueFilename = `${sanitizedName}-${timestamp}-${randomSuffix}${ext}`
    cb(null, uniqueFilename)
  }
})

/**
 * Filtro de archivos: valida tipo MIME
 */
const fileFilter = (
  _req: Request,
  file: Express.Multer.File,
  cb: multer.FileFilterCallback
): void => {
  if (ALLOWED_MIMES.includes(file.mimetype)) {
    cb(null, true)
  } else {
    cb(
      new Error(
        `Tipo de archivo no permitido: ${file.mimetype}. Permitidos: ${ALLOWED_MIMES.join(', ')}`
      )
    )
  }
}

/**
 * Configuración de multer para purchase docs
 */
const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: UPLOAD_MAX_SIZE
  }
})

/**
 * Middleware para manejar upload de un solo archivo
 */
export const uploadPurchaseDoc = upload.single('file')

/**
 * Middleware para manejar errores de multer
 */
export const handleUploadError = (
  err: any,
  _req: Request,
  res: Response,
  next: NextFunction
): void => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      res.status(400).json({
        success: false,
        error: 'Archivo demasiado grande',
        details: {
          maxSize: UPLOAD_MAX_SIZE,
          maxSizeMB: (UPLOAD_MAX_SIZE / 1024 / 1024).toFixed(2)
        }
      })
      return
    }
    res.status(400).json({
      success: false,
      error: `Error de carga: ${err.message}`,
      code: err.code
    })
    return
  }

  if (err) {
    res.status(400).json({
      success: false,
      error: err.message || 'Error al procesar archivo'
    })
    return
  }

  next()
}

/**
 * Middleware para validar que el archivo existe en el request
 */
export const validateFileExists = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  if (req.file == null) {
    res.status(400).json({
      success: false,
      error: 'Archivo requerido',
      details: {
        field: 'file',
        allowedMimes: ALLOWED_MIMES,
        maxSizeMB: (UPLOAD_MAX_SIZE / 1024 / 1024).toFixed(2)
      }
    })
    return
  }
  next()
}

/**
 * Utilidad para obtener ruta relativa del archivo
 */
export const getRelativePath = (absolutePath: string): string => {
  const publicIndex = absolutePath.indexOf('public')
  if (publicIndex === -1) {
    return absolutePath
  }
  return absolutePath.substring(publicIndex + 6) // Quitar "public"
}

/**
 * Utilidad para eliminar archivo físico
 */
export const deleteFile = (filePath: string): void => {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath)
    }
  } catch (error) {
    console.error('Error eliminando archivo:', error)
  }
}
