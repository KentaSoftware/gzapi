# RFC backend — estadísticas por usuario v1

## Estado del documento

- **Tipo**: RFC técnico formal
- **Estado**: borrador listo para implementación
- **Fecha**: 2026-04-21
- **Basado en**: `./RFC-backend-estadisticas-ventas-por-usuario.md`
- **Plan de implementación relacionado**: `./PLAN-implementacion-estadisticas-por-usuario-v1.md`
- **Relacionado con**:
  - `src/routes/sale.ts`
  - `src/controllers/sale.ts`
  - `src/services/sale.ts`
  - `src/models/sale.ts`
  - `src/models/user.ts`
  - `src/middleware/session.ts`

---

## 1. Resumen ejecutivo

Se incorpora un contrato de analytics separado de los endpoints operativos de ventas.

La primera entrega formal cubre:

1. `POST /sale/stats/by-user` como endpoint obligatorio.
2. `POST /sale/stats/overview` como endpoint recomendado para el hub.
3. filtro opcional por `userId` dentro de `by-user` para soportar el flujo de cálculo de sueldo sin crear un endpoint extra.

Backend **no** calcula sueldo, **no** persiste porcentaje y **no** reutiliza `/sale/skip` ni `/sale/search` para reporting.

---

## 2. Objetivo

Exponer agregaciones estables sobre ventas para alimentar el centro modular de estadísticas del frontend, empezando por el módulo de usuarios.

El contrato debe permitir:

- obtener un resumen general del período consultado
- obtener ranking/listado agregado por usuario vendedor
- filtrar por período o rango personalizado
- excluir ventas canceladas por defecto
- consultar el total de un usuario en rango para el flujo de “Calcular sueldo”

---

## 3. No alcance de v1

Queda explícitamente fuera de esta fase:

- calcular sueldo en backend
- persistir el porcentaje ingresado por el admin
- crear una liquidación formal o recibo de sueldo
- reusar endpoints operativos como contrato analítico
- depender de `itemSale` para el cálculo principal de estadísticas por usuario
- introducir un sistema nuevo de roles/permisos finos si el repo actual no lo tiene

---

## 4. Contexto verificado en la API actual

1. `src/routes/sale.ts` hoy expone endpoints operativos (`/skip`, `/search`, CRUD, print) pero no endpoints formales de estadísticas.
2. `src/models/sale.ts` ya guarda los campos mínimos necesarios para analytics de usuarios:
   - `user`
   - `estado`
   - `total`
   - `porcentaje`
   - `createdAt`
3. `src/models/user.ts` hoy sólo garantiza `nickname`; no hay un campo de rol o permisos persistido en ese modelo.
4. `src/middleware/session.ts` ya provee `checkJwt`, por lo que no hace falta inventar autenticación nueva para esta RFC.
5. En este repo, varios listados con filtros usan `POST` y body JSON. Por consistencia del contrato existente, los endpoints de analytics también serán `POST`.

---

## 5. Decisiones de diseño

## 5.1 Superficie HTTP

### Obligatorio

```http
POST /sale/stats/by-user
```

### Recomendado

```http
POST /sale/stats/overview
```

### Decisión

No se crea un endpoint adicional `detail` en v1.

El mismo `POST /sale/stats/by-user` acepta `userId` opcional. Cuando `userId` viene presente:

- el resultado puede devolver uno o cero items
- el `summary` se calcula sobre el subconjunto filtrado
- frontend usa `items[0].totalAmount` para el cálculo de sueldo

---

## 5.2 Estrategia de autenticación y permisos

### Decisión v1

Los endpoints nuevos quedan protegidos con `checkJwt`.

### Motivo

El repo actual no muestra un sistema formal de permisos o roles granulares reutilizable. Por eso, en esta primera entrega:

- **sí** se exige JWT válido
- **no** se introduce aún `read_stats` o `read_sale_stats` como enforcement real en código

### Nota

La nomenclatura de permisos puede definirse más adelante sin romper el contrato HTTP.

---

## 5.3 Semántica de período y timezone

## Períodos aceptados

```txt
day | week | month | year | custom
```

## Timezone

- si el cliente envía `timezone`, se usa ese valor para resolver límites de período
- si no lo envía, el default será `America/Argentina/Buenos_Aires`

## Reglas

- `day`: desde `00:00:00.000` hasta `23:59:59.999` del día actual en timezone resuelta
- `week`: desde lunes `00:00:00.000` hasta domingo `23:59:59.999` en timezone resuelta
- `month`: primer día del mes `00:00:00.000` hasta último día `23:59:59.999`
- `year`: 1 de enero `00:00:00.000` hasta 31 de diciembre `23:59:59.999`
- `custom`: requiere `from` y `to`; el rango es inclusivo en ambos extremos

## Salida

`summary.from` y `summary.to` representan el intervalo **resuelto por backend**, no sólo un eco del request.

---

## 5.4 Semántica de cancelación

## Problema actual

`sale.estado` existe, pero el repo no documenta un enum canónico de valores.

## Decisión v1

- `includeCancelled` default: `false`
- cuando `includeCancelled = false`, backend excluye ventas cuyo `estado` normalizado sea exactamente `cancelado`
- la normalización mínima de `estado` será: trim + lowercase
- si `estado` está ausente o vacío, la venta se considera incluida

## Nota

Si durante implementación aparece evidencia de variantes persistidas reales, la normalización puede ampliar aliases sin romper el contrato.

---

## 5.5 Normalización de identidad del vendedor

Cada item analítico debe devolver una identidad estable para pintar UI y calcular sueldo.

## Decisión v1

- `userId`: string del `_id` de Mongo
- `nickname`: tomado de `users.nickname`
- `roleName`: `null` en v1 salvo que exista una fuente confiable durante implementación

## Caso borde

Si una venta referencia un `user` que ya no resuelve por lookup:

- la venta **no** debe perderse
- el item se agrupa igual por `sale.user`
- `nickname` se devuelve como `Usuario eliminado`
- `roleName` se devuelve como `null`

Esto evita sesgar métricas por pérdida de joins.

---

## 5.6 Ordenamiento y comportamiento sin datos

## Orden de `items`

1. `totalAmount` descendente
2. `salesCount` descendente
3. `nickname` ascendente

## Sin datos

Si no hay ventas para el filtro:

- status `200`
- `summary` con ceros
- `items: []`

No se devuelve `404` para consultas analíticas vacías.

---

## 6. Contrato HTTP

## 6.1 Request base

```json
{
  "period": "month",
  "from": "2026-04-01T00:00:00.000-03:00",
  "to": "2026-04-30T23:59:59.999-03:00",
  "timezone": "America/Argentina/Buenos_Aires",
  "includeCancelled": false,
  "userId": "661c4fa5b6b7a0d2db3f1001"
}
```

## Validaciones

- `period` es obligatorio
- `period = custom` exige `from` y `to`
- `from <= to`
- `timezone`, si viene, debe ser IANA válida
- `userId`, si viene, debe ser ObjectId válido
- `includeCancelled` es opcional y default `false`

## Respuesta de error

- `400` para payload inválido
- `401` para JWT inválido o ausente
- `500` para error inesperado de infraestructura o agregación

---

## 6.2 `POST /sale/stats/by-user`

## Response

```json
{
  "summary": {
    "totalSalesCount": 128,
    "totalAmount": 351240.75,
    "activeSellersCount": 6,
    "averageTicket": 2744.07,
    "from": "2026-04-01T03:00:00.000Z",
    "to": "2026-05-01T02:59:59.999Z",
    "generatedAt": "2026-04-21T15:30:00.000Z"
  },
  "items": [
    {
      "userId": "661c4fa5b6b7a0d2db3f1001",
      "nickname": "Pedro",
      "roleName": null,
      "salesCount": 32,
      "totalAmount": 104300.25,
      "averageTicket": 3259.38
    }
  ]
}
```

## Reglas

- `totalSalesCount`: cantidad de ventas incluidas luego de filtros
- `totalAmount`: suma de `sale.total`
- `activeSellersCount`: cantidad de usuarios agrupados con al menos una venta incluida
- `averageTicket`: `totalAmount / totalSalesCount`, con redondeo a 2 decimales
- si `userId` viene presente, `activeSellersCount` vale `0` o `1`

---

## 6.3 `POST /sale/stats/overview`

## Response

```json
{
  "summary": {
    "totalSalesCount": 128,
    "totalAmount": 351240.75,
    "activeSellersCount": 6,
    "averageTicket": 2744.07,
    "from": "2026-04-01T03:00:00.000Z",
    "to": "2026-05-01T02:59:59.999Z",
    "generatedAt": "2026-04-21T15:30:00.000Z"
  }
}
```

## Reglas

- usa el mismo filtro base excepto `userId`
- si `userId` llega en el body, backend responde `400`

---

## 7. Diseño de agregación en Mongo

## 7.1 Fuente de verdad

La fuente principal es la colección `sales`.

No hace falta usar `itemSale` para esta RFC porque:

- el ranking pedido es por vendedor, no por producto
- el cálculo de sueldo usa `sale.total`
- `sale.user` + `sale.total` + `sale.createdAt` alcanzan para el caso de uso v1

---

## 7.2 Pipeline conceptual para `by-user`

1. Resolver `from` / `to` según `period` + `timezone`.
2. Construir `$match` con:
   - `createdAt >= from`
   - `createdAt <= to`
   - filtro de cancelación según `includeCancelled`
   - `user = userId` si viene presente
3. Hacer `$lookup` contra `users` por `sale.user`.
4. Hacer `$unwind` con `preserveNullAndEmptyArrays: true`.
5. Normalizar identidad:
   - `userId`
   - `nickname`
   - `roleName`
6. Agrupar por `userId` para obtener:
   - `salesCount`
   - `totalAmount`
   - `averageTicket`
7. Ordenar según reglas definidas.
8. Calcular `summary` sobre el mismo conjunto filtrado.

## Implementación sugerida

Usar `$facet` para obtener en una sola consulta:

- `items`
- `summary`

Esto evita divergencias entre dos queries distintas.

---

## 7.3 Pipeline conceptual para `overview`

1. Resolver `from` / `to`.
2. Aplicar `$match` con mismas reglas de cancelación.
3. Agrupar todas las ventas incluidas para obtener:
   - `totalSalesCount`
   - `totalAmount`
4. Calcular `activeSellersCount` como conteo distinto de `user` en el mismo rango filtrado.
5. Calcular `averageTicket`.

---

## 8. Diseño de archivos en este repo

## Decisión recomendada

- mantener rutas nuevas dentro de `src/routes/sale.ts`
- mantener handlers HTTP en `src/controllers/sale.ts`
- mover la lógica de agregación a un servicio dedicado `src/services/saleStats.ts`

## Motivo

`src/services/sale.ts` hoy está enfocado en CRUD/listados operativos. Mezclar agregaciones analíticas complejas en el mismo archivo haría el módulo más difícil de mantener.

Esta separación conserva el patrón actual del repo:

```txt
routes -> controllers -> services -> models
```

sin mezclar reporting con operación diaria.

---

## 9. Criterios de aceptación

La RFC se considera implementada correctamente cuando:

1. existe `POST /sale/stats/by-user` protegido con `checkJwt`
2. existe `POST /sale/stats/overview` protegido con `checkJwt`
3. ambos endpoints validan body y responden `400` ante payload inválido
4. `includeCancelled` default es `false`
5. `by-user` acepta `userId` opcional y permite el flujo de sueldo
6. `roleName` no rompe el contrato aunque el repo actual no tenga roles persistidos
7. una venta con usuario no resoluble por lookup no desaparece del agregado
8. consultas vacías devuelven `200` con summary en cero e `items: []`
9. no se reutilizan `/sale/skip` ni `/sale/search`

---

## 10. Riesgos y mitigaciones

### Riesgo: `estado` no normalizado en datos existentes

**Mitigación**: centralizar normalización de cancelación en un helper y documentar aliases verificados durante implementación.

### Riesgo: diferencias por timezone

**Mitigación**: resolver siempre límites en base a IANA timezone y devolver `from` / `to` finales en response.

### Riesgo: usuarios eliminados rompen agregados

**Mitigación**: usar lookup con fallback, no descartar ventas huérfanas.

### Riesgo: endpoints operativos usados como analytics por costumbre

**Mitigación**: dejar contratos nuevos explícitos en rutas y documentación.

---

## 11. Próximo paso inmediato

Con esta RFC cerrada, el siguiente paso correcto es implementar en este orden:

1. validación de request y resolución de rango/periodo
2. servicio de agregación `saleStats`
3. endpoints `by-user` y `overview`
4. verificación manual con casos:
   - rango sin datos
   - rango con múltiples usuarios
   - filtro por `userId`
   - ventas canceladas incluidas y excluidas
