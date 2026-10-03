/**
 * Utilidades de normalización para matching de productos
 * Fase 3 (v0.4.0) - Catalog Linking
 */

/**
 * Normaliza texto para matching de productos
 *
 * Operaciones:
 * 1. Uppercase
 * 2. Remover tildes/diacríticos
 * 3. Trim + colapsar espacios múltiples
 * 4. Normalizar patrones comunes (cantidades, unidades)
 *
 * @param input - Texto a normalizar
 * @returns Texto normalizado
 */
export const normalizeText = (input: string | null | undefined): string => {
  if (input == null || input === '') return ''

  let normalized = input
    // 1. Trim inicial
    .trim()
    // 2. Uppercase
    .toUpperCase()
    // 3. Remover tildes/diacríticos
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    // 4. Colapsar espacios múltiples
    .replace(/\s+/g, ' ')
    // 5. Trim final
    .trim()

  // 6. Normalizar patrones de cantidades/unidades
  normalized = normalizeQuantityPatterns(normalized)

  return normalized
}

/**
 * Normaliza patrones comunes de cantidades y unidades
 *
 * Ejemplos:
 * - "1kg" -> "1 KG"
 * - "x12" -> "X 12"
 * - "500gr" -> "500 GR"
 * - "1.5lt" -> "1.5 LT"
 * - "250ml" -> "250 ML"
 */
const normalizeQuantityPatterns = (text: string): string => {
  // Patrones: número + unidad (sin espacio) -> número + espacio + unidad
  const unitPatterns = [
    // Peso
    { pattern: /(\d+(?:[.,]\d+)?)\s*(KG|KILO|KILOS)/gi, replacement: '$1 KG' },
    { pattern: /(\d+(?:[.,]\d+)?)\s*(GR|GRS|GRAMOS?)/gi, replacement: '$1 GR' },
    { pattern: /(\d+(?:[.,]\d+)?)\s*(MG|MILIGRAMOS?)/gi, replacement: '$1 MG' },
    // Volumen
    { pattern: /(\d+(?:[.,]\d+)?)\s*(LT|LTS|LITROS?)/gi, replacement: '$1 LT' },
    { pattern: /(\d+(?:[.,]\d+)?)\s*(ML|MLS|MILILITROS?)/gi, replacement: '$1 ML' },
    { pattern: /(\d+(?:[.,]\d+)?)\s*(CC)/gi, replacement: '$1 CC' },
    // Unidades
    { pattern: /(\d+(?:[.,]\d+)?)\s*(UN|UNI|UNID|UNIDADES?)/gi, replacement: '$1 UN' },
    // Multiplicador X (ej: x12, X 12)
    { pattern: /\bX\s*(\d+)/gi, replacement: 'X $1' },
    { pattern: /(\d+)\s*X\b/gi, replacement: '$1 X' }
  ]

  let result = text
  for (const { pattern, replacement } of unitPatterns) {
    result = result.replace(pattern, replacement)
  }

  // Colapsar espacios que pudieron generarse
  return result.replace(/\s+/g, ' ').trim()
}

/**
 * Normaliza código de barras
 * - Remueve espacios y guiones
 * - Solo deja dígitos
 */
export const normalizeBarcode = (barcode: string | null | undefined): string => {
  if (barcode == null || barcode === '') return ''
  return barcode.replace(/[\s\-]/g, '').replace(/\D/g, '')
}

/**
 * Genera versión hash basada en timestamp
 * Formato: YYYYMMDD-HHMMSS-RANDOM
 */
export const generateVersion = (): string => {
  const now = new Date()
  const date = now.toISOString().slice(0, 10).replace(/-/g, '')
  const time = now.toISOString().slice(11, 19).replace(/:/g, '')
  const random = Math.random().toString(36).substring(2, 6).toUpperCase()
  return `${date}-${time}-${random}`
}

/**
 * Valida si un string es un ObjectId válido de MongoDB
 */
export const isValidObjectId = (id: string | null | undefined): boolean => {
  if (id == null || id === '') return false
  return /^[a-fA-F0-9]{24}$/.test(id)
}
