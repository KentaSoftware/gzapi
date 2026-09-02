# Front testing — estadísticas por usuario v1

## Qué se implementó

Se agregaron 2 endpoints nuevos en backend:

1. `POST /sale/stats/by-user`
2. `POST /sale/stats/overview`

Ambos:
- usan `checkJwt`
- reciben JSON por `body`
- responden analytics separados de los endpoints operativos (`/sale/skip`, `/sale/search`)

---

## Para qué sirve cada endpoint

## 1. `POST /sale/stats/by-user`

Devuelve:
- `summary` del rango consultado
- `items` agregados por usuario vendedor

También soporta `userId` opcional para el flujo de **Calcular sueldo**.

## 2. `POST /sale/stats/overview`

Devuelve:
- sólo `summary`

Sirve para el hub principal de estadísticas.

`overview` **no acepta** `userId`.

---

## Reglas de negocio importantes

- Backend **no calcula sueldo**.
- Backend **no persiste porcentaje**.
- Front sigue calculando sueldo así:

```txt
totalAmount * (percentage / 100)
```

- `includeCancelled` default: `false`
- si no se manda `timezone`, backend usa `America/Argentina/Buenos_Aires`
- períodos soportados:

```txt
day | week | month | year | custom
```

- `custom` requiere `from` y `to`
- si no hay datos, backend responde `200` con summary en cero
- `roleName` hoy viene `null` en v1

---

## Auth

Ambos endpoints requieren:

```http
Authorization: Bearer <token>
```

Sin JWT válido no deberían usarse desde front.

## Endpoints exactos para pruebas

### Importante

- Las rutas están montadas desde la raíz del servidor.
- **No** llevan prefijo `/api`.
- Si el backend corre local, el puerto por defecto es `3002`.

## Base URL de ejemplo

### Local

```txt
http://localhost:3002
```

### Desde mobile

Usar el mismo host que se esté cargando en `DB_HOST`.

---

## Endpoints a usar en pruebas

### 1. Login para obtener token

```http
POST /auth/login
```

Ejemplo local:

```txt
http://localhost:3002/auth/login
```

### 2. Hub general de estadísticas

```http
POST /sale/stats/overview
```

Ejemplo local:

```txt
http://localhost:3002/sale/stats/overview
```

### 3. Listado de usuarios

```http
POST /sale/stats/by-user
```

Ejemplo local:

```txt
http://localhost:3002/sale/stats/by-user
```

### 4. Calcular sueldo por usuario

Se usa el mismo endpoint anterior con `userId` en el body:

```http
POST /sale/stats/by-user
```

Ejemplo local:

```txt
http://localhost:3002/sale/stats/by-user
```

---

## Ejemplo rápido con curl

## Login

```bash
curl -X POST http://localhost:3002/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "nickname": "TU_USUARIO",
    "password": "TU_PASSWORD"
  }'
```

## Overview

```bash
curl -X POST http://localhost:3002/sale/stats/overview \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer TU_TOKEN" \
  -d '{
    "period": "month",
    "timezone": "America/Argentina/Buenos_Aires"
  }'
```

## By user

```bash
curl -X POST http://localhost:3002/sale/stats/by-user \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer TU_TOKEN" \
  -d '{
    "period": "month",
    "timezone": "America/Argentina/Buenos_Aires"
  }'
```

## Salary flow por usuario

```bash
curl -X POST http://localhost:3002/sale/stats/by-user \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer TU_TOKEN" \
  -d '{
    "period": "custom",
    "from": "2026-04-01T00:00:00.000-03:00",
    "to": "2026-04-30T23:59:59.999-03:00",
    "timezone": "America/Argentina/Buenos_Aires",
    "userId": "<objectId>"
  }'
```

---

## Payloads para probar desde front

## A. Hub general (`overview`)

```json
{
  "period": "month",
  "timezone": "America/Argentina/Buenos_Aires"
}
```

## B. Listado de usuarios (`by-user`)

```json
{
  "period": "month",
  "timezone": "America/Argentina/Buenos_Aires"
}
```

## C. Calcular sueldo para un usuario (`by-user` con `userId`)

```json
{
  "period": "custom",
  "from": "2026-04-01T00:00:00.000-03:00",
  "to": "2026-04-30T23:59:59.999-03:00",
  "timezone": "America/Argentina/Buenos_Aires",
  "userId": "<objectId>"
}
```

---

## Shape esperado de respuesta

## `POST /sale/stats/by-user`

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

## `POST /sale/stats/overview`

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

---

## Cosas a tener en cuenta desde front

## `summary.from` y `summary.to`

No son un eco literal del request.

Backend resuelve el rango final y lo devuelve como ISO. Para `month`, `week`, etc., eso puede venir ajustado a UTC.

## `by-user` con `userId`

Cuando mandan `userId`:
- `items.length` debería ser `0` o `1`
- `summary.activeSellersCount` debería ser `0` o `1`

## Usuario eliminado

Si existe una venta cuyo usuario ya no resuelve por lookup, backend no la pierde. En ese caso puede venir:

```json
{
  "nickname": "Usuario eliminado",
  "roleName": null
}
```

---

## Errores esperables

## `400`

Ejemplos:
- `period` inválido
- `timezone` inválida
- `period: custom` sin `from`/`to`
- `from > to`
- `userId` inválido
- mandar `userId` a `POST /sale/stats/overview`

Ejemplo:

```json
{
  "error": "INVALID_TIMEZONE"
}
```

## `401` / `400` de sesión

Si el JWT falta o es inválido, aplica el comportamiento actual de `checkJwt`.

---

## Checklist de prueba para frontend

### 1. Hub
- consumir `POST /sale/stats/overview`
- renderizar `summary.totalSalesCount`
- renderizar `summary.totalAmount`
- renderizar `summary.activeSellersCount`
- renderizar `summary.averageTicket`

### 2. Listado por usuario
- consumir `POST /sale/stats/by-user`
- renderizar `items[].nickname`
- renderizar `items[].salesCount`
- renderizar `items[].totalAmount`
- renderizar `items[].averageTicket`

### 3. Calcular sueldo
- consumir `POST /sale/stats/by-user` con `userId`
- tomar `items[0]?.totalAmount ?? 0`
- calcular sueldo en frontend con porcentaje manual

### 4. Estados vacíos
- si `items` viene vacío, no es error
- si `summary` viene en cero, mostrar empty state

### 5. Error handling
- manejar `400` mostrando error funcional
- manejar sesión inválida según flujo actual de auth

---

## Documento técnico relacionado

- RFC: `./RFC-backend-estadisticas-por-usuario-v1.md`
- Plan: `./PLAN-implementacion-estadisticas-por-usuario-v1.md`
