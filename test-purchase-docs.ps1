# Script de Pruebas - Purchase Docs Upload & Confirm
# PowerShell

Write-Host "=== PURCHASE DOCS - Script de Pruebas ===" -ForegroundColor Cyan
Write-Host ""

# Configuración
$BASE_URL = "http://localhost:3000"
$AI_URL = "http://localhost:8000"
$TEST_IMAGE = "test-factura.jpg"

# Colores para output
function Write-Success { param($msg) Write-Host "✓ $msg" -ForegroundColor Green }
function Write-Error { param($msg) Write-Host "✗ $msg" -ForegroundColor Red }
function Write-Info { param($msg) Write-Host "→ $msg" -ForegroundColor Yellow }
function Write-Section { param($msg) Write-Host "`n=== $msg ===" -ForegroundColor Cyan }

# Variables globales
$TOKEN = ""
$DRAFT_ID = ""
$PROVIDER_ID = ""

# ============================================================================
# FUNCIONES DE UTILIDAD
# ============================================================================

function Test-ServiceHealth {
    param($url, $name)
    try {
        $response = Invoke-RestMethod -Uri "$url/health" -Method Get -ErrorAction Stop
        Write-Success "$name está corriendo"
        return $true
    } catch {
        Write-Error "$name NO está disponible en $url"
        return $false
    }
}

function Get-Token {
    Write-Section "1. Autenticación"
    Write-Info "Intentando login..."
    
    $body = @{
        email = "admin@golozur.com"
        password = "admin123"
    } | ConvertTo-Json

    try {
        $response = Invoke-RestMethod -Uri "$BASE_URL/auth/login" `
            -Method Post `
            -Body $body `
            -ContentType "application/json" `
            -ErrorAction Stop
        
        if ($response.success) {
            $script:TOKEN = $response.data.token
            Write-Success "Login exitoso"
            Write-Info "Usuario: $($response.data.user.email)"
            Write-Info "Role: $($response.data.user.role.name)"
            return $true
        } else {
            Write-Error "Login falló: $($response.error)"
            return $false
        }
    } catch {
        Write-Error "Error en login: $_"
        return $false
    }
}

function Get-ProviderId {
    Write-Info "Obteniendo primer proveedor..."
    
    try {
        $response = Invoke-RestMethod -Uri "$BASE_URL/provider" `
            -Method Get `
            -Headers @{ Authorization = "Bearer $script:TOKEN" } `
            -ErrorAction Stop
        
        if ($response.data.Count -gt 0) {
            $script:PROVIDER_ID = $response.data[0]._id
            Write-Success "ProviderId obtenido: $script:PROVIDER_ID"
            return $true
        } else {
            Write-Error "No hay proveedores en la base de datos"
            return $false
        }
    } catch {
        Write-Error "Error obteniendo proveedores: $_"
        return $false
    }
}

function Create-TestImage {
    Write-Info "Creando imagen de prueba..."
    
    # Crear imagen dummy de 1MB (JPG válido mínimo)
    $bytes = New-Object byte[] 1048576
    (New-Object Random).NextBytes($bytes)
    
    # Agregar header JPG válido
    $jpgHeader = @(0xFF, 0xD8, 0xFF, 0xE0)
    for ($i = 0; $i -lt $jpgHeader.Length; $i++) {
        $bytes[$i] = $jpgHeader[$i]
    }
    
    [System.IO.File]::WriteAllBytes($TEST_IMAGE, $bytes)
    Write-Success "Imagen de prueba creada: $TEST_IMAGE"
}

# ============================================================================
# TESTS DE UPLOAD
# ============================================================================

function Test-UploadValid {
    Write-Section "2. Test Upload Válido"
    
    $boundary = [System.Guid]::NewGuid().ToString()
    $filePath = (Get-Item $TEST_IMAGE).FullName
    
    # Construir multipart/form-data manualmente
    $bodyLines = @(
        "--$boundary",
        "Content-Disposition: form-data; name=`"file`"; filename=`"test-factura.jpg`"",
        "Content-Type: image/jpeg",
        "",
        [System.IO.File]::ReadAllText($filePath, [System.Text.Encoding]::GetEncoding("ISO-8859-1")),
        "--$boundary",
        "Content-Disposition: form-data; name=`"providerId`"",
        "",
        $script:PROVIDER_ID,
        "--$boundary",
        "Content-Disposition: form-data; name=`"sourceType`"",
        "",
        "invoice",
        "--$boundary--"
    )
    
    $body = $bodyLines -join "`r`n"
    
    try {
        $response = Invoke-RestMethod -Uri "$BASE_URL/purchaseDoc/upload" `
            -Method Post `
            -Headers @{
                Authorization = "Bearer $script:TOKEN"
                "Content-Type" = "multipart/form-data; boundary=$boundary"
            } `
            -Body ([System.Text.Encoding]::GetEncoding("ISO-8859-1").GetBytes($body)) `
            -ErrorAction Stop
        
        if ($response.success) {
            $script:DRAFT_ID = $response.data.draftId
            Write-Success "Upload exitoso"
            Write-Info "DraftId: $script:DRAFT_ID"
            Write-Info "Status: $($response.data.status)"
            Write-Info "File: $($response.data.file.filename)"
            Write-Info "Size: $([math]::Round($response.data.file.size / 1024, 2)) KB"
            return $true
        } else {
            Write-Error "Upload falló: $($response.error)"
            return $false
        }
    } catch {
        Write-Error "Error en upload: $_"
        return $false
    }
}

function Test-UploadNoFile {
    Write-Section "3. Test Upload Sin Archivo"
    
    try {
        $response = Invoke-RestMethod -Uri "$BASE_URL/purchaseDoc/upload" `
            -Method Post `
            -Headers @{ Authorization = "Bearer $script:TOKEN" } `
            -Body (@{ sourceType = "invoice" } | ConvertTo-Json) `
            -ContentType "application/json" `
            -ErrorAction Stop
        
        Write-Error "Debería haber fallado pero retornó: $($response | ConvertTo-Json)"
        return $false
    } catch {
        if ($_.Exception.Response.StatusCode -eq 400) {
            Write-Success "Validación correcta: 400 Bad Request"
            return $true
        } else {
            Write-Error "Error inesperado: $_"
            return $false
        }
    }
}

function Test-UploadInvalidSourceType {
    Write-Section "4. Test Upload SourceType Inválido"
    
    $boundary = [System.Guid]::NewGuid().ToString()
    $body = "--$boundary`r`n" +
            "Content-Disposition: form-data; name=`"sourceType`"`r`n`r`n" +
            "invalid_type`r`n" +
            "--$boundary--"
    
    try {
        $response = Invoke-RestMethod -Uri "$BASE_URL/purchaseDoc/upload" `
            -Method Post `
            -Headers @{
                Authorization = "Bearer $script:TOKEN"
                "Content-Type" = "multipart/form-data; boundary=$boundary"
            } `
            -Body $body `
            -ErrorAction Stop
        
        Write-Error "Debería haber fallado"
        return $false
    } catch {
        if ($_.Exception.Response.StatusCode -eq 400) {
            Write-Success "Validación correcta: sourceType inválido rechazado"
            return $true
        } else {
            Write-Error "Error inesperado: $_"
            return $false
        }
    }
}

# ============================================================================
# TESTS DE CONSULTA
# ============================================================================

function Test-GetDraftStatus {
    Write-Section "5. Test Consultar Estado de Draft"
    
    if ([string]::IsNullOrEmpty($script:DRAFT_ID)) {
        Write-Error "No hay DRAFT_ID disponible"
        return $false
    }
    
    Write-Info "Esperando análisis (máximo 30 segundos)..."
    $maxWait = 30
    $waited = 0
    $status = "PROCESSING"
    
    while ($waited -lt $maxWait -and $status -eq "PROCESSING") {
        try {
            $response = Invoke-RestMethod -Uri "$BASE_URL/purchaseDoc/$script:DRAFT_ID" `
                -Method Get `
                -Headers @{ Authorization = "Bearer $script:TOKEN" } `
                -ErrorAction Stop
            
            $status = $response.data.status
            
            if ($status -eq "READY") {
                Write-Success "Análisis completado: READY"
                Write-Info "Items procesados: $($response.data.analysis.meta.itemsProcessed)"
                Write-Info "Items con match: $($response.data.analysis.meta.itemsWithMatch)"
                Write-Info "Duplicate status: $($response.data.possibleDuplicate.status)"
                return $true
            } elseif ($status -eq "FAILED") {
                Write-Error "Análisis falló: $($response.data.error.message)"
                return $false
            } else {
                Write-Info "Status: $status (esperando...)"
                Start-Sleep -Seconds 2
                $waited += 2
            }
        } catch {
            Write-Error "Error consultando draft: $_"
            return $false
        }
    }
    
    if ($status -eq "PROCESSING") {
        Write-Error "Timeout esperando análisis (${waited}s)"
        return $false
    }
    
    return $false
}

function Test-ListDrafts {
    Write-Section "6. Test Listar Drafts"
    
    try {
        $response = Invoke-RestMethod -Uri "$BASE_URL/purchaseDoc?limit=10" `
            -Method Get `
            -Headers @{ Authorization = "Bearer $script:TOKEN" } `
            -ErrorAction Stop
        
        Write-Success "Listado exitoso"
        Write-Info "Total drafts: $($response.data.total)"
        Write-Info "Resultados: $($response.data.drafts.Count)"
        return $true
    } catch {
        Write-Error "Error listando drafts: $_"
        return $false
    }
}

# ============================================================================
# TESTS DE CONFIRMACIÓN
# ============================================================================

function Test-ConfirmWithoutItems {
    Write-Section "7. Test Confirmar Sin Items (usa análisis)"
    
    if ([string]::IsNullOrEmpty($script:DRAFT_ID)) {
        Write-Error "No hay DRAFT_ID disponible"
        return $false
    }
    
    $body = @{
        items = @()
    } | ConvertTo-Json
    
    try {
        $response = Invoke-RestMethod -Uri "$BASE_URL/purchaseDoc/$script:DRAFT_ID/confirm" `
            -Method Post `
            -Headers @{ Authorization = "Bearer $script:TOKEN" } `
            -Body $body `
            -ContentType "application/json" `
            -ErrorAction Stop
        
        if ($response.success) {
            Write-Success "Confirmación exitosa"
            Write-Info "BuyId: $($response.data.buyId)"
            Write-Info "Status: $($response.data.status)"
            return $true
        } else {
            Write-Error "Confirmación falló: $($response.error)"
            return $false
        }
    } catch {
        Write-Error "Error en confirmación: $_"
        return $false
    }
}

function Test-ConfirmNotReady {
    Write-Section "8. Test Confirmar Draft No READY"
    
    # Crear draft nuevo que estará en PROCESSING
    Write-Info "Creando draft nuevo..."
    Create-TestImage
    Test-UploadValid | Out-Null
    
    $newDraftId = $script:DRAFT_ID
    
    $body = @{
        items = @()
    } | ConvertTo-Json
    
    try {
        $response = Invoke-RestMethod -Uri "$BASE_URL/purchaseDoc/$newDraftId/confirm" `
            -Method Post `
            -Headers @{ Authorization = "Bearer $script:TOKEN" } `
            -Body $body `
            -ContentType "application/json" `
            -ErrorAction Stop
        
        Write-Error "Debería haber fallado"
        return $false
    } catch {
        if ($_.Exception.Response.StatusCode -eq 400) {
            Write-Success "Validación correcta: Draft PROCESSING no puede confirmarse"
            return $true
        } else {
            Write-Error "Error inesperado: $_"
            return $false
        }
    }
}

# ============================================================================
# EJECUCIÓN PRINCIPAL
# ============================================================================

Write-Host "Iniciando suite de pruebas Purchase Docs..." -ForegroundColor Cyan
Write-Host "Presiona Ctrl+C para cancelar`n" -ForegroundColor Gray

# Verificar servicios
if (-not (Test-ServiceHealth $BASE_URL "gzapi")) { exit 1 }
if (-not (Test-ServiceHealth $AI_URL "Document AI")) { 
    Write-Info "Document AI no disponible, algunos tests fallarán"
}

# Crear imagen de prueba
Create-TestImage

# Tests
$results = @{
    passed = 0
    failed = 0
    total = 0
}

$tests = @(
    { Get-Token },
    { Get-ProviderId },
    { Test-UploadValid },
    { Test-UploadNoFile },
    { Test-UploadInvalidSourceType },
    { Test-GetDraftStatus },
    { Test-ListDrafts },
    { Test-ConfirmWithoutItems },
    { Test-ConfirmNotReady }
)

foreach ($test in $tests) {
    $results.total++
    if (& $test) {
        $results.passed++
    } else {
        $results.failed++
    }
}

# Limpieza
if (Test-Path $TEST_IMAGE) {
    Remove-Item $TEST_IMAGE -Force
    Write-Info "Imagen de prueba eliminada"
}

# Resumen
Write-Section "Resumen de Pruebas"
Write-Host "Total:   $($results.total)" -ForegroundColor White
Write-Host "Passed:  $($results.passed)" -ForegroundColor Green
Write-Host "Failed:  $($results.failed)" -ForegroundColor Red
Write-Host ""

if ($results.failed -eq 0) {
    Write-Host "✓ TODAS LAS PRUEBAS PASARON" -ForegroundColor Green
    exit 0
} else {
    Write-Host "✗ HAY PRUEBAS FALLIDAS" -ForegroundColor Red
    exit 1
}
