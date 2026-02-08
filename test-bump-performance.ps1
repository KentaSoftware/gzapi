# Test de Performance - Bump No Bloqueante

Write-Host "`n========================================" -ForegroundColor Cyan
Write-Host "  Test: Bump de Versión No Bloquea" -ForegroundColor Cyan
Write-Host "========================================`n" -ForegroundColor Cyan

# 1. Login
Write-Host "1. LOGIN..." -ForegroundColor Yellow
try {
    $loginResponse = Invoke-RestMethod -Uri "http://localhost:5000/auth/login" -Method Post -ContentType "application/json" -Body '{"nickname":"admin","password":"admin123"}'
    $token = $loginResponse.tokenSession
    Write-Host "   ✅ Token obtenido`n" -ForegroundColor Green
} catch {
    Write-Host "   ❌ Error en login: $_" -ForegroundColor Red
    exit 1
}

$headers = @{
    "Authorization" = "Bearer $token"
}

# 2. Obtener proveedor, marca, categoría
Write-Host "2. OBTENER DATOS NECESARIOS..." -ForegroundColor Yellow
try {
    $providers = Invoke-RestMethod -Uri "http://localhost:5000/catalog/providers" -Method Get -Headers $headers
    $providerId = $providers.providers[0].providerId
    
    # Asumimos que existen marcas y categorías (ajustar según tu BD)
    $brandId = "63a746bb2592ff7d61016311"
    $categoryId = "63a746bb2592ff7d61016312"
    
    Write-Host "   ✅ Datos obtenidos`n" -ForegroundColor Green
} catch {
    Write-Host "   ❌ Error obteniendo datos: $_" -ForegroundColor Red
    exit 1
}

# 3. Test de performance: Crear 5 productos rápidamente
Write-Host "3. TEST DE PERFORMANCE: Crear 5 productos" -ForegroundColor Yellow
Write-Host "   Si el bump bloqueara, esto sería lento..." -ForegroundColor Gray

$times = @()
$productos = @()

for ($i = 1; $i -le 5; $i++) {
    $startTime = Get-Date
    
    $productBody = @{
        descripcion = "Test Performance $i - $(Get-Random -Maximum 10000)"
        proveedor = $providerId
        marca = $brandId
        categoria = $categoryId
        precioCompra = 100 + $i
        precioUnitario = 150 + $i
        stock = 10
    } | ConvertTo-Json
    
    try {
        $response = Invoke-RestMethod -Uri "http://localhost:5000/product" -Method Post -Headers $headers -ContentType "application/json" -Body $productBody
        $endTime = Get-Date
        $elapsed = ($endTime - $startTime).TotalMilliseconds
        $times += $elapsed
        $productos += $response
        
        Write-Host "   Producto $i creado en: $([math]::Round($elapsed, 2))ms" -ForegroundColor Cyan
    } catch {
        Write-Host "   ❌ Error creando producto $i" -ForegroundColor Red
    }
    
    # Pequeña pausa para no saturar
    Start-Sleep -Milliseconds 100
}

Write-Host ""

# 4. Análisis de tiempos
$avgTime = ($times | Measure-Object -Average).Average
$maxTime = ($times | Measure-Object -Maximum).Maximum
$minTime = ($times | Measure-Object -Minimum).Minimum

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  RESULTADOS DE PERFORMANCE" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Productos creados: $($productos.Count)" -ForegroundColor Green
Write-Host "  Tiempo promedio:   $([math]::Round($avgTime, 2))ms" -ForegroundColor Green
Write-Host "  Tiempo mínimo:     $([math]::Round($minTime, 2))ms" -ForegroundColor Green
Write-Host "  Tiempo máximo:     $([math]::Round($maxTime, 2))ms" -ForegroundColor Green

if ($avgTime -lt 200) {
    Write-Host "`n  ✅ EXCELENTE: Bump NO está bloqueando" -ForegroundColor Green
    Write-Host "     El bump se ejecuta asíncronamente" -ForegroundColor Gray
} elseif ($avgTime -lt 500) {
    Write-Host "`n  ⚠️  ACEPTABLE: Tiempos normales" -ForegroundColor Yellow
} else {
    Write-Host "`n  ❌ LENTO: Posible bloqueo detectado" -ForegroundColor Red
    Write-Host "     Revisar implementación del bump" -ForegroundColor Gray
}

Write-Host "========================================`n" -ForegroundColor Cyan

# 5. Verificar que las versiones se actualizaron (eventualmente)
Write-Host "5. VERIFICAR VERSIÓN DEL CATÁLOGO..." -ForegroundColor Yellow
Write-Host "   Esperando 2 segundos para que el bump se complete..." -ForegroundColor Gray
Start-Sleep -Seconds 2

try {
    $version = Invoke-RestMethod -Uri "http://localhost:5000/catalog/version?providerId=$providerId" -Method Get -Headers $headers
    Write-Host "   ✅ Versión actual: $($version.version)" -ForegroundColor Green
    Write-Host "   UpdatedAt: $($version.updatedAt)`n" -ForegroundColor Cyan
} catch {
    Write-Host "   ❌ Error obteniendo versión: $_`n" -ForegroundColor Red
}

# 6. Limpiar productos de test (opcional)
Write-Host "6. LIMPIEZA (opcional)..." -ForegroundColor Yellow
$cleanup = Read-Host "   ¿Deseas eliminar los productos de test? (s/n)"

if ($cleanup -eq "s" -or $cleanup -eq "S") {
    foreach ($producto in $productos) {
        try {
            Invoke-RestMethod -Uri "http://localhost:5000/product/$($producto._id)" -Method Delete -Headers $headers | Out-Null
            Write-Host "   ✅ Producto eliminado: $($producto._id)" -ForegroundColor Gray
        } catch {
            Write-Host "   ⚠️  No se pudo eliminar: $($producto._id)" -ForegroundColor Yellow
        }
    }
    Write-Host "`n   ✅ Limpieza completada" -ForegroundColor Green
} else {
    Write-Host "   ℹ️  Productos de test conservados" -ForegroundColor Gray
}

Write-Host "`n========================================" -ForegroundColor Cyan
Write-Host "  Test completado" -ForegroundColor Cyan
Write-Host "========================================`n" -ForegroundColor Cyan
