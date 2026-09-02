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

---

## Licencia

Este proyecto es **propietario** y está protegido por derechos de autor.  
**Prohibido su uso, copia, modificación o distribución sin autorización.**

Ver [LICENSE](./LICENSE) para más detalles.
