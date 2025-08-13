import { Request, Response } from 'express'
import { deleteSaleService, getSale, getSales, getSalesLimit, insertSale, qtySale, updateSale } from '../services/sale'
import { emitSocket } from '../socket'
import { handleHttp } from '../utils/error.handle'
import { JwtPayload } from 'jsonwebtoken'
import { Types } from 'mongoose'
import { deleteItemSaleInSale, getItemSale, insertItemSale, updateItemsSale } from '../services/itemSale'
import { ItemSale, Sale } from '../interfaces/sale.interface'
import PDFDocument from 'pdfkit'
import path from 'path'

interface RequestExt extends Request {
  user?: string | JwtPayload | undefined | any
}

const deleteSaleController = async ({ params }: RequestExt, res: Response): Promise<void> => {
  try {
    const { id } = params
    const response = await deleteSaleService(new Types.ObjectId(id))
    await deleteItemSaleInSale(new Types.ObjectId(id))

    res.send(response)
  } catch (e) {
    handleHttp(res, 'ERROR_DELETE_SALE', e)
  }
}

const postItem = async ({ body, user }: RequestExt, res: Response): Promise<void> => {
  try {
    const response = await insertSale({ ...body, user: new Types.ObjectId(user.id) })
    await Promise.all(
      body.itemsSale.map(async (item: any) => await insertItemSale({ idProducto: item._id, total: item.total, cantidad: item.cantidad, idVenta: response._id, estado: true, precioUnitario: item.precio }))
    )
    emitSocket('sale', {
      action: 'create',
      data: response
    })
    res.send(response)
  } catch (e) {
    handleHttp(res, 'ERROR_CREATE_SALE_WITH_ITEMS', e)
  }
}

const postMultipleItem = async ({ body, user }: RequestExt, res: Response): Promise<void> => {
  try {
    await Promise.all(
      body.map(async (item: any) => {

        // Ejecutar insertSale y esperar a que termine antes de continuar con insertItemSale
        const response = await insertSale({ ...item, user: new Types.ObjectId(user.id) })

        // Anidar Promise.all para itemsSale
        await Promise.all(
          item.itemsSale.map(async (item: any) =>
            await insertItemSale({
              idProducto: item._id,
              total: item.total,
              cantidad: item.cantidad,
              idVenta: response._id,
              estado: true, precioUnitario: item.precio
            })
          )
        )
      })
    )
    /*   */
    emitSocket('sale', {
      action: 'create',
      data: 'Ventas guardadas'
    })
    res.send('Ventas guardadas')
  } catch (e) {
    handleHttp(res, 'ERROR_CREATE_MULTIPLE_SALES', e)
  }
}

const getItem = async ({ params }: RequestExt, res: Response): Promise<void> => {
  try {
    const { id } = params
    const response = await getSale(new Types.ObjectId(id))
    const response2 = await getItemSale(new Types.ObjectId(id))
    res.send({ r: response[0], itemsSale: response2 })
  } catch (e) {
    handleHttp(res, 'ERROR_GET_SALE_BY_ID', e)
  }
}

const getItems = async ({ body, user }: RequestExt, res: Response): Promise<void> => {
  try {
    const { input, skip, limit, filterUser } = body
    console.log("filterUserController", filterUser)

    if (input !== undefined) {
      const response = await getSales(input, new Types.ObjectId(user.id), user.role)
      res.send(response)
    } else {
      const response = await getSalesLimit(parseInt(skip), parseInt(limit), new Types.ObjectId(user.id), user.role, filterUser)
      const cantidad = await qtySale(filterUser)
      console.log("cantidad", cantidad)
      res.send({ array: response, longitud: cantidad })
    }
  } catch (e) {
    handleHttp(res, 'ERROR_GET_SALES_LIST', e)
  }
}

const updateItem = async ({ params, body }: RequestExt, res: Response): Promise<void> => {
  try {
    const { id } = params
    const response = await updateSale(new Types.ObjectId(id), { ...body })
    await Promise.all(
      body.itemsSale.map(async (item: any) => {
        // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions
        if (item.idVenta) {
          await updateItemsSale(new Types.ObjectId(item._id), { ...item, precioUnitario: item.precio })
        } else {
          await insertItemSale({ idProducto: item._id, total: item.total, cantidad: item.cantidad, idVenta: new Types.ObjectId(id), estado: true, precioUnitario: item.precio })
        }
      })
    )
    console.log("response", response)
    emitSocket('sale', {
      action: 'update',
      data: response
    })
    res.send(response)
  } catch (e) {
    handleHttp(res, 'ERROR_UPDATE_SALE_WITH_ITEMS', e)
  }
}

const printSale = async (req: Request, res: Response): Promise<void> => {
  try {
    const saleId = new Types.ObjectId(req.params.id)
    const sale: Sale[] = await getSale(saleId)

    if (sale.length === 0) {
      res.status(404).send('Sale not found')
      return
    }

    const itemsSale: ItemSale[] = await getItemSale(saleId)

    const doc = new PDFDocument()

    // Configurar los encabezados para el archivo PDF
    res.setHeader('Content-disposition', `attachment; filename=venta-${sale[0].cliente}.pdf`)
    res.setHeader('Content-type', 'application/pdf')
    doc.pipe(res)

    // Encabezado del documento
    const logoPath = path.join(__dirname, '../../public/image/LOGO.png')
    const logoWidth = 200 // Ancho del logo
    const pageWidth = 595.28 // Ancho de la página A4
    const xPosition = (pageWidth - logoWidth) / 2 // Calcular la posición para centrar
    doc.image(logoPath, xPosition, 40, { width: logoWidth })
    doc.moveDown()
    doc.moveDown()
    doc.fontSize(16).text('Presupuesto', 15, 120)
    doc.fontSize(16).text('Presupuesto', 15, 120)
    doc.fontSize(14).text(`FECHA: ${new Date(sale[0].createdAt).toLocaleDateString()}`, 30, 160)
    doc.moveDown()

    // Encabezado de la tabla
    const tableTop = 220 // Posición vertical para la tabla
    const rowHeight = 20 // Altura de cada fila
    const columnWidths = [150, 100, 100, 100] // Ancho de cada columna
    const headers = ['PRODUCTO', 'CANTIDAD', 'P. UNITARIO', 'TOTAL']

    // Función para dibujar encabezados de la tabla
    const drawTableHeaders = (): any => {
      doc.fillColor('lightgrey') // Color de fondo
        .rect(50, tableTop - rowHeight, columnWidths.reduce((a, b) => a + b), rowHeight)
        .fill()

      doc.fillColor('black').fontSize(12)
      let xPosition2 = 50
      headers.forEach((header, index) => {
        doc.text(header, xPosition2, tableTop - rowHeight + 5)
        xPosition2 += columnWidths[index]
      })
    }

    // Dibujar los encabezados inicialmente
    drawTableHeaders()

    // Inicializar la posición Y para los productos
    let yPosition = tableTop
    let itemsCount = 0
    let currentPage = 1

    // Dibujar productos, dividiendo en páginas si hay más de 20
    itemsSale.forEach((item: ItemSale) => {
      if (itemsCount === 20) {
        // Añadir nueva página cuando hay más de 20 productos
        doc.addPage()
        currentPage++
        yPosition = tableTop - 190
        itemsCount = 0
        /* drawTableHeaders() */
      }

      const descripcion = item.descripcion ?? 'Sin descripción'
      const precioUnitario = (item.precio ? item.precio : item.precioUnitario) ?? 0

      // Agregar texto en las celdas
      doc.fillColor('black')
        .text(descripcion, 50 + 5, yPosition + 5)
        .text(item.cantidad.toString(), 200 + 5, yPosition + 5)
        .text(`$${precioUnitario.toFixed(2)}`, 300 + 5, yPosition + 5)
        .text(`$${item.total.toFixed(2)}`, 400 + 5, yPosition + 5)

      // Incrementar la posición Y para la siguiente fila
      yPosition += rowHeight
      itemsCount++
    })

    // Total
    doc.moveDown(2)
    doc.fontSize(14).text(`TOTAL: $${sale[0].total.toFixed(2)}`, { align: 'right' })
    doc.moveDown(3)
    doc.fontSize(12).text('*No válido como factura', { align: 'center' })

    // Pie de página
    doc.fontSize(10).text(`Pagina ${currentPage} de ${currentPage}`, { align: 'right' })

    // Finalizar el documento
    doc.end()
  } catch (e) {
    handleHttp(res, 'ERROR_PRINT_SALE_PDF', e)
  }
}

const printSales = async (req: Request, res: Response): Promise<void> => {
  try {
    const saleIds = req.body
    const sales: Sale[][] = await Promise.all(saleIds.map(async (id: any) => await getSale(new Types.ObjectId(id))))
    const itemsSales: ItemSale[][] = await Promise.all(saleIds.map(async (id: any) => await getItemSale(new Types.ObjectId(id))))

    const doc = new PDFDocument()
    res.setHeader('Content-disposition', 'attachment; filename=ventas.pdf')
    res.setHeader('Content-type', 'application/pdf')
    doc.pipe(res)

    const logoPath = path.join(__dirname, '../../public/image/LOGO.png')
    const logoWidth = 80 // Ancho del logo
    /* const pageWidth = 620 // Ancho de la página A4 */
    /* const pageHeight = 841.89 */ // Altura de la página A4

    const invoiceWidth = 300 // Ancho de cada factura
    const invoiceHeight = 380 // Altura de cada factura

    let fixIndex = 0
    sales.forEach((sale, index) => {
      let posicionGlobal = fixIndex + 1 // Índice basado en 1 (no en 0)

      if ((fixIndex) !== 0 && ((fixIndex) % 4) === 0) {
        doc.addPage()
      }

      // Calcular la posición dentro de la tabla (fila y columna)
      let posicionEnTabla = (posicionGlobal - 1) % 4 // Rango de 0 a 3
      // Convertir la posición a filas y columnas
      let fila = Math.floor(posicionEnTabla / 2) + 1 // Rango de 1 a 2
      let columna = (posicionEnTabla % 2) + 1 // Rango de 1 a 2

      // Calcular la posición de la factura
      let xPosition = (columna - 1) * invoiceWidth
      let yPosition = (fila - 1) * invoiceHeight


      // Encabezado de la factura
      const drawHeader = (): any => {
        doc.image(logoPath, xPosition + (invoiceWidth - logoWidth) / 2, yPosition + 20, { width: logoWidth })
        doc.moveDown(1)
        doc.fontSize(8).text('Presupuesto', xPosition + 15, yPosition + 50)
        doc.fontSize(8).text(`CLIENTE: ${sale[0].cliente}`, xPosition + 15, yPosition + 60)
        doc.fontSize(8).text(`FECHA: ${new Date(sale[0].createdAt).toLocaleDateString()}`, xPosition + 15, yPosition + 70)
        doc.moveDown(1)
      }

      drawHeader()

      // Encabezado de la tabla
      let tableTop = yPosition + 90 // Ajustar la posición vertical para la tabla
      const rowHeight = 10 // Altura de cada fila
      const columnWidths = [85, 60, 60, 60] // Ancho de cada columna
      const headers = ['PRODUCTO', 'CANTIDAD', 'P. UNITARIO', 'TOTAL']

      // Dibujar encabezados con fondo
      const drawTableHeaders = (): any => {
        doc.fillColor('lightgrey')
          .rect(
            xPosition + 15,
            tableTop - rowHeight, // Usa isJump ?? false
            columnWidths.reduce((a, b) => a + b),
            rowHeight + 2
          )
          .fill()

        // Agregar los encabezados
        doc.fillColor('black').fontSize(8)
        let xPosition2 = xPosition + 25
        headers.forEach((header, index) => {
          doc.text(header, xPosition2, tableTop - rowHeight + 5, { width: 60 })
          xPosition2 += columnWidths[index]
        })
      }

      drawTableHeaders()

      // Inicializar la posición Y para los productos
      let yPositionProducts = tableTop
      let itemsCount = 0
      let currentPage = 1
      // Dibujar líneas de la tabla
      const itemsSale = itemsSales[index] // Obtener los items correspondientes a la venta actual
      itemsSale.forEach((item: ItemSale, indexItemSale: number) => {
        const descripcion = item.descripcion ?? 'Sin descripción'

        const precioUnitario = (item.precio ? item.precio : item.precioUnitario) ?? 0

        if (itemsCount === 18) {
          currentPage++
          fixIndex++
          posicionGlobal = fixIndex + 1
          if ((fixIndex) !== 0 && ((fixIndex) % 4) === 0) {
            doc.addPage()
          }
          posicionEnTabla = (posicionGlobal - 1) % 4
          fila = Math.floor(posicionEnTabla / 2) + 1
          columna = (posicionEnTabla % 2) + 1
          xPosition = (columna - 1) * invoiceWidth
          yPosition = (fila - 1) * invoiceHeight
          tableTop = yPosition + 90
          yPositionProducts = tableTop
          itemsCount = 0
          drawHeader()
          drawTableHeaders()
        }

        // Agregar texto en las celdas
        doc.fontSize(9).fillColor('black')
          .text(descripcion, xPosition + 15, yPositionProducts + 10)
          .text(item.cantidad.toString(), xPosition + 155, yPositionProducts + 10)
          .text(`$${precioUnitario.toFixed(2)}`, xPosition + 185, yPositionProducts + 10)
          .text(`$${item.total.toFixed(2)}`, xPosition + 235, yPositionProducts + 10, { width: 60 })

        // Incrementar la posición Y para la siguiente fila
        yPositionProducts += rowHeight
        itemsCount++
        if (itemsCount === 18 || indexItemSale + 1 === itemsSale.length) {
          // Posición del total
          doc.moveDown(2)
          doc.fontSize(9).text(`TOTAL: $${sale[0].total.toFixed(2)}`, xPosition + 180, undefined, { width: 100 })
          doc.fontSize(6).text('*No válido como factura', xPosition + 180, undefined, { width: 100 })

          // Pie de página
          // eslint-disable-next-line @typescript-eslint/restrict-plus-operands
          doc.fontSize(6).text('Página ' + currentPage + ' de ' + (Math.floor(itemsSale.length / 18) + 1), xPosition + 180, undefined, { width: 100 })
        }
      })

      fixIndex++
    })

    // Finalizar el documento
    doc.end()
  } catch (e: any) {
    console.error('Error al generar el PDF:', e.message, e.stack)
    handleHttp(res, 'ERROR_PRINT_MULTIPLE_SALES_PDF', e)
  }
}

export { postItem, getItem, getItems, updateItem, postMultipleItem, printSale, printSales, deleteSaleController }
