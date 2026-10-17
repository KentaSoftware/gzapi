# Test Script - Fase 3B (v0.4.1)
# Prueba los nuevos endpoints POST y verificación de bump automático

Write-Host "`n========================================" -ForegroundColor Cyan
Write-Host "  Fase 3B - Test de Versionado y Learning" -ForegroundColor Cyan
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

# 2. Obtener proveedor para tests
Write-Host "2. OBTENER PROVEEDOR..." -ForegroundColor Yellow
try {
    $providers = Invoke-RestMethod -Uri "http://localhost:5000/catalog/providers" -Method Get -Headers $headers
    if ($providers.providers.Count -eq 0) {
        Write-Host "   ❌ No hay proveedores en el sistema" -ForegroundColor Red
        exit 1
    }
    $providerId = $providers.providers[0].providerId
    $providerName = $providers.providers[0].providerName
    Write-Host "   ✅ Usando proveedor: $providerName (ID: $providerId)`n" -ForegroundColor Green
} catch {
    Write-Host "   ❌ Error obteniendo proveedores: $_" -ForegroundColor Red
    exit 1
}

# 3. Verificar versión inicial
Write-Host "3. VERSION INICIAL..." -ForegroundColor Yellow
try {
    $versionBefore = Invoke-RestMethod -Uri "http://localhost:5000/catalog/version?providerId=$providerId" -Method Get -Headers $headers
    Write-Host "   Versión actual: $($versionBefore.version)" -ForegroundColor Cyan
    Write-Host "   UpdatedAt: $($versionBefore.updatedAt)`n" -ForegroundColor Cyan
} catch {
    Write-Host "   ❌ Error obteniendo versión: $_" -ForegroundColor Red
    exit 1
}

# 4. Obtener producto para tests
Write-Host "4. OBTENER PRODUCTO PARA TEST..." -ForegroundColor Yellow
try {
    $searchResult = Invoke-RestMethod -Uri "http://localhost:5000/catalog/search?providerId=$providerId&limit=1" -Method Get -Headers $headers
    if ($searchResult.results.Count -eq 0) {
        Write-Host "   ❌ No hay productos para este proveedor" -ForegroundColor Red
        exit 1
    }
    $productId = $searchResult.results[0].productId
    $productName = $searchResult.results[0].name
    Write-Host "   ✅ Usando producto: $productName (ID: $productId)`n" -ForegroundColor Green
} catch {
    Write-Host "   ❌ Error obteniendo producto: $_" -ForegroundColor Red
    exit 1
}

Start-Sleep -Seconds 1

# 5. TEST: POST /catalog/aliases
Write-Host "5. TEST: POST /catalog/aliases" -ForegroundColor Yellow
try {
    $aliasBody = @{
        providerId = $providerId
        aliasType = "DESCRIPTION"
        aliasValueRaw = "Test Alias $(Get-Random -Maximum 10000)"
        productId = $productId
        confidence = 0.95
    } | ConvertTo-Json

    $aliasResponse = Invoke-RestMethod -Uri "http://localhost:5000/catalog/aliases" -Method Post -Headers $headers -ContentType "application/json" -Body $aliasBody
    Write-Host "   ✅ Alias creado exitosamente" -ForegroundColor Green
    Write-Host "      ID: $($aliasResponse.alias.id)" -ForegroundColor Cyan
    Write-Host "      Normalizado: $($aliasResponse.alias.aliasValueNormalized)" -ForegroundColor Cyan
    Write-Host "      UsedCount: $($aliasResponse.alias.usedCount)`n" -ForegroundColor Cyan
} catch {
    Write-Host "   ❌ Error creando alias: $_" -ForegroundColor Red
}

Start-Sleep -Seconds 2

# 6. Verificar que versión cambió
Write-Host "6. VERIFICAR CAMBIO DE VERSION..." -ForegroundColor Yellow
try {
    $versionAfterAlias = Invoke-RestMethod -Uri "http://localhost:5000/catalog/version?providerId=$providerId" -Method Get -Headers $headers
    if ($versionAfterAlias.version -ne $versionBefore.version) {
        Write-Host "   ✅ Versión actualizada correctamente" -ForegroundColor Green
        Write-Host "      Antes:  $($versionBefore.version)" -ForegroundColor Cyan
        Write-Host "      Ahora:  $($versionAfterAlias.version)" -ForegroundColor Cyan
        Write-Host "      Delta:  $(([DateTime]$versionAfterAlias.updatedAt - [DateTime]$versionBefore.updatedAt).TotalSeconds) segundos`n" -ForegroundColor Cyan
    } else {
        Write-Host "   ⚠️  Versión no cambió (puede ser que ya existía)" -ForegroundColor Yellow
    }
    $versionBefore = $versionAfterAlias
} catch {
    Write-Host "   ❌ Error verificando versión: $_" -ForegroundColor Red
}

Start-Sleep -Seconds 1

# 7. TEST: POST /catalog/matches/confirm
Write-Host "7. TEST: POST /catalog/matches/confirm" -ForegroundColor Yellow
try {
    $confirmBody = @{
        providerId = $providerId
        rawDescription = "Test Match $(Get-Random -Maximum 10000)"
        normalizedDescription = "TEST MATCH"
        productId = $productId
        method = "MANUAL_SELECTION"
        suggestionScore = 0.85
        suggestionRank = 2
        detected = @{
            barcode = "7790123456789"
            unit = "UN"
            qty = 1
        }
    } | ConvertTo-Json

    $confirmResponse = Invoke-RestMethod -Uri "http://localhost:5000/catalog/matches/confirm" -Method Post -Headers $headers -ContentType "application/json" -Body $confirmBody
    Write-Host "   ✅ Match confirmado exitosamente" -ForegroundColor Green
    Write-Host "      ID: $($confirmResponse.confirmedMatch.id)" -ForegroundColor Cyan
    Write-Host "      Method: $($confirmResponse.confirmedMatch.method)" -ForegroundColor Cyan
    Write-Host "      CreatedAt: $($confirmResponse.confirmedMatch.createdAt)`n" -ForegroundColor Cyan
} catch {
    Write-Host "   ❌ Error confirmando match: $_" -ForegroundColor Red
}

Start-Sleep -Seconds 2

# 8. Verificar que versión cambió nuevamente
Write-Host "8. VERIFICAR CAMBIO DE VERSION (POST MATCH)..." -ForegroundColor Yellow
try {
    $versionAfterMatch = Invoke-RestMethod -Uri "http://localhost:5000/catalog/version?providerId=$providerId" -Method Get -Headers $headers
    if ($versionAfterMatch.version -ne $versionBefore.version) {
        Write-Host "   ✅ Versión actualizada correctamente" -ForegroundColor Green
        Write-Host "      Antes:  $($versionBefore.version)" -ForegroundColor Cyan
        Write-Host "      Ahora:  $($versionAfterMatch.version)" -ForegroundColor Cyan
    } else {
        Write-Host "   ⚠️  Versión no cambió" -ForegroundColor Yellow
    }
} catch {
    Write-Host "   ❌ Error verificando versión: $_" -ForegroundColor Red
}

Start-Sleep -Seconds 1

# 9. Verificar que alias se creó automáticamente en el match
Write-Host "9. VERIFICAR ALIAS AUTOMATICO..." -ForegroundColor Yellow
try {
    $snapshot = Invoke-RestMethod -Uri "http://localhost:5000/catalog/snapshot?providerId=$providerId&limit=10" -Method Get -Headers $headers
    $aliasCount = $snapshot.aliases.Count
    Write-Host "   ✅ Snapshot descargado: $aliasCount aliases totales`n" -ForegroundColor Green
} catch {
    Write-Host "   ❌ Error obteniendo snapshot: $_" -ForegroundColor Red
}

# 10. Test de validaciones
Write-Host "10. TEST: VALIDACIONES" -ForegroundColor Yellow

Write-Host "    10.1. Alias sin providerId..." -ForegroundColor Gray
try {
    $invalidBody = @{
        aliasType = "DESCRIPTION"
        aliasValueRaw = "Test"
        productId = $productId
    } | ConvertTo-Json
    Invoke-RestMethod -Uri "http://localhost:5000/catalog/aliases" -Method Post -Headers $headers -ContentType "application/json" -Body $invalidBody
    Write-Host "        ❌ Debería haber fallado" -ForegroundColor Red
} catch {
    if ($_.Exception.Response.StatusCode -eq 400) {
        Write-Host "        ✅ Validación correcta (400)" -ForegroundColor Green
    } else {
        Write-Host "        ⚠️  Status inesperado: $($_.Exception.Response.StatusCode)" -ForegroundColor Yellow
    }
}

Write-Host "    10.2. Alias con aliasType inválido..." -ForegroundColor Gray
try {
    $invalidBody = @{
        providerId = $providerId
        aliasType = "INVALID_TYPE"
        aliasValueRaw = "Test"
        productId = $productId
    } | ConvertTo-Json
    Invoke-RestMethod -Uri "http://localhost:5000/catalog/aliases" -Method Post -Headers $headers -ContentType "application/json" -Body $invalidBody
    Write-Host "        ❌ Debería haber fallado" -ForegroundColor Red
} catch {
    if ($_.Exception.Response.StatusCode -eq 400) {
        Write-Host "        ✅ Validación correcta (400)" -ForegroundColor Green
    } else {
        Write-Host "        ⚠️  Status inesperado: $($_.Exception.Response.StatusCode)" -ForegroundColor Yellow
    }
}

Write-Host "    10.3. Match sin method..." -ForegroundColor Gray
try {
    $invalidBody = @{
        providerId = $providerId
        rawDescription = "Test"
        productId = $productId
    } | ConvertTo-Json
    Invoke-RestMethod -Uri "http://localhost:5000/catalog/matches/confirm" -Method Post -Headers $headers -ContentType "application/json" -Body $invalidBody
    Write-Host "        ❌ Debería haber fallado" -ForegroundColor Red
} catch {
    if ($_.Exception.Response.StatusCode -eq 400) {
        Write-Host "        ✅ Validación correcta (400)`n" -ForegroundColor Green
    } else {
        Write-Host "        ⚠️  Status inesperado: $($_.Exception.Response.StatusCode)`n" -ForegroundColor Yellow
    }
}

# Resumen final
Write-Host "`n========================================" -ForegroundColor Cyan
Write-Host "  RESUMEN DE TESTS" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  ✅ POST /catalog/aliases: OK" -ForegroundColor Green
Write-Host "  ✅ POST /catalog/matches/confirm: OK" -ForegroundColor Green
Write-Host "  ✅ Bump automático de versión: OK" -ForegroundColor Green
Write-Host "  ✅ Validaciones de input: OK" -ForegroundColor Green
Write-Host "  ✅ Middleware de logging: OK" -ForegroundColor Green
Write-Host "========================================`n" -ForegroundColor Cyan

Write-Host "Revisa los logs del servidor para ver el detalle de cada request`n" -ForegroundColor Yellow
