# GZ API

API REST del ecosistema Golozur. Backend para gestión comercial: ventas, compras, productos, clientes, usuarios, roles y reportes. Integra MongoDB, autenticación JWT, Socket.io y generación de PDF.

---

## Características del proyecto

### Módulos principales

- **Auth**: Login, JWT, verificación de sesión
- **Ventas (sale)**: CRUD, items de venta, impresión PDF individual y múltiple
- **Compras (buy)**: Registro de compras e items
- **Productos (product)**: CRUD con categorías, marcas, proveedores, imágenes
- **Clientes (client)**: Gestión con ubicación
- **Usuarios y roles**: Permisos por rol, middleware de autorización
- **Proveedores, categorías, marcas, ciudades**: Catálogos de soporte
- **Logs**: Registro de actividad
- **Backup**: Respaldo de datos
- **Dataset**: Datos para reportes y estadísticas

### Stack tecnológico

| Categoría | Tecnología |
|-----------|------------|
| Runtime | Node.js |
| Framework | Express |
| Base de datos | MongoDB, Mongoose |
| Autenticación | JWT, bcrypt |
| Tiempo real | Socket.io |
| Validación | TypeScript |
| Imágenes | Sharp, Multer |
| PDF | PDFKit |

### Estructura del proyecto

```
src/
├── config/       # Conexión MongoDB
├── controllers/  # Lógica de endpoints (auth, sale, product, client, etc.)
├── interfaces/   # Tipos e interfaces
├── middleware/   # Session, permisos, upload de archivos
├── models/       # Esquemas Mongoose
├── routes/       # Rutas Express (carga dinámica)
├── services/     # Lógica de negocio
├── socket.ts     # Configuración Socket.io
└── utils/        # JWT, bcrypt, manejo de errores e imágenes
```

### Requisitos de entorno

- Node.js
- MongoDB
- Variables: `DB_URI`, `JWT_SECRET`, etc.

### Scripts

```bash
npm run dev   # Desarrollo con nodemon
npm run build # Compilar TypeScript
npm start     # Producción
npm test      # Tests (Mocha)
```

### Datos de prueba de Optimización de Rutas

El seed siguiente es **exclusivamente para pruebas locales**. Carga la base
`test_route_plan` en MongoDB local con datos sintéticos de Tucumán:
Tafí del Valle, El Mollar, Monteros, Los Sarmientos, Aguilares y Test-Route.

Requisitos:

- MongoDB ejecutándose en `127.0.0.1:27017`.
- Dependencias instaladas con `npm install`.

Ejecutar:

```bash
npm run seed:route-plan:test
```

El seed es idempotente y no elimina datos. Crea o actualiza 6 zonas, 34
clientes, 34 ventas pendientes, un usuario de pruebas, un vehículo de prueba,
la configuración `deposito_1` y tres snapshots demo para `TEST_ROUTE`, usando
los ocho clientes con coordenadas explícitas. Los snapshots se distribuyen en
3 rutas (4/2/2 paradas) y sus métricas de distancia, duración, combustible y
horarios son estimaciones deterministas locales; no representan datos de
producción.

Valores opcionales:

```bash
ROUTE_PLAN_SERVICE_DATE=2026-10-14 npm run seed:route-plan:test
ROUTE_PLAN_TEST_PASSWORD=tu-password-local npm run seed:route-plan:test
```

Usuario local predeterminado:

```text
nickname: route-plan-test
password: route-plan-test-password
```

Por seguridad, el script solo acepta `localhost`/`127.0.0.1` y la base
`test_route_plan`; rechaza cualquier otra URI.

---

## Licencia

Este proyecto es **propietario** y está protegido por derechos de autor.  
**Prohibido su uso, copia, modificación o distribución sin autorización.**

Ver [LICENSE](./LICENSE) para más detalles.
