import { Types } from 'mongoose';

/**
 * PS-T30 — Marca de compra duplicada.
 *
 * Cuando el usuario decide continuar con un comprobante que ya estaba
 * registrado, la compra nueva queda vinculada a la **principal**: la primera
 * que se registró entre los candidatos detectados.
 *
 * El orden de registro se deduce del timestamp embebido en el ObjectId (segundos)
 * y, para ids del mismo segundo, del propio hex, que es monótono.
 */
export function pickPrimaryDuplicate(
  purchaseIds: Array<string | Types.ObjectId | null | undefined>
): string | null {
  const valid = purchaseIds
    .filter((id): id is string | Types.ObjectId => Boolean(id))
    .map((id) => String(id))
    .filter((id) => Types.ObjectId.isValid(id))
    .map((id) => ({ id, time: new Types.ObjectId(id).getTimestamp().getTime() }))
    .sort((a, b) => (a.time - b.time) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  return valid.length > 0 ? valid[0].id : null;
}

/**
 * Traduce la decisión del wizard al vocabulario del historial de checks.
 * Devuelve null cuando no hubo decisión que registrar.
 */
export function toCheckDecision(
  decision?: 'CANCEL' | 'PROCEED' | 'NOT_DUPLICATE'
): 'CANCEL' | 'CONTINUE' | 'NOT_DUPLICATE' | null {
  switch (decision) {
    case 'CANCEL':
      return 'CANCEL';
    case 'PROCEED':
      return 'CONTINUE';
    case 'NOT_DUPLICATE':
      return 'NOT_DUPLICATE';
    default:
      return null;
  }
}
