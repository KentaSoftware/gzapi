import { Request, Response } from 'express'
import { handleHttp } from '../utils/error.handle'
import { Types } from 'mongoose'
import { JwtPayload } from 'jsonwebtoken'
import { emitSocket } from '../socket'
import { findProducts, getAllProducts, getAllProductsCategories, getProduct, getProducts, getProductsSearch, insertProduct, qtyProduct, updateProduct } from '../services/product'
import { Product } from '../interfaces/product.interface'
import { ObjectId } from 'mongodb'
import PDFDocument from 'pdfkit'
import path from 'path'

interface RequestExt extends Request {
  user?: string | JwtPayload | undefined | any
}

const getNothing = async (_: RequestExt, res: Response): Promise<void> => {
  try {
    res.send('')
  } catch (e) {
    handleHttp(res, 'ERROR_GET_ITEM')
  }
}

const getItem = async ({ params }: RequestExt, res: Response): Promise<void> => {
  try {
    const { id } = params
    const response = await getProduct(new Types.ObjectId(id))
    res.send(response)
  } catch (e) {
    handleHttp(res, 'ERROR_GET_ITEM')
  }
}

const getItems = async ({ body }: RequestExt, res: Response): Promise<void> => {
  try {
    const { input, skip, limit } = body

    console.log('input', input, skip, limit)

    const filter = {
      categoria: body.categoria,
      marca: body.marca,
      proveedor: body.proveedor
    }

    if (body.categoria !== '' && body.categoria !== 1 && body.categoria !== undefined) {
      filter.categoria = ObjectId.createFromHexString(body.categoria)
    } else {
      delete filter.categoria
    }

    if (body.marca !== '' && body.marca !== 1 && body.marca !== undefined) {
      filter.marca = ObjectId.createFromHexString(body.marca)
    } else {
      delete filter.marca
    }

    if (body.proveedor !== '' && body.proveedor !== 1 && body.proveedor !== undefined) {
      filter.proveedor = ObjectId.createFromHexString(body.proveedor)
    } else {
      delete filter.proveedor
    }

    if (input !== undefined || filter.categoria !== undefined || filter.marca !== undefined || filter.proveedor !== undefined) {
      const response = await getProductsSearch(input, filter)
      res.send(response)
    } else {
      const response = await getProducts(parseInt(skip), parseInt(limit))
      const cantidad = await qtyProduct()
      res.send({ array: response, longitud: cantidad })
    }
  } catch (e) {
    handleHttp(res, 'ERROR_GET_ITEMS')
  }
}
const uptdateItem = async ({ params, body }: Request, res: Response): Promise<void> => {
  try {
    const { id } = params
    const response = await updateProduct(new Types.ObjectId(id), { ...body, categoria: new Types.ObjectId(body.categoria), marca: new Types.ObjectId(body.marca), proveedor: new Types.ObjectId(body.proveedor) })
    emitSocket('product', {
      action: 'update',
      data: body
    })
    res.send(response)
  } catch (e) {
    handleHttp(res, 'ERROR_UPDATE_ITEM')
  }
}
const uptdateItems = async ({ body }: Request, res: Response): Promise<void> => {
  try {
    const filter = {
      categoria: body.categoria,
      marca: body.marca,
      proveedor: body.proveedor
    }

    const porcentaje: number = body.porcentaje

    if (body.categoria !== '') {
      filter.categoria = new Types.ObjectId(body.categoria)
    } else {
      delete filter.categoria
    }

    if (body.marca !== '') {
      filter.marca = new Types.ObjectId(body.marca)
    } else {
      delete filter.marca
    }

    if (body.proveedor !== '') {
      filter.proveedor = new Types.ObjectId(body.proveedor)
    } else {
      delete filter.proveedor
    }

    const products = await findProducts(filter)

    const response = products.map(async (item: Product): Promise<Product> => {
      const newPrice = parseFloat((item.precioUnitario + (item.precioUnitario * porcentaje) / 100).toFixed(2))
      item.precioUnitario = newPrice
      await updateProduct(item._id, item)
      return item
    })

    emitSocket('product', {
      action: 'updateMany',
      data: response
    })
    res.send(response)
  } catch (e) {
    handleHttp(res, 'ERROR_UPDATE_ITEM')
  }
}
const postItem = async ({ body }: Request, res: Response): Promise<void> => {
  try {
    const response = await insertProduct({ ...body, categoria: new Types.ObjectId(body.categoria), marca: new Types.ObjectId(body.marca), proveedor: new Types.ObjectId(body.proveedor) })
    emitSocket('product', {
      action: 'create',
      data: response
    })
    res.send(response)
  } catch (e) {
    handleHttp(res, 'ERROR_POST_ITEM', e)
  }
}
const deleteItem = (_: Request, res: Response): void => {
  try {
    res.send({ data: 'algo' })
  } catch (e) {
    handleHttp(res, 'ERROR_DELETE_ITEM')
  }
}

const uploadImage = async (req: Request, res: Response): Promise<void> => {
  try {
    res.send(req.file)
  } catch (e) {
    handleHttp(res, 'ERROR_POST_ITEM', e)
  }
}

const getImage = async (req: Request, res: Response): Promise<void> => {
  try {
    const image = req.params.image
    const path = `../../public/image/${image}`
    res.sendFile(path)
  } catch (e) {
    handleHttp(res, 'ERROR_GET_ITEM', e)
  }
}

const getAllItems = async (_: RequestExt, res: Response): Promise<void> => {
  try {
    const response = await getAllProducts()
    res.send(response)
  } catch (e) {
    handleHttp(res, 'ERROR_GET_ITEMS')
  }
}

const printList = async ({ body }: RequestExt, res: Response): Promise<void> => {
  try {
    const { categories, isPrecioUnitario } = body
    const products = await getAllProductsCategories(categories)
    if (products.length === 0) {
      res.status(404).send('Products not found')
      return
    }
    const doc = new PDFDocument()
    res.setHeader('Content-disposition', 'attachment; filename=ListaDePrecios.pdf')
    res.setHeader('Content-type', 'application/pdf')
    doc.pipe(res)
    const logoPath = path.join(__dirname, '../../public/image/LOGO.png')
    doc.image(logoPath, 450, 5, { width: 100 })
    let categorieActive: (string | undefined) = ''

    // Agregar el listener solo una vez
    doc.on('pageAdded', () => doc.image(logoPath, 450, 5, { width: 100 }));

    products.forEach((itemProduct: Product) => {
      if (itemProduct.NameCategoria !== categorieActive) {
        categorieActive = itemProduct.NameCategoria
        doc.fontSize(18).font('Helvetica-Bold').fillColor('#3764A0')
          .text(`${categorieActive}`, 25)
      }

      const yPosition = doc.y;

      // Escribir la descripción del producto
      doc.fontSize(14).font('Helvetica').fillColor('black')
        .text(`${itemProduct.descripcion}`, 50, yPosition);

      // Escribir el precio del producto en la misma posición Y
      if (itemProduct.precioDescuento !== undefined && itemProduct.precioDescuento > 0) {
        if (isPrecioUnitario || isPrecioUnitario === undefined) {
          doc.fontSize(14).font('Helvetica-Bold').fillColor('#FA9B50')
            .text(`$ ${itemProduct.precioUnitario}`, 440, yPosition);
        } else {
          doc.fontSize(14).font('Helvetica-Bold').fillColor('#FA9B50')
            .text(`$ ${itemProduct.precioDescuento}`, 440, yPosition);
        }
      } else {
        doc.fontSize(14).font('Helvetica-Bold').fillColor('#FA9B50')
          .text(`$ ${itemProduct.precioUnitario}`, 440, yPosition);
      }

      doc.moveDown(0.1);

      doc.lineWidth(0.5);
      doc.strokeColor('#d9d9d9');

      doc.moveTo(20, doc.y)
        .lineTo(550, doc.y)
        .stroke();

      doc.moveDown(0.3);

      if (yPosition > 680) {
        doc.addPage()
      }
    })

    // Finalizar el documento
    doc.end()
  } catch (e) {
    handleHttp(res, 'ERROR_PRINT_LIST')
  }
}

const printListWithDiscount = async ({ body }: RequestExt, res: Response): Promise<void> => {
  try {
    const { categories, discount }: { categories: { conDescuento: { _id: string, descripcion: string }[], sinDescuento: { _id: string, descripcion: string }[] }, discount: number } = body
    let categoriesArray: string[] = []
    categories.conDescuento.forEach(item => {
      categoriesArray.push(item.descripcion)
    })
    categories.sinDescuento.forEach(item => {
      categoriesArray.push(item.descripcion)
    })
    const products = await getAllProductsCategories(categoriesArray)

    if (products.length === 0) {
      res.status(404).send('Products not found')
      return
    }
    const doc = new PDFDocument()
    res.setHeader('Content-disposition', 'attachment; filename=ListaDePrecios.pdf')
    res.setHeader('Content-type', 'application/pdf')
    doc.pipe(res)
    const logoPath = path.join(__dirname, '../../public/image/LOGO.png')
    doc.image(logoPath, 450, 5, { width: 100 })
    let categorieActive: (string | undefined) = ''

    // Agregar el listener solo una vez
    doc.on('pageAdded', () => doc.image(logoPath, 450, 5, { width: 100 }));

    products.forEach((itemProduct: Product) => {
      if (itemProduct.NameCategoria !== categorieActive) {
        categorieActive = itemProduct.NameCategoria
        doc.fontSize(18).font('Helvetica-Bold').fillColor('#3764A0')
          .text(`${categorieActive}`, 25)
      }

      const yPosition = doc.y;

      // Escribir la descripción del producto
      doc.fontSize(14).font('Helvetica').fillColor('black')
        .text(`${itemProduct.descripcion}`, 50, yPosition);

      // Calcular el precio con descuento si el producto pertenece a una categoría seleccionada
      let precioFinal = itemProduct.precioUnitario;
      let isDescuento = categories.conDescuento.find(elem => elem.descripcion === itemProduct.NameCategoria) ? true : false
      let isNormal = categories.sinDescuento.find(elem => elem.descripcion === itemProduct.NameCategoria) ? true : false
      if (isDescuento) {
        precioFinal = itemProduct.precioUnitario * (1 - discount);
      } else if (isNormal) {
        precioFinal = itemProduct.precioUnitario
      }
      // Escribir el precio del producto en la misma posición Y
      doc.fontSize(14).font('Helvetica-Bold').fillColor('#FA9B50')
        .text(`$ ${precioFinal.toFixed(2)}`, 440, yPosition);

      doc.moveDown(0.1);

      doc.lineWidth(0.5);
      doc.strokeColor('#d9d9d9');

      doc.moveTo(20, doc.y)
        .lineTo(550, doc.y)
        .stroke();

      doc.moveDown(0.3);

      if (yPosition > 680) {
        doc.addPage()
      }
    })

    // Finalizar el documento
    doc.end()

  } catch (e) {
    handleHttp(res, 'ERROR_PRINT_LIST')
  }
}

export { getItem, getItems, uptdateItem, postItem, deleteItem, uptdateItems, uploadImage, getImage, getAllItems, getNothing, printList, printListWithDiscount }
