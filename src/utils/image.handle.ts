/* import { existsSync, mkdirSync, unlinkSync } from 'fs'
import path from 'path'
import sharp from 'sharp'

const imageDir = path.join(__dirname, '..', '..', 'public')

function saveImages (file: any): string {
  const tempPath = file.path
  const targetDir = path.join(__dirname, '..', '..', 'public', 'images')
  const targetPath = path.join(targetDir, file.originalname)

  // Crear la carpeta de destino si no existe
  if (!existsSync(targetDir)) {
    mkdirSync(targetDir, { recursive: true })
  }

  sharp(tempPath)
    .rotate()
    .jpeg({ quality: 20 }) // Comprime la imagen en formato JPEG con calidad del 80%
    .toFile(targetPath, (err: any) => {
      if (err !== undefined) {
        console.error('Error al comprimir la imagen:', err)
        return
      }

      unlinkSync(tempPath)
    })

  // Devolver el path de la imagen guardada
  // eslint-disable-next-line @typescript-eslint/restrict-plus-operands
  return '/images/' + file.originalname
}

function deleteImage (filename: string): void {
  const imagePath = path.join(imageDir, filename)

  // Verificar si el archivo existe
  if (existsSync(imagePath)) {
    // Eliminar el archivo
    unlinkSync(imagePath)
    console.log('Imagen eliminada:', filename)
  } else {
    console.log('La imagen no existe:', filename)
  }
}

export { deleteImage, saveImages }
 */
