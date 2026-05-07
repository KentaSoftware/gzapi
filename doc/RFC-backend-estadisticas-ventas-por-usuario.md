# Resumen para RFC backend — centro de estadísticas modular y cálculo de sueldo por usuario

## Estado del documento

- **Tipo**: resumen de traspaso
- **Estado**: borrador adaptado
- **Fecha**: 2026-04-20
- **Origen**: definiciones ya cerradas en frontend mobile
- **Relacionado con**:
  - `../golozurmobile/docs/RFC-centro-estadisticas-modular-y-calculo-sueldo-usuario.md`
  - `../golozurmobile/docs/RFC-estadisticas-ventas-por-usuario.md` _(histórico)_
  - `src/routes/sale.ts`
  - `src/controllers/sale.ts`
  - `src/services/sale.ts`
  - `src/models/sale.ts`
  - `src/models/user.ts`

> Este documento NO es el RFC definitivo de backend. Es contexto adaptado al nuevo RFC frontend modular. Su objetivo es dejar claro qué cambió del lado mobile, qué espera hoy el frontend del backend y qué decisiones faltan cerrar cuando redactemos el RFC técnico formal dentro de la API.

> RFC técnico formal relacionado: `./RFC-backend-estadisticas-por-usuario-v1.md`

---

## 1. Qué ya quedó definido en frontend

En mobile ya NO se sigue la idea de una única pantalla monolítica de estadísticas.

### Definiciones cerradas

1. Existe una pantalla principal **Estadísticas** que funciona como hub.
2. Desde ese hub se accede a módulos separados:
   - usuarios
   - ventas
   - productos
   - otros futuros
3. El **primer módulo completo obligatorio** es **estadísticas de usuarios**.
4. El módulo de usuarios muestra un listado analítico por usuario, visualmente alineado al lenguaje actual de la app.
5. Al tocar un usuario, se abre un flujo dentro de un **bottom sheet**.
6. Ese flujo expone al menos estas acciones:
   - `Más detalles`
   - `Calcular sueldo`
7. El cálculo de sueldo usa:
   - usuario seleccionado
   - rango de fechas
   - porcentaje manual
8. El porcentaje tiene valor por defecto **5%**.
9. El porcentaje **no se persiste**.
10. El sueldo se calcula en frontend así:

```txt
totalAmount * (percentage / 100)
```

11. Backend NO debe calcular sueldo en esta fase.
12. Mientras backend no esté listo, frontend puede seguir con **mock-first** en partes del flujo.
13. Los datos analíticos NO deben reconstruirse usando paginación/listados operativos.
14. Los nombres técnicos en código siguen en inglés, pero los labels visibles al usuario van en español.

---

## 2. Qué cambió respecto del contexto anterior

El resumen viejo estaba alineado con una pantalla única de “estadísticas de ventas por usuario”. Ese modelo ya no representa bien la dirección actual.

### Antes

- una pantalla única
- foco visual en ranking y resumen global
- porcentaje expuesto como herramienta global de pantalla

### Ahora

- un **hub de estadísticas**
- un **módulo de usuarios** como primera entrega fuerte
- un flujo contextual por usuario
- porcentaje aplicado específicamente al caso de **calcular sueldo**

### Consecuencia para backend

Backend ya no tiene que pensarse sólo como “endpoint para una pantalla única”.
Tiene que pensarse como base para una arquitectura modular de estadísticas.

---

## 3. Qué necesita frontend de backend ahora

Para dejar de depender de datos ficticios, frontend necesita agregaciones estables y separadas de los endpoints operativos.

### Prioridad real de backend en esta etapa

#### Obligatorio para la primera entrega fuerte

1. Un contrato agregado para **estadísticas por usuario**.
2. Filtros por período y rango personalizado.
3. Exclusión de ventas canceladas por defecto.
4. Identidad normalizada del usuario vendedor.
5. Resumen general del período consultado.

#### Recomendado pero puede ser por etapas

1. Un resumen agregado para el hub (`StatsHome`).
2. Un mecanismo limpio para obtener el total por usuario en rango, útil para alimentar el flujo de cálculo de sueldo.

---

## 4. Qué espera recibir frontend

## 4.1 Para el hub de estadísticas (`StatsHome`)

Frontend puede convivir un tiempo con datos mock-first, pero si backend decide cubrirlo desde el principio, el resumen debería exponer al menos:

- `summary.totalSalesCount`
- `summary.totalAmount`
- `summary.activeSellersCount`
- `summary.averageTicket`
- `summary.from`
- `summary.to`
- `summary.generatedAt`

## 4.2 Para estadísticas de usuarios (`UserStats`)

Frontend espera un listado agregado por usuario, con identidad consistente y datos listos para pintar.

### Campos mínimos útiles

- `items[].userId`
- `items[].nickname`
- `items[].roleName` _(opcional si se puede resolver limpio)_
- `items[].salesCount`
- `items[].totalAmount`
- `items[].averageTicket`

### Campos de resumen útiles

- `summary.totalSalesCount`
- `summary.totalAmount`
- `summary.activeSellersCount`
- `summary.averageTicket`
- `summary.from`
- `summary.to`
- `summary.generatedAt`

## 4.3 Para el flujo de calcular sueldo

Backend NO tiene que devolver el sueldo calculado.

Frontend calcula después:

- sueldo estimado por usuario
- usando el total vendido del rango
- y el porcentaje ingresado manualmente

### Lo que sí necesita frontend

Una forma estable de obtener el **total agregado del usuario en el rango elegido**.

Eso se puede resolver de dos maneras válidas:

### Opción A — reutilizar el mismo endpoint agregado por usuario

Ejemplo:

```json
{
  "period": "custom",
  "from": "2026-04-01T00:00:00.000-03:00",
  "to": "2026-04-30T23:59:59.999-03:00",
  "timezone": "America/Argentina/Buenos_Aires",
  "includeCancelled": false,
  "userId": "u1"
}
```

### Opción B — endpoint específico para detalle agregado por usuario

Ejemplo conceptual:

```http
POST /sale/stats/by-user/detail
```

Con filtro por `userId` + rango.

Para frontend ambas sirven. El RFC formal de backend debería elegir UNA y dejarla cerrada.

---

## 5. Hallazgos verificados en la API actual

Esto ya está verificado en este repo.

### 5.1 Rutas de ventas actuales

En `src/routes/sale.ts` hoy existen, entre otras:

- `POST /sale/skip`
- `POST /sale/search`
- `POST /sale`
- `PATCH /sale/:id`
- `GET /sale/:id`

### 5.2 No existe hoy un endpoint formal de estadísticas

No hay una ruta específica de reporting como:

- `POST /sale/stats/by-user`
- `POST /sale/stats/overview`

### 5.3 Modelo actual de venta

En `src/models/sale.ts`, la venta ya guarda datos útiles para esta necesidad:

- `user`
- `estado`
- `total`
- `porcentaje`
- `createdAt` / `updatedAt`

### 5.4 Modelo actual de usuario

En `src/models/user.ts`, el usuario tiene al menos:

- `nickname`

Y potencialmente otros campos útiles si se quiere enriquecer la identidad que consume analytics.

### 5.5 Middleware de autenticación

En `src/middleware/session.ts` ya existe `checkJwt`.

Eso implica que el futuro módulo de estadísticas no necesita inventar una autenticación nueva.

### 5.6 Observación importante sobre listados actuales

`POST /sale/skip` y `POST /sale/search` resuelven el listado operativo.

No conviene reutilizarlos para reporting.

Una lista operativa NO es un contrato de analytics.

---

## 6. Lo que backend debería resolver en el RFC formal

## 6.1 Estrategia de permisos

El contexto viejo hablaba de `read_sale_stats` como permiso puntual.

Con el RFC nuevo, esto quedó menos rígido.

### Lo que backend debería decidir explícitamente

#### Opción A — permiso general al centro de estadísticas

Ejemplo conceptual:

```txt
read_stats
```

#### Opción B — reutilizar temporalmente el permiso histórico

```txt
read_sale_stats
```

y luego refinar permisos por submódulo si hace falta.

### Lo importante

Frontend ya NO depende de tener permisos finos por submódulo en esta primera fase.
Pero backend sí debería dejar claro:

- quién accede al hub
- quién accede al módulo de usuarios
- si el permiso actual es transicional o definitivo

## 6.2 Endpoints mínimos recomendados

### Mínimo obligatorio

```http
POST /sale/stats/by-user
```

### Recomendado para el hub

```http
POST /sale/stats/overview
```

### Opcional según decisión final

- filtro por `userId` dentro de `POST /sale/stats/by-user`
- o endpoint de detalle agregado por usuario

## 6.3 Request esperado

Backend debería aceptar algo como:

```json
{
  "period": "month",
  "from": "2026-04-01T00:00:00.000-03:00",
  "to": "2026-04-30T23:59:59.999-03:00",
  "timezone": "America/Argentina/Buenos_Aires",
  "includeCancelled": false
}
```

Y si se elige filtro por usuario:

```json
{
  "period": "custom",
  "from": "2026-04-01T00:00:00.000-03:00",
  "to": "2026-04-30T23:59:59.999-03:00",
  "timezone": "America/Argentina/Buenos_Aires",
  "includeCancelled": false,
  "userId": "u1"
}
```

## 6.4 Response esperado para `by-user`

Ejemplo:

```json
{
  "summary": {
    "totalSalesCount": 128,
    "totalAmount": 351240.75,
    "activeSellersCount": 6,
    "averageTicket": 2744.07,
    "from": "2026-04-01T00:00:00.000-03:00",
    "to": "2026-04-30T23:59:59.999-03:00",
    "generatedAt": "2026-04-20T18:45:00.000-03:00"
  },
  "items": [
    {
      "userId": "u1",
      "nickname": "Pedro",
      "roleName": "Vendedor",
      "salesCount": 32,
      "totalAmount": 104300.25,
      "averageTicket": 3259.38
    }
  ]
}
```

## 6.5 Response esperado para `overview`

Ejemplo:

```json
{
  "summary": {
    "totalSalesCount": 128,
    "totalAmount": 351240.75,
    "activeSellersCount": 6,
    "averageTicket": 2744.07,
    "from": "2026-04-01T00:00:00.000-03:00",
    "to": "2026-04-30T23:59:59.999-03:00",
    "generatedAt": "2026-04-20T18:45:00.000-03:00"
  }
}
```

## 6.6 Reglas de negocio que backend debe cerrar bien

- cómo se calcula `day`
- cómo se calcula `week`
- qué timezone manda
- si `custom` es inclusivo en ambos extremos
- cómo se excluyen ventas `Cancelado`
- cómo se ordena el resultado por usuario
- qué pasa cuando no hay datos
- cómo se normaliza la identidad del vendedor

---

## 7. Qué backend NO tiene que hacer en esta fase

- no calcular sueldo
- no guardar el porcentaje ingresado por el admin
- no mezclar esto con ventas offline del dispositivo
- no depender de la paginación del listado de ventas
- no forzar que el hub completo exista si se quiere entregar primero `by-user`

---

## 8. Riesgos a tener presentes

1. Ambigüedad entre analytics de usuarios y analytics de ventas.
2. Ambigüedad entre sueldo estimado y liquidación real.
3. Permisos poco claros entre hub general y módulos específicos.
4. Desfase por zona horaria.
5. Identidad del usuario creador de la venta mal normalizada.
6. Intentar resolver estadísticas desde endpoints operativos.

---

## 9. Próximo paso recomendado

Desde este repo, el siguiente paso correcto es redactar un RFC backend formal apoyado en:

- esta nueva dirección modular
- la estrategia de permisos elegida
- la agregación real en base de datos
- el contrato definitivo para `overview` y/o `by-user`
- la semántica exacta de filtros y timezone

Este resumen ya deja actualizado el contexto.

El RFC formal ahora tiene que bajar esto a:

- arquitectura
- validaciones
- pipeline de agregación
- permisos
- criterios de implementación
