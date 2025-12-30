import { Types } from 'mongoose'
import DraftPurchaseDocModel from '../models/draftPurchaseDoc'
import BuyModel from '../models/buy'
import ProductModel from '../models/product'
import {
  DraftPurchaseDoc,
  DraftStatus,
  AnalyzeResult,
  PossibleDuplicate,
  ConfirmItem,
  NewProductData,
  HeaderEdits
} from '../interfaces/draftPurchaseDoc.interface'
import { checkForDuplicates } from './duplicateCheck'
import { CheckDuplicateRequestDTO } from '../interfaces/duplicateCheck.interface'
import { insertItemBuy } from './itemBuy'
import * as fs from 'fs'
import * as path from 'path'
import axios from 'axios'

// Configuración de Document AI
const DOCUMENT_AI_URL = process.env.DOCUMENT_AI_URL || 'http://localhost:8000'
const DOCUMENT_AI_TIMEOUT = parseInt(process.env.DOCUMENT_AI_TIMEOUT || '240000', 10)
const DOCUMENT_AI_DEBUG = parseInt(process.env.DOCUMENT_AI_DEBUG || '1', 10) // 0=off, 1=on (Document AI solo acepta bool)
/**
 * Delay con exponential backoff
 */
const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/**
 * Transforma el resultado de Document AI al formato esperado por DraftPurchaseDoc
 * Document AI devuelve objetos { value, origin, confidence, rawText }
 * Necesitamos extraer solo los valores simples
 */
const transformDocumentAIResult = (aiResult: any): AnalyzeResult => {
  // Helper para extraer valor de objeto estructurado o devolver el valor directo
  const extractValue = (field: any): any => {
    if (field && typeof field === 'object' && 'value' in field) {
      return field.value
    }
    return field
  }

  return {
    header: {
      documentNumber: aiResult.header ? extractValue(aiResult.header.documentNumber) : undefined,
      documentDate: aiResult.header ? extractValue(aiResult.header.date) : undefined,
      providerName: aiResult.header ? (extractValue(aiResult.header.provider?.name) || aiResult.header.provider?.name) : undefined,
      providerId: aiResult.header ? (extractValue(aiResult.header.provider?.id) || aiResult.header.provider?.id) : undefined,
      total: aiResult.header ? extractValue(aiResult.header.total) : undefined,
      confidence: aiResult.header ? (aiResult.header.total?.confidence || aiResult.confidenceGlobal || 0) : 0
    },
    items: aiResult.items?.map((item: any, index: number) => ({
      itemId: item.lineId || `L${index + 1}`,
      description: item.normalizedDescription || item.rawDescription || '',
      quantity: extractValue(item.quantity) || 0,
      unitPrice: extractValue(item.unitPrice) || 0,
      subtotal: extractValue(item.subtotal) || 0,
      barcode: extractValue(item.productCode),
      catalogMatch: item.catalogLink?.linkedProductId ? {
        productId: item.catalogLink.linkedProductId,
        description: item.normalizedDescription,
        confidence: 1.0,
        method: 'AI_LINKED',
        source: 'DOCUMENT_AI'
      } : undefined
    })) || [],
    meta: {
      itemsProcessed: aiResult.items?.length || 0,
      itemsWithMatch: aiResult.items?.filter((i: any) => i.catalogLink?.linkedProductId).length || 0,
      itemsWithoutMatch: aiResult.items?.filter((i: any) => !i.catalogLink?.linkedProductId).length || 0,
      avgConfidence: aiResult.confidenceGlobal || 0
    }
  }
}

/**
 * Crear draft en base de datos
 */
export const createDraft = async (draftData: Partial<DraftPurchaseDoc>): Promise<DraftPurchaseDoc> => {
  const draft = await DraftPurchaseDocModel.create(draftData)
  return draft.toObject()
}

/**
 * Obtener draft por ID
 */
export const getDraftById = async (draftId: Types.ObjectId): Promise<DraftPurchaseDoc | null> => {
  const draft = await DraftPurchaseDocModel.findById(draftId).lean()
  return draft
}

/**
 * Actualizar draft
 */
export const updateDraft = async (
  draftId: Types.ObjectId,
  updates: Partial<DraftPurchaseDoc>
): Promise<DraftPurchaseDoc | null> => {
  const draft = await DraftPurchaseDocModel.findByIdAndUpdate(
    draftId,
    { $set: updates },
    { new: true }
  ).lean()
  return draft
}

/**
 * Listar drafts del usuario con paginación
 */
export const listUserDrafts = async (
  userId: Types.ObjectId,
  options: { skip?: number; limit?: number; status?: DraftStatus } = {}
): Promise<{ drafts: DraftPurchaseDoc[]; total: number }> => {
  const { skip = 0, limit = 50, status } = options
  const filter: any = { userId }
  if (status) {
    filter.status = status
  }

  const [drafts, total] = await Promise.all([
    DraftPurchaseDocModel.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    DraftPurchaseDocModel.countDocuments(filter)
  ])

  return { drafts, total }
}

/**
 * Analizar draft con Document AI
 * @param draft Draft a analizar
 * @returns Resultado del análisis
 */
export const analyzeDraftWithAI = async (draft: DraftPurchaseDoc): Promise<AnalyzeResult> => {
  const maxRetries = 3
  let lastError: Error | null = null

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`[Document AI] Intento ${attempt}/${maxRetries} para draft ${draft._id} DebugMode=${DOCUMENT_AI_DEBUG > 0 ? 'ON' : 'OFF'}`)

      // Construir ruta absoluta del archivo desde la raíz del proyecto
      // draft.file.path viene como "/uploads/purchase-docs/filename.jpg"
      const absolutePath = path.join(process.cwd(), 'public', draft.file.path)
      
      console.log(`[Document AI] Verificando archivo: ${absolutePath}`)
      
      if (!fs.existsSync(absolutePath)) {
        throw new Error(`Archivo no encontrado: ${absolutePath}`)
      }
      
      console.log(`[Document AI] Archivo encontrado, enviando a Document AI...`)

      // Preparar FormData para multipart/form-data
      const FormData = (await import('form-data')).default
      const formData = new FormData()
      
      // Agregar archivo
      formData.append('file', fs.createReadStream(absolutePath), {
        filename: draft.file.filename,
        contentType: draft.file.mimeType
      })
      
      // Agregar context como JSON string en Form
      const contextData = {
        draftId: draft._id?.toString(),
        providerId: draft.providerId?.toString(),
        userId: draft.userId.toString(),
        sourceType: draft.sourceType
      }
      formData.append('context', JSON.stringify(contextData))

      // Construir URL con query params
      const url = new URL(`${DOCUMENT_AI_URL}/analyze`)
      url.searchParams.set('debug', (DOCUMENT_AI_DEBUG > 0).toString())

      // Llamar a Document AI usando axios con FormData
      const response = await axios.post(url.toString(), formData, {
        headers: formData.getHeaders(), // Incluir headers con boundary
        timeout: DOCUMENT_AI_TIMEOUT,
        maxBodyLength: Infinity,
        maxContentLength: Infinity
      })

      // Document AI devuelve el resultado directamente (no tiene wrapper success/data)
      const aiResult = response.data
      
      // Transformar resultado de Document AI al formato esperado por DraftPurchaseDoc
      const result: AnalyzeResult = transformDocumentAIResult(aiResult)

      console.log(`[Document AI] Análisis exitoso para draft ${draft._id}`)
      return result
    } catch (error) {
      // Manejar errores de axios
      if (axios.isAxiosError(error)) {
        const status = error.response?.status || 'Unknown'
        const statusText = error.response?.statusText || ''
        const errorData = error.response?.data ? JSON.stringify(error.response.data) : error.message
        
        console.error(`[Document AI] Error ${status}:`, errorData)
        lastError = new Error(`Document AI error: ${status} ${statusText} - ${errorData}`)
      } else {
        lastError = error as Error
      }
      
      console.error(`[Document AI] Error en intento ${attempt}:`, lastError)

      // Si es un error de timeout o red, reintentar con backoff
      if (attempt < maxRetries) {
        const backoffMs = Math.pow(2, attempt) * 1000 // 2s, 4s, 8s
        console.log(`[Document AI] Reintentando en ${backoffMs}ms...`)
        await delay(backoffMs)
      }
    }
  }

  // Si llegamos aquí, todos los intentos fallaron
  const errorMessage = lastError
    ? `Document AI no responde: ${lastError.message}`
    : 'Error desconocido en Document AI'

  throw new Error(errorMessage)
}

/**
 * Ejecutar verificación de duplicados
 */
export const runDuplicateCheck = async (
  draftId: Types.ObjectId,
  analysis: AnalyzeResult
): Promise<PossibleDuplicate | null> => {
  try {
    // Si no hay header o datos mínimos, no podemos verificar duplicados
    if (!analysis.header || !analysis.header.total) {
      console.log(`[Duplicate Check] Sin datos suficientes en draft ${draftId}`)
      return null
    }

    // Validar que hay providerId (requerido por CheckDuplicateRequestDTO)
    if (!analysis.header.providerId) {
      console.log(`[Duplicate Check] Sin providerId en draft ${draftId}, omitiendo verificación`)
      return null
    }

    // Validar que hay fecha
    if (!analysis.header.documentDate) {
      console.log(`[Duplicate Check] Sin fecha en draft ${draftId}, omitiendo verificación`)
      return null
    }

    // Construir request para duplicate check
    const checkRequest: CheckDuplicateRequestDTO = {
      providerId: analysis.header.providerId,
      date: analysis.header.documentDate,
      total: analysis.header.total,
      docNumber: analysis.header.documentNumber,
      fingerprint: `${analysis.header.providerId}-${analysis.header.documentDate}-${analysis.header.total}`
    }

    // Llamar al servicio de duplicate check
    const duplicateResult = await checkForDuplicates(checkRequest)

    // Mapear respuesta al formato PossibleDuplicate
    const possibleDuplicate: PossibleDuplicate = {
      checkId: duplicateResult.checkId || draftId.toString(),
      status: duplicateResult.isPossibleDuplicate ? 'SUSPECTED_DUPLICATE' : 'CLEAN',
      duplicates: duplicateResult.candidates.map(candidate => ({
        purchaseId: candidate.existingBuyId,
        documentNumber: candidate.existingDocNumber,
        documentDate: candidate.existingDate ? new Date(candidate.existingDate).toISOString().split('T')[0] : undefined,
        providerId: analysis.header.providerId,
        total: candidate.existingTotal || 0,
        createdAt: candidate.existingDate ? new Date(candidate.existingDate) : new Date(),
        score: candidate.score * 100, // Convertir a porcentaje
        reasons: candidate.reasons.map(reason => ({
          strategy: reason,
          match: true,
          score: 100,
          boost: candidate.matchedOn.docNumber ? 3 : candidate.matchedOn.fingerprint ? 2 : 1
        }))
      })),
      canProceed: !duplicateResult.isPossibleDuplicate || duplicateResult.recommendation !== 'PROMPT_USER',
      requiresDecision: duplicateResult.recommendation === 'PROMPT_USER',
      message: duplicateResult.isPossibleDuplicate
        ? `Se encontraron ${duplicateResult.candidates.length} posibles duplicados. Requiere revisión manual.`
        : 'No se encontraron duplicados'
    }

    console.log(`[Duplicate Check] Resultado para draft ${draftId}: ${possibleDuplicate.status}`)
    return possibleDuplicate
  } catch (error) {
    console.error('[Duplicate Check] Error:', error)
    // En caso de error, permitir continuar pero loguear
    return null
  }
}

/**
 * Procesar draft completo: analizar + duplicate check
 */
export const processDraft = async (draftId: Types.ObjectId): Promise<DraftPurchaseDoc> => {
  const draft = await getDraftById(draftId)
  if (!draft) {
    throw new Error('Draft no encontrado')
  }

  try {
    // 1. Analizar con Document AI
    console.log(`[Process Draft] Iniciando análisis para draft ${draftId}`)
    const analysisResult = await analyzeDraftWithAI(draft)

    // 2. Ejecutar duplicate check
    console.log(`[Process Draft] Ejecutando duplicate check para draft ${draftId}`)
    const possibleDuplicate = await runDuplicateCheck(draftId, analysisResult)

    // 3. Actualizar draft con resultados
    const updatedDraft = await updateDraft(draftId, {
      status: DraftStatus.READY,
      analysisResult,
      possibleDuplicate: possibleDuplicate || undefined,
      error: undefined
    })

    if (!updatedDraft) {
      throw new Error('Error actualizando draft')
    }

    console.log(`[Process Draft] Draft ${draftId} procesado exitosamente`)
    return updatedDraft
  } catch (error) {
    // Guardar error en draft
    const errorObj = {
      message: error instanceof Error ? error.message : 'Error desconocido',
      stack: error instanceof Error ? error.stack : undefined,
      code: 'ANALYSIS_FAILED'
    }

    await updateDraft(draftId, {
      status: DraftStatus.FAILED,
      error: errorObj
    })

    console.error(`[Process Draft] Error procesando draft ${draftId}:`, error)
    throw error
  }
}

/**
 * Crear producto nuevo durante confirmación
 */
const createProduct = async (productData: NewProductData, userId: Types.ObjectId): Promise<Types.ObjectId> => {
  const product = await ProductModel.create({
    descripcion: productData.descripcion,
    categoria: productData.categoria,
    marca: productData.marca,
    proveedor: productData.proveedor,
    codigoBarra: productData.codigoBarra,
    precioCompra: productData.precioCompra || 0,
    precioUnitario: productData.precioUnitario || 0,
    stock: productData.stock || 0,
    bulto: productData.bulto,
    precioBulto: productData.precioBulto,
    estado: 'activo',
    user: userId
  })

  console.log(`[Create Product] Producto creado: ${product._id} - ${productData.descripcion}`)
  return product._id as Types.ObjectId
}

/**
 * Confirmar draft y crear compra definitiva
 */
export const confirmDraft = async (
  draftId: Types.ObjectId,
  userId: Types.ObjectId,
  headerEdits?: HeaderEdits,
  items?: ConfirmItem[],
  duplicateDecision?: { checkId?: string; decision?: 'CANCEL' | 'PROCEED'; reason?: string }
): Promise<{ buyId: Types.ObjectId; draftId: Types.ObjectId }> => {
  // 1. Validar que draft existe y está READY
  const draft = await getDraftById(draftId)
  if (!draft) {
    throw new Error('Draft no encontrado')
  }

  if (draft.status !== DraftStatus.READY) {
    throw new Error(`Draft no está listo para confirmar. Estado actual: ${draft.status}`)
  }

  if (!draft.analysisResult) {
    throw new Error('Draft no tiene resultado de análisis')
  }

  // 2. Validar decisión sobre duplicados si es necesario
  if (draft.possibleDuplicate?.requiresDecision && !duplicateDecision?.decision) {
    throw new Error('Se requiere decisión sobre duplicados detectados')
  }

  if (duplicateDecision?.decision === 'CANCEL') {
    throw new Error('Confirmación cancelada por duplicado')
  }

  // 3. Preparar header de la compra (usar ediciones o análisis)
  const header = {
    providerId: headerEdits?.providerId || draft.analysisResult.header.providerId,
    documentDate: headerEdits?.documentDate || draft.analysisResult.header.documentDate,
    documentNumber: headerEdits?.documentNumber || draft.analysisResult.header.documentNumber,
    total: headerEdits?.total || draft.analysisResult.header.total
  }

  // Validar header mínimo
  if (!header.providerId || !header.total) {
    throw new Error('Header incompleto: se requiere providerId y total')
  }

  // 4. Procesar items
  const processedItems: Array<{ productId: Types.ObjectId; quantity: number; unitPrice: number; subtotal: number }> = []

  // Si no se envían items, usar los del análisis
  const itemsToProcess: ConfirmItem[] = items && items.length > 0 ? items : draft.analysisResult.items.map(item => ({
    lineId: item.itemId,
    chosenProductId: item.catalogMatch?.productId,
    quantity: item.quantity,
    unitPrice: item.unitPrice,
    subtotal: item.subtotal
  }))

  for (const item of itemsToProcess) {
    let productId: Types.ObjectId

    if (item.chosenProductId) {
      // Usar producto existente
      productId = new Types.ObjectId(item.chosenProductId)
    } else if (item.newProduct) {
      // Crear producto nuevo
      productId = await createProduct(item.newProduct, userId)
    } else {
      // Política estricta: cada item debe tener producto asignado
      const analysisItem = draft.analysisResult.items.find(ai => ai.itemId === item.lineId)
      throw new Error(
        `Item sin producto asignado: ${item.lineId} (${analysisItem?.description || 'descripción desconocida'})`
      )
    }

    processedItems.push({
      productId,
      quantity: item.quantity || 0,
      unitPrice: item.unitPrice || 0,
      subtotal: item.subtotal || 0
    })
  }

  if (processedItems.length === 0) {
    throw new Error('No hay items para confirmar')
  }

  // 5. Crear compra (Buy)
  const buy = await BuyModel.create({
    estado: 'activo',
    total: header.total,
    user: userId,
    proveedor: header.providerId,
    fecha: header.documentDate ? new Date(header.documentDate) : new Date(),
    docNumber: header.documentNumber,
    fingerprint: `${header.providerId}-${header.documentDate}-${header.total}` // Simple fingerprint
  })

  console.log(`[Confirm Draft] Compra creada: ${buy._id}`)

  // 6. Crear items de compra (ItemBuy)
  await Promise.all(
    processedItems.map(item =>
      insertItemBuy({
        idProducto: item.productId,
        total: item.subtotal,
        cantidad: item.quantity,
        precio: item.unitPrice,
        idBuy: buy._id as Types.ObjectId,
        estado: true
      })
    )
  )

  console.log(`[Confirm Draft] ${processedItems.length} items creados`)

  // 7. Actualizar precios de compra en productos
  await Promise.all(
    processedItems.map(item =>
      ProductModel.findByIdAndUpdate(item.productId, {
        $set: { precioCompra: item.unitPrice }
      })
    )
  )

  // 8. Actualizar draft como confirmado
  await updateDraft(draftId, {
    status: DraftStatus.CONFIRMED,
    confirmedBuyId: buy._id as Types.ObjectId,
    confirmedAt: new Date()
  })

  console.log(`[Confirm Draft] Draft ${draftId} confirmado exitosamente`)

  return {
    buyId: buy._id as Types.ObjectId,
    draftId
  }
}
