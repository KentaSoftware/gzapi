# Stock scenario seeds (avance 2 / CUR-3–CUR-4)

Scripts de QA local de `/stock-smart` contra **`test_route_plan` únicamente**.

## Safety

Cada script aborta si `MONGODB_URI` no es:

`mongodb://127.0.0.1:27017/test_route_plan` o `mongodb://localhost:27017/test_route_plan`

## Comandos

Desde `repos/gzapi` (con `.env` apuntando a `test_route_plan`):

```bash
npm run seed:stock:wipe

npm run seed:stock:01-alertas
npm run seed:stock:02-saludable
npm run seed:stock:03-vencidos
npm run seed:stock:04-rotacion
npm run seed:stock:05-panel
```

Cada escenario (salvo `wipe`) **borra la DB**, recrea admin/roles y carga el caso.

Después de wipe/seed: **volver a loguear** como `admin` / `ADMIN_PASSWORD` (default `123`). No hace falta reiniciar la API (sí conviene **Actualizar** en `/stock-smart`).

> Los demo fixtures del seed de arranque de la API requieren replica set; estos scripts **no** los usan (insertan inventario directo).

## Qué carga cada caso y qué revisar

| Seed | Qué simula | Qué mirar |
|------|------------|-----------|
| **01** alertas | Mix de crítico/media stock, vencidos, por vencer (crítica/media), baja rotación, historial insuficiente, untracked | KPIs poblados; columnas Crítica/Media; M1 no debería aparecer vacío global |
| **02** saludable | ~20 productos OK (stock, vencimiento y rotación) | Empty M1: *Todos los indicadores operan dentro de los parámetros normales* |
| **03** vencidos | ~36 con lotes vencidos + 4 con compromiso + sanos | Modal Configuración → tabla vencidos catálogo; retiro individual/masivo; parciales |
| **04** rotación | Baja/nula vs sana vs producto nuevo; ventas canceladas no cuentan | KPI Baja rotación; copy *salidas* / historial insuficiente |
| **05** panel rico | ~90 productos densos (multi-lote, compromisos, untracked) | Demo completa: paginación, filtros, consulta rápida, PDF, config |

### Tips

1. Fecha operativa: reglas usan hoy en `America/Argentina/Buenos_Aires`.
2. Baja rotación: `sum(unidades salidas 30d) < minimum` (no “cantidad de ventas”).
3. Severidades: crítica si valor `< floor(umbral/2)`; media si `floor(umbral/2) ≤ valor < umbral` (stock) o `≤ umbral` (días).
4. Tras seed 05, generá el PDF y abrí Configuración para ver vencidos de catálogo completo.
