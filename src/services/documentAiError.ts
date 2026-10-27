/**
 * PS-T29 — Mensajes de error legibles cuando el microservicio documental falla.
 *
 * Sin respuesta del servicio, axios no trae `response` y el mensaje quedaba como
 * "Document AI error: Unknown  - Error": no dice si el servicio está caído, si
 * respondió con error o si el análisis devolvió algo inválido.
 */

interface AxiosLikeError {
  isAxiosError?: boolean;
  message?: string;
  code?: string;
  response?: {
    status?: number;
    statusText?: string;
    data?: unknown;
  };
}

/**
 * Traduce el error del cliente HTTP de Document AI a un mensaje accionable.
 * - sin `response` ⇒ el servicio no está levantado (se nombra la URL configurada)
 * - con `response` ⇒ estado HTTP y cuerpo del error
 * - otro error ⇒ su propio mensaje
 */
export function describeDocumentAiFailure(error: unknown, url: string): string {
  const candidate = error as AxiosLikeError | undefined;

  if (!candidate || (!candidate.message && !candidate.response)) {
    return 'Error desconocido en Document AI';
  }

  if (candidate.isAxiosError && !candidate.response) {
    const reason = candidate.code ? ` (${candidate.code})` : '';
    return `el servicio de análisis no responde en ${url}${reason}`;
  }

  if (candidate.response) {
    const status = candidate.response.status ?? 'Unknown';
    const statusText = candidate.response.statusText ?? '';
    const data = candidate.response.data
      ? JSON.stringify(candidate.response.data)
      : candidate.message ?? '';

    return `el servicio de análisis respondió ${status} ${statusText} - ${data}`.trim();
  }

  return candidate.message ?? 'Error desconocido en Document AI';
}
