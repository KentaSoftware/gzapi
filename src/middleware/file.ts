/* import { NextFunction, Request, Response } from 'express'
import multer, { diskStorage } from 'multer'
import sharp from 'sharp'

const PATH_STORAGE = `${process.cwd()}/public/image`

const storage = diskStorage({
  destination (__: Request, _: Express.Multer.File, cb: any) {
    cb(null, PATH_STORAGE)
    console.log('path', PATH_STORAGE)
  },
  filename (_: Request, file: Express.Multer.File, cb: any) {
    console.log('file', file)
    const ext = file.originalname.split('.').pop()
    console.log('ext', ext)
    // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
    const fileNameRandom = `image-${Date.now()}.${ext}`
    console.log('nameRandom', fileNameRandom)
    cb(null, fileNameRandom)
  }
})

const multerMiddleware = multer({ storage })

export const compressImage = async (req: Request, _: Response, next: NextFunction): Promise<void> => {
  console.log('entre aqui')
  if (req.file != null) {
    try {
      const buffer = await sharp(req.file.path)
        .rotate() // Adjust dimensions as needed
        .webp({ quality: 20 }) // Adjust quality as needed
        .toBuffer()
      console.log('Image compressed successfully!')
      await sharp(buffer).toFile(`${PATH_STORAGE}/${req.file.filename}`)
      next()
    } catch (error) {
      console.error('Error compressing image:', error)
    }
  } else {
    next() // Proceed if no image is present
  }
}

export default multerMiddleware
 */
