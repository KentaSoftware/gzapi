# GZAPI - Golozur Backend API

**Version:** 0.6.0  
**Node:** 18+  
**TypeScript:** 5.x  
**Database:** MongoDB 6.x  

---

## 📋 Descripción

Backend API REST para sistema de gestión de distribuidora Golozur. Incluye módulos de:
- 🔐 Autenticación JWT + RBAC
- 📦 Gestión de productos y catálogo
- 💰 Ventas y compras
- 💸 Egresos
- 👥 Clientes y proveedores
- 📊 Reportes y analytics
- 🤖 Integración con Document AI

---

## 🚀 Quick Start

### Instalación

```bash
npm install
```

### Variables de Entorno

Crear archivo `.env`:

```env
PORT=3000
MONGODB_URI=mongodb://localhost:27017/golozur
JWT_SECRET=your-secret-key
JWT_EXPIRES=7d
NODE_ENV=development
DOCUMENT_AI_URL=http://localhost:8000
```

### Ejecución

```bash
# Development (con hot reload)
npm run dev

# Production
npm run build
npm start
```

### Testing

```bash
# Compilación TypeScript
npx tsc --noEmit

# Tests funcionales
.\test-fase3b.ps1
.\test-fase4a.ps1
.\test-batch-search.ps1
```

---

## 📁 Estructura del Proyecto

```
gzapi/
├── src/
│   ├── app.ts              # Express app setup
│   ├── socket.ts           # WebSocket server
│   ├── config/
│   │   └── mongo.ts        # MongoDB connection
│   ├── controllers/        # Request handlers
│   │   ├── auth.ts
│   │   ├── product.ts
│   │   ├── catalog.ts      # ⭐ Catalog + batch search
│   │   ├── duplicateCheck.ts
│   │   └── ...
│   ├── services/           # Business logic
│   │   ├── catalog.ts      # ⭐ Batch search service
│   │   ├── productAlias.ts
│   │   ├── duplicateCheck.ts
│   │   └── ...
│   ├── models/             # Mongoose schemas
│   │   ├── product.ts
│   │   ├── catalogVersion.ts
│   │   ├── productAlias.ts
│   │   └── ...
│   ├── routes/             # Route definitions
│   │   ├── catalog.ts      # ⭐ /catalog/search/batch
│   │   └── ...
│   ├── middleware/
│   │   ├── session.ts      # JWT validation
│   │   ├── checkPermission.ts  # RBAC
│   │   └── requestLogger.ts    # Centralized logging
│   ├── interfaces/         # TypeScript types
│   │   ├── catalog.interface.ts  # ⭐ Batch search DTOs
│   │   └── ...
│   └── utils/
├── test-fase3b.ps1         # Catalog versioning tests
├── test-fase4a.ps1         # Duplicate detection tests
├── test-batch-search.ps1   # ⭐ Batch search tests
├── package.json
└── tsconfig.json
```

---

## 🔌 Endpoints Principales

### Autenticación

```
POST   /api/auth/register      # Registro
POST   /api/auth/login         # Login (retorna JWT)
GET    /api/auth/check         # Verificar sesión
```

### Catálogo

```
GET    /api/catalog/providers                # Listar proveedores con versión
GET    /api/catalog/version?providerId=...   # Obtener versión de catálogo
GET    /api/catalog/snapshot?providerId=...  # Snapshot liviano paginado
GET    /api/catalog/search?q=...             # Búsqueda individual
POST   /api/catalog/search/batch             # ⭐ Búsqueda batch (Fase 4B)
POST   /api/catalog/aliases                  # Crear/actualizar alias
POST   /api/catalog/matches/confirm          # Confirmar matching
```

### Productos

```
GET    /api/product              # Listar productos
GET    /api/product/:id          # Obtener producto
POST   /api/product              # Crear producto
PUT    /api/product/:id          # Actualizar producto
DELETE /api/product/:id          # Eliminar producto
```

### Compras

```
GET    /api/buy                  # Listar compras
GET    /api/buy/:id              # Obtener compra
POST   /api/buy                  # Crear compra
PUT    /api/buy/:id              # Actualizar compra
DELETE /api/buy/:id              # Eliminar compra
```

### Duplicate Detection (Fase 4A)

```
POST   /api/duplicate/check                  # Verificar duplicados
POST   /api/duplicate/decision/:checkId      # Registrar decisión
GET    /api/duplicate/history?buyId=...      # Historial de checks
```

---

## ⭐ Fase 4B: Batch Catalog Search

### Descripción

Endpoint de búsqueda batch para Document AI. Permite consultar múltiples ítems en 1 request con soporte para:
- 🎯 **3 scopes:** PROVIDER_ONLY, GLOBAL_ONLY, PROVIDER_FIRST
- 📦 **Payload liviano:** ProductSummary (8 campos)
- ⚡ **Fallback automático:** Provider → Global si < minCandidates
- 🔍 **2 métodos:** Barcode exact + Text regex

### Request

```bash
POST /api/catalog/search/batch
Authorization: Bearer <token>
Content-Type: application/json

{
  "queries": [
    { "queryId": "item1", "q": "coca cola 500ml" },
    { "queryId": "item2", "barcode": "7790742001016" }
  ],
  "providerId": "60d5ec49f1b2c8b1f8c8e8e8",
  "scope": "PROVIDER_FIRST",
  "topK": 10,
  "minCandidates": 5
}
```

### Response

```json
{
  "success": true,
  "results": [
    {
      "queryId": "item1",
      "query": { "q": "coca cola 500ml", "barcode": null },
      "candidates": [
        {
          "productId": "60d5ec49...",
          "description": "Coca Cola 500ml",
          "codigoBarra": "7790742001016",
          "proveedor": "60d5ec49...",
          "categoria": "60d5ec49...",
          "marca": "60d5ec49...",
          "unidad": "ml",
          "pack": 1
        }
      ],
      "meta": {
        "providerCount": 1,
        "globalCount": 0,
        "totalReturned": 1,
        "usedScope": "PROVIDER_ONLY",
        "retrievalMethods": ["TEXT_REGEX"]
      }
    }
  ],
  "meta": {
    "totalQueries": 2,
    "avgCandidatesPerQuery": 5.5,
    "executionTimeMs": 35
  }
}
```

### Scopes

| Scope | Comportamiento |
|-------|----------------|
| `PROVIDER_FIRST` | Busca en provider, fallback a global si < minCandidates (**default**) |
| `PROVIDER_ONLY` | Solo busca en catálogo del proveedor |
| `GLOBAL_ONLY` | Busca en todo el catálogo sin filtro |

### Parámetros

| Campo | Tipo | Requerido | Default | Límites | Descripción |
|-------|------|-----------|---------|---------|-------------|
| `queries` | Array | ✅ | - | 1-50 items | Queries a procesar |
| `queries[].queryId` | String | ✅ | - | - | ID único de query |
| `queries[].q` | String | ⚠️* | - | min 2 chars | Texto a buscar |
| `queries[].barcode` | String | ⚠️* | - | - | Código de barras |
| `providerId` | String | ❌ | - | ObjectId | ID del proveedor |
| `scope` | Enum | ❌ | PROVIDER_FIRST | ver tabla | Scope de búsqueda |
| `topK` | Number | ❌ | 20 | 1-50 | Máx candidatos/query |
| `minCandidates` | Number | ❌ | 10 | >= 0 | Mín antes de fallback |

*⚠️ Al menos uno (`q` o `barcode`) es requerido por query

### Testing

```powershell
# 22 tests: validaciones, funcionales, performance
.\test-batch-search.ps1
```

---

## 🔐 Autenticación y Autorización

### JWT

Todos los endpoints (excepto `/auth/login` y `/auth/register`) requieren JWT en header:

```
Authorization: Bearer <token>
```

### RBAC (Role-Based Access Control)

Permisos definidos por rol:

| Rol | Permisos |
|-----|----------|
| **admin** | Todos los permisos |
| **manager** | CRUD productos, compras, ventas, egresos, catalog_read, catalog_write |
| **employee** | Read-only productos, ventas, catalog_read |
| **viewer** | Read-only productos, catalog_read |

### Middleware

```typescript
import { checkJwt } from '../middleware/session'
import { checkPermission } from '../middleware/checkPermission'

router.post('/catalog/search/batch', 
  checkJwt, 
  checkPermission('catalog_read'), 
  batchSearch
)
```

---

## 📊 Índices MongoDB

### Críticos para Performance

```javascript
// Products
db.products.createIndex({ codigoBarra: 1 })
db.products.createIndex({ proveedor: 1, descripcion: 1 })

// Catalog Versions
db.catalog_versions.createIndex({ providerId: 1 }, { unique: true })

// Product Aliases
db.product_aliases.createIndex({ providerId: 1, aliasType: 1, aliasValueNormalized: 1 })

// Duplicate Checks
db.purchase_doc_duplicate_checks.createIndex({ buyId: 1 })
db.purchase_doc_duplicate_checks.createIndex({ docNumber: 1, providerId: 1 })
db.purchase_doc_duplicate_checks.createIndex({ checkStatus: 1 })
```

---

## 🧪 Testing

### Unit Tests (Futuro)

```bash
npm test
```

### Functional Tests

```powershell
# Fase 3B: Catalog versioning + learning
.\test-fase3b.ps1

# Fase 4A: Duplicate detection
.\test-fase4a.ps1

# Fase 4B: Batch catalog search
.\test-batch-search.ps1
```

### TypeScript Compilation

```bash
npx tsc --noEmit
```

**Expected:** 0 errors

---

## 📈 Monitoreo y Logs

### Logs Centralizados

Middleware `requestLogger` en todas las rutas:

```
[2024-12-30 15:23:45] POST /api/catalog/search/batch - User: 60d5ec49... - Status: 200 - 35ms
[2024-12-30 15:23:46] GET /api/catalog/version?providerId=... - User: 60d5ec49... - Status: 200 - 12ms
```

### Métricas Clave

- Latencia p50/p95/p99 por endpoint
- Error rate por endpoint
- Batch search: global fallback rate
- Duplicate detection: duplicate rate
- Catalog bump frequency

---

## 🔄 CI/CD

### Pre-commit Checks

```bash
# Lint
npm run lint

# TypeScript compile check
npx tsc --noEmit

# Tests
.\test-fase3b.ps1
.\test-fase4a.ps1
.\test-batch-search.ps1
```

### Deployment

```bash
# Build
npm run build

# Start production
npm start
```

---

## 📚 Documentación Adicional

- **Fase 3B:** [Fase3B_v0.4.1_Implementacion.md](../Documentacion/Fase3B_v0.4.1_Implementacion.md)
- **Fase 4A:** [Fase4A_Duplicate_Detection.md](../Documentacion/Fase4A_Duplicate_Detection.md)
- **Fase 4B:** [Fase4B_Batch_Catalog_Search.md](../Documentacion/Fase4B_Batch_Catalog_Search.md)
- **Resumen Fase 4B:** [Fase4B_Resumen_Ejecutivo.md](../Documentacion/Fase4B_Resumen_Ejecutivo.md)

---

## 🛠️ Tech Stack

- **Runtime:** Node.js 18+
- **Language:** TypeScript 5.x
- **Framework:** Express 4.x
- **Database:** MongoDB 6.x
- **ODM:** Mongoose 8.x
- **Auth:** JWT (jsonwebtoken)
- **Validation:** Custom middleware
- **WebSocket:** Socket.io
- **Testing:** PowerShell scripts (functional)

---

## 🔮 Roadmap

### v0.7.0 (Q1 2025)
- [ ] Unit tests (Jest)
- [ ] Redis caching para batch search
- [ ] MongoDB Atlas Search (full-text)
- [ ] ML re-ranking en backend

### v0.8.0 (Q2 2025)
- [ ] GraphQL API
- [ ] Webhooks para Document AI
- [ ] Real-time analytics dashboard
- [ ] Audit log completo

---

## 🐛 Bug Reports

Reportar issues en:
- Email: dev@golozur.com
- Slack: #backend-bugs

---

## 👥 Equipo

- **Backend Lead:** [Nombre]
- **DevOps:** [Nombre]
- **QA:** [Nombre]

---

**Última Actualización:** 30/12/2024  
**Versión:** 0.6.0
