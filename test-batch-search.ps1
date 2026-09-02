# ============================================
# TEST SCRIPT: Batch Catalog Search (Fase 4B)
# ============================================
# Valida endpoint POST /catalog/search/batch
# con múltiples scopes y queries

$API_URL = "http://localhost:3000/api"
$TOKEN = ""

# ============================================
# FUNCIONES AUXILIARES
# ============================================

function Get-AuthToken {
    Write-Host "`n=== OBTENIENDO TOKEN ===" -ForegroundColor Cyan
    $loginResponse = Invoke-RestMethod -Uri "$API_URL/auth/login" -Method POST -Body (@{
        email = "admin@golozur.com"
        password = "admin123"
    } | ConvertTo-Json) -ContentType "application/json"
    
    if ($loginResponse.token) {
        Write-Host "✓ Token obtenido exitosamente" -ForegroundColor Green
        return $loginResponse.token
    } else {
        Write-Host "✗ Error obteniendo token" -ForegroundColor Red
        exit 1
    }
}

function Test-Endpoint {
    param(
        [string]$TestName,
        [string]$Method,
        [string]$Endpoint,
        [object]$Body,
        [int]$ExpectedStatus,
        [string]$ExpectedError
    )
    
    Write-Host "`n--- TEST: $TestName ---" -ForegroundColor Yellow
    
    try {
        $headers = @{
            "Authorization" = "Bearer $TOKEN"
            "Content-Type" = "application/json"
        }
        
        $response = Invoke-WebRequest -Uri "$API_URL$Endpoint" -Method $Method `
            -Headers $headers -Body ($Body | ConvertTo-Json -Depth 10) `
            -ErrorAction Stop
        
        $statusCode = $response.StatusCode
        $content = $response.Content | ConvertFrom-Json
        
        if ($statusCode -eq $ExpectedStatus) {
            Write-Host "✓ Status Code: $statusCode (esperado)" -ForegroundColor Green
            Write-Host "Response:" -ForegroundColor Gray
            Write-Host ($content | ConvertTo-Json -Depth 5) -ForegroundColor Gray
            return $true
        } else {
            Write-Host "✗ Status Code: $statusCode (esperado: $ExpectedStatus)" -ForegroundColor Red
            return $false
        }
    } catch {
        $statusCode = $_.Exception.Response.StatusCode.Value__
        $errorBody = $_.ErrorDetails.Message | ConvertFrom-Json
        
        if ($statusCode -eq $ExpectedStatus) {
            Write-Host "✓ Status Code: $statusCode (esperado)" -ForegroundColor Green
            
            if ($ExpectedError -and $errorBody.error -eq $ExpectedError) {
                Write-Host "✓ Error Code: $($errorBody.error) (esperado)" -ForegroundColor Green
            }
            
            Write-Host "Error Response:" -ForegroundColor Gray
            Write-Host ($errorBody | ConvertTo-Json) -ForegroundColor Gray
            return $true
        } else {
            Write-Host "✗ Status Code: $statusCode (esperado: $ExpectedStatus)" -ForegroundColor Red
            Write-Host ($errorBody | ConvertTo-Json) -ForegroundColor Red
            return $false
        }
    }
}

# ============================================
# OBTENER TOKEN
# ============================================

$TOKEN = Get-AuthToken

# ============================================
# OBTENER PROVIDER ID PARA TESTS
# ============================================

Write-Host "`n=== OBTENIENDO PROVIDER ID ===" -ForegroundColor Cyan

try {
    $headers = @{
        "Authorization" = "Bearer $TOKEN"
    }
    
    $providersResponse = Invoke-RestMethod -Uri "$API_URL/catalog/providers" -Method GET -Headers $headers
    
    if ($providersResponse.success -and $providersResponse.providers.Count -gt 0) {
        $PROVIDER_ID = $providersResponse.providers[0].providerId
        Write-Host "✓ Provider ID obtenido: $PROVIDER_ID" -ForegroundColor Green
    } else {
        Write-Host "✗ No se encontraron proveedores. Saliendo..." -ForegroundColor Red
        exit 1
    }
} catch {
    Write-Host "✗ Error obteniendo providers" -ForegroundColor Red
    exit 1
}

# ============================================
# TESTS DE VALIDACIÓN
# ============================================

Write-Host "`n============================================" -ForegroundColor Magenta
Write-Host "TESTS DE VALIDACIÓN" -ForegroundColor Magenta
Write-Host "============================================" -ForegroundColor Magenta

# Test 1: Queries no es array
Test-Endpoint -TestName "queries no es array" `
    -Method POST -Endpoint "/catalog/search/batch" `
    -Body @{ queries = "invalid" } `
    -ExpectedStatus 400 -ExpectedError "INVALID_QUERIES"

# Test 2: Queries vacío
Test-Endpoint -TestName "queries array vacío" `
    -Method POST -Endpoint "/catalog/search/batch" `
    -Body @{ queries = @() } `
    -ExpectedStatus 400 -ExpectedError "EMPTY_QUERIES"

# Test 3: Demasiadas queries (> 50)
$manyQueries = 1..51 | ForEach-Object {
    @{ queryId = "q$_"; q = "producto" }
}
Test-Endpoint -TestName "más de 50 queries" `
    -Method POST -Endpoint "/catalog/search/batch" `
    -Body @{ queries = $manyQueries } `
    -ExpectedStatus 400 -ExpectedError "TOO_MANY_QUERIES"

# Test 4: Query sin queryId
Test-Endpoint -TestName "query sin queryId" `
    -Method POST -Endpoint "/catalog/search/batch" `
    -Body @{
        queries = @(
            @{ q = "producto" }
        )
    } `
    -ExpectedStatus 400 -ExpectedError "MISSING_QUERY_ID"

# Test 5: Query sin q ni barcode
Test-Endpoint -TestName "query sin q ni barcode" `
    -Method POST -Endpoint "/catalog/search/batch" `
    -Body @{
        queries = @(
            @{ queryId = "q1" }
        )
    } `
    -ExpectedStatus 400 -ExpectedError "MISSING_SEARCH_TERM"

# Test 6: Query con q muy corta (< 2 caracteres)
Test-Endpoint -TestName "query con q muy corta" `
    -Method POST -Endpoint "/catalog/search/batch" `
    -Body @{
        queries = @(
            @{ queryId = "q1"; q = "a" }
        )
    } `
    -ExpectedStatus 400 -ExpectedError "QUERY_TOO_SHORT"

# Test 7: providerId inválido
Test-Endpoint -TestName "providerId inválido" `
    -Method POST -Endpoint "/catalog/search/batch" `
    -Body @{
        queries = @(
            @{ queryId = "q1"; q = "producto" }
        )
        providerId = "invalid-id"
    } `
    -ExpectedStatus 400 -ExpectedError "INVALID_PROVIDER_ID"

# Test 8: scope inválido
Test-Endpoint -TestName "scope inválido" `
    -Method POST -Endpoint "/catalog/search/batch" `
    -Body @{
        queries = @(
            @{ queryId = "q1"; q = "producto" }
        )
        scope = "INVALID_SCOPE"
    } `
    -ExpectedStatus 400 -ExpectedError "INVALID_SCOPE"

# Test 9: topK inválido (< 1)
Test-Endpoint -TestName "topK menor a 1" `
    -Method POST -Endpoint "/catalog/search/batch" `
    -Body @{
        queries = @(
            @{ queryId = "q1"; q = "producto" }
        )
        topK = 0
    } `
    -ExpectedStatus 400 -ExpectedError "INVALID_TOP_K"

# Test 10: topK inválido (> 50)
Test-Endpoint -TestName "topK mayor a 50" `
    -Method POST -Endpoint "/catalog/search/batch" `
    -Body @{
        queries = @(
            @{ queryId = "q1"; q = "producto" }
        )
        topK = 51
    } `
    -ExpectedStatus 400 -ExpectedError "INVALID_TOP_K"

# Test 11: minCandidates inválido (< 0)
Test-Endpoint -TestName "minCandidates negativo" `
    -Method POST -Endpoint "/catalog/search/batch" `
    -Body @{
        queries = @(
            @{ queryId = "q1"; q = "producto" }
        )
        minCandidates = -1
    } `
    -ExpectedStatus 400 -ExpectedError "INVALID_MIN_CANDIDATES"

# ============================================
# TESTS FUNCIONALES
# ============================================

Write-Host "`n============================================" -ForegroundColor Magenta
Write-Host "TESTS FUNCIONALES" -ForegroundColor Magenta
Write-Host "============================================" -ForegroundColor Magenta

# Test 12: Búsqueda por texto GLOBAL_ONLY (1 query)
Test-Endpoint -TestName "Búsqueda texto GLOBAL_ONLY - 1 query" `
    -Method POST -Endpoint "/catalog/search/batch" `
    -Body @{
        queries = @(
            @{ queryId = "q1"; q = "coca cola" }
        )
        scope = "GLOBAL_ONLY"
        topK = 10
    } `
    -ExpectedStatus 200

# Test 13: Búsqueda por texto PROVIDER_ONLY
Test-Endpoint -TestName "Búsqueda texto PROVIDER_ONLY" `
    -Method POST -Endpoint "/catalog/search/batch" `
    -Body @{
        queries = @(
            @{ queryId = "q1"; q = "coca" }
        )
        providerId = $PROVIDER_ID
        scope = "PROVIDER_ONLY"
        topK = 5
    } `
    -ExpectedStatus 200

# Test 14: Búsqueda por texto PROVIDER_FIRST con fallback
Test-Endpoint -TestName "Búsqueda texto PROVIDER_FIRST con fallback" `
    -Method POST -Endpoint "/catalog/search/batch" `
    -Body @{
        queries = @(
            @{ queryId = "q1"; q = "producto raro que no existe en provider" }
        )
        providerId = $PROVIDER_ID
        scope = "PROVIDER_FIRST"
        minCandidates = 5
        topK = 10
    } `
    -ExpectedStatus 200

# Test 15: Búsqueda por barcode GLOBAL_ONLY
Test-Endpoint -TestName "Búsqueda barcode GLOBAL_ONLY" `
    -Method POST -Endpoint "/catalog/search/batch" `
    -Body @{
        queries = @(
            @{ queryId = "q1"; barcode = "7790742001016" }
        )
        scope = "GLOBAL_ONLY"
    } `
    -ExpectedStatus 200

# Test 16: Batch con múltiples queries (mix de texto y barcode)
Test-Endpoint -TestName "Batch múltiples queries (texto + barcode)" `
    -Method POST -Endpoint "/catalog/search/batch" `
    -Body @{
        queries = @(
            @{ queryId = "q1"; q = "coca cola" }
            @{ queryId = "q2"; q = "pepsi" }
            @{ queryId = "q3"; barcode = "7790742001016" }
            @{ queryId = "q4"; q = "agua mineral" }
        )
        scope = "GLOBAL_ONLY"
        topK = 5
    } `
    -ExpectedStatus 200

# Test 17: Batch PROVIDER_FIRST con múltiples queries
Test-Endpoint -TestName "Batch PROVIDER_FIRST - múltiples queries" `
    -Method POST -Endpoint "/catalog/search/batch" `
    -Body @{
        queries = @(
            @{ queryId = "q1"; q = "coca" }
            @{ queryId = "q2"; q = "pepsi" }
            @{ queryId = "q3"; q = "fanta" }
        )
        providerId = $PROVIDER_ID
        scope = "PROVIDER_FIRST"
        minCandidates = 3
        topK = 10
    } `
    -ExpectedStatus 200

# Test 18: Batch sin providerId (debe actuar como GLOBAL_ONLY)
Test-Endpoint -TestName "Batch sin providerId (PROVIDER_FIRST => GLOBAL)" `
    -Method POST -Endpoint "/catalog/search/batch" `
    -Body @{
        queries = @(
            @{ queryId = "q1"; q = "producto" }
        )
        scope = "PROVIDER_FIRST"
    } `
    -ExpectedStatus 200

# Test 19: Batch con topK=1 (solo mejor resultado)
Test-Endpoint -TestName "Batch con topK=1" `
    -Method POST -Endpoint "/catalog/search/batch" `
    -Body @{
        queries = @(
            @{ queryId = "q1"; q = "coca cola" }
        )
        scope = "GLOBAL_ONLY"
        topK = 1
    } `
    -ExpectedStatus 200

# Test 20: Batch con minCandidates=0 (sin fallback)
Test-Endpoint -TestName "Batch con minCandidates=0" `
    -Method POST -Endpoint "/catalog/search/batch" `
    -Body @{
        queries = @(
            @{ queryId = "q1"; q = "producto inexistente xyz" }
        )
        providerId = $PROVIDER_ID
        scope = "PROVIDER_FIRST"
        minCandidates = 0
        topK = 10
    } `
    -ExpectedStatus 200

# ============================================
# TESTS DE PERFORMANCE
# ============================================

Write-Host "`n============================================" -ForegroundColor Magenta
Write-Host "TESTS DE PERFORMANCE" -ForegroundColor Magenta
Write-Host "============================================" -ForegroundColor Magenta

# Test 21: Batch con 20 queries (carga media)
$twentyQueries = 1..20 | ForEach-Object {
    @{ queryId = "q$_"; q = "producto $_" }
}
Test-Endpoint -TestName "Batch con 20 queries" `
    -Method POST -Endpoint "/catalog/search/batch" `
    -Body @{
        queries = $twentyQueries
        scope = "GLOBAL_ONLY"
        topK = 5
    } `
    -ExpectedStatus 200

# Test 22: Batch con 50 queries (máximo permitido)
$fiftyQueries = 1..50 | ForEach-Object {
    @{ queryId = "q$_"; q = "producto $_" }
}
Test-Endpoint -TestName "Batch con 50 queries (máximo)" `
    -Method POST -Endpoint "/catalog/search/batch" `
    -Body @{
        queries = $fiftyQueries
        scope = "GLOBAL_ONLY"
        topK = 5
    } `
    -ExpectedStatus 200

# ============================================
# RESUMEN
# ============================================

Write-Host "`n============================================" -ForegroundColor Magenta
Write-Host "TESTS COMPLETADOS" -ForegroundColor Magenta
Write-Host "============================================" -ForegroundColor Magenta
Write-Host "Total: 22 tests ejecutados" -ForegroundColor Cyan
Write-Host "Revisar salida para verificar resultados" -ForegroundColor Cyan
