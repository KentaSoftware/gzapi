# Plan de implementación — estadísticas por usuario v1

## Objetivo

Implementar los endpoints definidos en `RFC-backend-estadisticas-por-usuario-v1.md` sin mezclar analytics con los endpoints operativos de ventas.

### Entregables de esta implementación

1. `POST /sale/stats/by-user`
2. `POST /sale/stats/overview`
3. validación de request
4. agregación Mongo separada en un servicio dedicado
5. verificación manual + `npm run lint`

---

## Restricciones reales del repo

1. `src/services/sale.ts` hoy es CRUD/listado operativo; no conviene mezclarle reporting complejo.
2. `src/middleware/session.ts` ya tiene `checkJwt`; reutilizarlo.
3. `src/utils/error.handle.ts` **siempre** responde `500`, así que **no sirve** para errores de validación `400`.
4. No hay `test` script ni CI; la verificación de esta entrega debe ser `npm run lint` + smoke manual.
5. El repo usa `POST` con JSON body en varios flujos filtrados; los endpoints stats deben seguir esa convención.

---

## Decisión recomendada antes de codear

## Timezone

El RFC pide timezone IANA real. El repo hoy tiene `date-fns`, pero **no** tiene `date-fns-tz`.

### Opción recomendada

Agregar `date-fns-tz`.

**Por qué**:
- reduce complejidad accidental
- hace más correcto el cálculo de `from` / `to`
- evita hacks con offsets fijos como en `src/services/dataset.ts`

### Alternativa

No agregar dependencia y aceptar sólo `America/Argentina/Buenos_Aires`.

**Tradeoff**:
- menos cambios de dependencias
- pero rompe la promesa del RFC de aceptar timezone IANA del cliente

### Recomendación final

Para que el RFC no nazca roto: **agregar `date-fns-tz`**.

---

## Fase 1 — contratos y utilidades base

## Archivos

- **nuevo** `src/interfaces/saleStats.interface.ts`
- **nuevo** `src/utils/saleStats.ts` o `src/utils/statsDateRange.ts`

## Tareas

1. Definir tipos para:
   - `StatsPeriod`
   - `SaleStatsRequest`
   - `SaleStatsSummary`
   - `SaleStatsByUserItem`
   - `SaleStatsByUserResponse`
   - `SaleStatsOverviewResponse`

2. Crear helpers puros para:
   - validar `period`
   - validar `timezone`
   - validar `userId`
   - resolver `from` / `to` a partir de `period`
   - normalizar `estado` para cancelación (`trim + lowercase`)
   - calcular `averageTicket` con redondeo a 2 decimales

3. Centralizar un validador de request que devuelva una estructura tipo:

```ts
{ ok: true, value: ResolvedStatsRequest }
{ ok: false, status: 400, error: 'INVALID_TIMEZONE' }
```

## Importante

NO meter esta validación en `handleHttp`, porque ese helper hoy deja todo en `500`.

---

## Fase 2 — servicio de analytics

## Archivos

- **nuevo** `src/services/saleStats.ts`

## Responsabilidad del archivo

Tener toda la lógica de reporting, separada de `src/services/sale.ts`.

## API interna sugerida

```ts
getSaleStatsByUser(input: ResolvedStatsRequest): Promise<SaleStatsByUserResponse>
getSaleStatsOverview(input: ResolvedStatsRequest): Promise<SaleStatsOverviewResponse>
```

## Tareas

1. Crear función para construir `$match` base con:
   - `createdAt >= from`
   - `createdAt <= to`
   - exclusión de canceladas cuando `includeCancelled = false`
   - filtro `user` si viene `userId`

2. Implementar pipeline `by-user`:
   - `$match`
   - `$lookup` a `users`
   - `$unwind` con `preserveNullAndEmptyArrays: true`
   - normalización de identidad fallback (`Usuario eliminado`)
   - `$group` por usuario
   - cálculo de `salesCount`, `totalAmount`, `averageTicket`
   - ordenamiento final

3. Implementar `summary` sobre el mismo conjunto filtrado.

4. Recomendación fuerte: usar `$facet` para sacar `items` y `summary` de una misma query.

5. Implementar pipeline `overview` sin `items`, pero con:
   - `totalSalesCount`
   - `totalAmount`
   - `activeSellersCount`
   - `averageTicket`

6. Garantizar respuestas vacías con:
   - `summary` en cero
   - `items: []` para `by-user`

## Regla de oro

No tocar `itemSale` para esta entrega. La fuente de verdad es `sales`.

---

## Fase 3 — handlers HTTP

## Archivos

- **actualizar** `src/controllers/sale.ts`

## Tareas

1. Agregar handlers nuevos:
   - `statsByUser`
   - `statsOverview`

2. Flujo recomendado de cada handler:

```txt
leer body -> validar -> responder 400 si falla -> llamar servicio -> responder 200 -> capturar error inesperado con 500
```

3. Para `overview`, rechazar `userId` en body con `400`.

4. Mantener el resto del controlador intacto; no mezclar esta implementación con print/CRUD.

## Nota

Los errores de validación deben responderse explícitamente con `res.status(400).send(...)`.

---

## Fase 4 — rutas

## Archivos

- **actualizar** `src/routes/sale.ts`

## Tareas

1. Importar handlers nuevos desde `controllers/sale`.
2. Registrar:

```ts
router.post('/stats/by-user', checkJwt, statsByUser)
router.post('/stats/overview', checkJwt, statsOverview)
```

3. Mantener protegidos ambos endpoints con `checkJwt`.

## Nota

No hace falta tocar `src/routes/index.ts` porque `sale.ts` ya está montado.

---

## Fase 5 — verificación manual

## Verificación mínima obligatoria

1. `npm run lint`

2. Smoke manual con JWT válido:

### Caso A — by-user general

```http
POST /sale/stats/by-user
```

Body:

```json
{
  "period": "month",
  "timezone": "America/Argentina/Buenos_Aires"
}
```

Validar:
- status `200`
- `summary` presente
- `items` array

### Caso B — by-user con `userId`

```json
{
  "period": "custom",
  "from": "2026-04-01T00:00:00.000-03:00",
  "to": "2026-04-30T23:59:59.999-03:00",
  "timezone": "America/Argentina/Buenos_Aires",
  "userId": "<objectId>"
}
```

Validar:
- status `200`
- `items.length` sea `0` o `1`
- `activeSellersCount` sea `0` o `1`

### Caso C — overview

```json
{
  "period": "month",
  "timezone": "America/Argentina/Buenos_Aires"
}
```

Validar:
- status `200`
- sólo `summary`

### Caso D — payload inválido

Ejemplos:
- `period: "banana"`
- `timezone: "Mars/OlympusMons"`
- `userId` inválido
- `period: "custom"` sin `from`/`to`

Validar:
- status `400`

### Caso E — `overview` con `userId`

Validar:
- status `400`

---

## Desglose final para el orquestador

## Cambios de archivos esperados

- `package.json` y `package-lock.json` *(si se agrega `date-fns-tz`)*
- `src/interfaces/saleStats.interface.ts` *(nuevo)*
- `src/utils/statsDateRange.ts` o `src/utils/saleStats.ts` *(nuevo)*
- `src/services/saleStats.ts` *(nuevo)*
- `src/controllers/sale.ts` *(actualizar)*
- `src/routes/sale.ts` *(actualizar)*

## Orden recomendado de ejecución

1. helpers + interfaces
2. servicio `saleStats`
3. handlers en controller
4. rutas
5. lint
6. smoke manual

---

## Qué NO debería hacer el orquestador

- no tocar `src/services/dataset.ts`
- no mezclar esta feature con estadísticas de productos
- no agregar cálculo de sueldo
- no persistir porcentaje
- no reutilizar `/sale/skip` o `/sale/search`
- no mover lógica de analytics dentro de `src/services/sale.ts`

---

## Criterio de cierre

La tarea queda lista para implementación cuando el orquestador entregue:

1. endpoints funcionando según RFC
2. validación `400` correcta
3. auth con `checkJwt`
4. servicio de analytics separado
5. `npm run lint` pasando
6. evidencia de smoke manual con al menos los 5 casos listados arriba
