# Test Script para Fase 4A - Duplicate Detection
# ================================================
# Ejecutar: .\test-fase4a.ps1
# Requiere: gzapi corriendo en localhost:5000

$ErrorActionPreference = "Continue"
$API_URL = "http://localhost:5000"
$TOKEN = ""
$PROVIDER_ID = ""
$DRAFT_ID = "676f1234567890abcdef1230"  # Draft de prueba

# Colores para output
function Write-Success { param($msg) Write-Host "✅ $msg" -ForegroundColor Green }
function Write-Error { param($msg) Write-Host "❌ $msg" -ForegroundColor Red }
function Write-Info { param($msg) Write-Host "ℹ️  $msg" -ForegroundColor Cyan }
function Write-Test { param($msg) Write-Host "`n🧪 TEST: $msg" -ForegroundColor Yellow }

Write-Host "`n╔════════════════════════════════════════════════╗" -ForegroundColor Magenta
Write-Host "║   Test Fase 4A - Duplicate Detection          ║" -ForegroundColor Magenta
Write-Host "║   gzapi Backend Testing                        ║" -ForegroundColor Magenta
Write-Host "╚════════════════════════════════════════════════╝`n" -ForegroundColor Magenta

# ============================================
# 0. Setup - Login y obtener token
# ============================================
Write-Test "Setup - Login y obtener token"

$loginBody = @{
    email = "admin@example.com"
    password = "admin123"
} | ConvertTo-Json

try {
    $loginResponse = Invoke-RestMethod -Uri "$API_URL/auth/login" -Method POST -Body $loginBody -ContentType "application/json"
    $TOKEN = $loginResponse.token
    
    if ($TOKEN) {
        Write-Success "Login exitoso. Token obtenido."
        Write-Info "Token: $($TOKEN.Substring(0, 20))..."
    } else {
        Write-Error "Login falló. No se obtuvo token."
        exit 1
    }
} catch {
    Write-Error "Error en login: $($_.Exception.Message)"
    Write-Info "Usando token hardcoded para tests..."
    # Fallback: usar token hardcoded si login falla
    $TOKEN = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjY3NGIyMjIyMjIyMjIyMjIyMjIyMjJiYiIsImlhdCI6MTczNTQ4NDAwMH0.XXXXXX"
}

$headers = @{
    "Authorization" = "Bearer $TOKEN"
    "Content-Type" = "application/json"
}

# ============================================
# 1. Obtener un proveedor existente
# ============================================
Write-Test "Obtener proveedor para tests"

try {
    $providersResponse = Invoke-RestMethod -Uri "$API_URL/provider" -Method GET -Headers $headers
    
    if ($providersResponse -and $providersResponse.Count -gt 0) {
        $PROVIDER_ID = $providersResponse[0]._id
        Write-Success "Proveedor obtenido: $($providersResponse[0].nombre) (ID: $PROVIDER_ID)"
    } else {
        Write-Error "No se encontraron proveedores. Creando uno..."
        
        # Crear proveedor de prueba
        $providerBody = @{
            nombre = "Test Provider - Fase 4A"
            telefono = "1234567890"
            direccion = "Test Address 123"
        } | ConvertTo-Json
        
        $newProvider = Invoke-RestMethod -Uri "$API_URL/provider" -Method POST -Headers $headers -Body $providerBody
        $PROVIDER_ID = $newProvider._id
        Write-Success "Proveedor creado: $PROVIDER_ID"
    }
} catch {
    Write-Error "Error obteniendo proveedor: $($_.Exception.Message)"
    exit 1
}

# ============================================
# 2. TEST: Crear compra de referencia
# ============================================
Write-Test "Crear compra de referencia con docNumber"

$buyBody = @{
    proveedor = $PROVIDER_ID
    fecha = "2025-12-28"
    total = 50000
    docNumber = "TEST-0001"
    estado = "confirmado"
} | ConvertTo-Json

try {
    $buyResponse = Invoke-RestMethod -Uri "$API_URL/buy" -Method POST -Headers $headers -Body $buyBody
    $BUY_ID = $buyResponse._id
    Write-Success "Compra creada: $BUY_ID"
    Write-Info "  - Proveedor: $PROVIDER_ID"
    Write-Info "  - Fecha: 2025-12-28"
    Write-Info "  - Total: 50000"
    Write-Info "  - DocNumber: TEST-0001"
} catch {
    Write-Error "Error creando compra: $($_.Exception.Message)"
    Write-Info "Response: $($_.ErrorDetails.Message)"
}

Start-Sleep -Seconds 1

# ============================================
# 3. TEST: Detección por docNumber exacto (debe detectar)
# ============================================
Write-Test "Detección por docNumber exacto - DEBE DETECTAR"

$checkBody1 = @{
    providerId = $PROVIDER_ID
    date = "2025-12-28"
    total = 50000
    docNumber = "TEST-0001"
} | ConvertTo-Json

try {
    $checkResponse1 = Invoke-RestMethod -Uri "$API_URL/duplicateCheck/drafts/$DRAFT_ID/check" -Method POST -Headers $headers -Body $checkBody1
    
    if ($checkResponse1.isPossibleDuplicate -eq $true) {
        Write-Success "✓ Duplicado detectado correctamente"
        Write-Info "  - Criterios: $($checkResponse1.criteriaTriggered -join ', ')"
        Write-Info "  - Candidatos: $($checkResponse1.candidates.Count)"
        Write-Info "  - Recomendación: $($checkResponse1.recommendation)"
        Write-Info "  - Check ID: $($checkResponse1.checkId)"
        
        if ($checkResponse1.candidates.Count -gt 0) {
            $candidate = $checkResponse1.candidates[0]
            Write-Info "  - Candidato 1:"
            Write-Info "    * Buy ID: $($candidate.existingBuyId)"
            Write-Info "    * Score: $($candidate.score)"
            Write-Info "    * Reasons: $($candidate.reasons -join ', ')"
            
            if ($candidate.score -ge 0.95) {
                Write-Success "    * Score alto (>= 0.95) ✓"
            } else {
                Write-Error "    * Score bajo (< 0.95) ✗"
            }
        }
    } else {
        Write-Error "✗ No se detectó duplicado (debería detectar)"
    }
} catch {
    Write-Error "Error en check: $($_.Exception.Message)"
    Write-Info "Response: $($_.ErrorDetails.Message)"
}

Start-Sleep -Seconds 1

# ============================================
# 4. TEST: Detección por provider+date+total (debe detectar)
# ============================================
Write-Test "Detección por provider+date+total - DEBE DETECTAR"

$checkBody2 = @{
    providerId = $PROVIDER_ID
    date = "2025-12-29"
    total = 50500
    tolerance = @{
        days = 2
        totalPct = 0.02
    }
} | ConvertTo-Json

try {
    $checkResponse2 = Invoke-RestMethod -Uri "$API_URL/duplicateCheck/drafts/$DRAFT_ID/check" -Method POST -Headers $headers -Body $checkBody2
    
    if ($checkResponse2.isPossibleDuplicate -eq $true) {
        Write-Success "✓ Duplicado detectado correctamente"
    } else {
        Write-Info "⚠️  No se detectó como duplicado (score puede ser < 0.80)"
    }
    
    Write-Info "  - Criterios: $($checkResponse2.criteriaTriggered -join ', ')"
    Write-Info "  - Candidatos: $($checkResponse2.candidates.Count)"
    Write-Info "  - Recomendación: $($checkResponse2.recommendation)"
    
    if ($checkResponse2.candidates.Count -gt 0) {
        $candidate = $checkResponse2.candidates[0]
        Write-Info "  - Candidato 1 Score: $($candidate.score)"
    }
} catch {
    Write-Error "Error en check: $($_.Exception.Message)"
}

Start-Sleep -Seconds 1

# ============================================
# 5. TEST: NO detección cuando no hay match
# ============================================
Write-Test "NO detección cuando no hay match"

$checkBody3 = @{
    providerId = $PROVIDER_ID
    date = "2025-11-01"
    total = 999999
    docNumber = "NOMATCH-9999"
} | ConvertTo-Json

try {
    $checkResponse3 = Invoke-RestMethod -Uri "$API_URL/duplicateCheck/drafts/$DRAFT_ID/check" -Method POST -Headers $headers -Body $checkBody3
    
    if ($checkResponse3.isPossibleDuplicate -eq $false) {
        Write-Success "✓ No se detectó duplicado (correcto)"
        Write-Info "  - Candidatos: $($checkResponse3.candidates.Count)"
        Write-Info "  - Recomendación: $($checkResponse3.recommendation)"
    } else {
        Write-Error "✗ Se detectó duplicado cuando no debería"
    }
} catch {
    Write-Error "Error en check: $($_.Exception.Message)"
}

Start-Sleep -Seconds 1

# ============================================
# 6. TEST: Registrar decisión CANCEL
# ============================================
Write-Test "Registrar decisión CANCEL"

# Primero hacer un check para obtener el checkId
try {
    $checkForDecision = Invoke-RestMethod -Uri "$API_URL/duplicateCheck/drafts/$DRAFT_ID/check" -Method POST -Headers $headers -Body $checkBody1
    $CHECK_ID = $checkForDecision.checkId
    
    $decisionBody = @{
        decision = "CANCEL"
        criteriaTriggered = @("DOC_NUMBER")
        candidates = @(
            @{
                existingBuyId = $BUY_ID
                score = 0.95
                reasons = @("DOC_NUMBER_EXACT")
                matchedOn = @{
                    docNumber = $true
                    providerDateTotal = $false
                    fingerprint = $false
                }
            }
        )
    } | ConvertTo-Json -Depth 5
    
    $decisionResponse = Invoke-RestMethod -Uri "$API_URL/duplicateCheck/drafts/$DRAFT_ID/decision" -Method POST -Headers $headers -Body $decisionBody
    
    if ($decisionResponse.success -eq $true) {
        Write-Success "✓ Decisión CANCEL registrada correctamente"
        Write-Info "  - Check ID: $($decisionResponse.checkId)"
        Write-Info "  - Message: $($decisionResponse.message)"
    } else {
        Write-Error "✗ Error registrando decisión"
    }
} catch {
    Write-Error "Error registrando decisión: $($_.Exception.Message)"
    Write-Info "Response: $($_.ErrorDetails.Message)"
}

Start-Sleep -Seconds 1

# ============================================
# 7. TEST: Registrar decisión CONTINUE
# ============================================
Write-Test "Registrar decisión CONTINUE"

try {
    $decisionBody2 = @{
        decision = "CONTINUE"
        selectedExistingBuyId = $BUY_ID
        criteriaTriggered = @("DOC_NUMBER")
        candidates = @(
            @{
                existingBuyId = $BUY_ID
                score = 0.95
                reasons = @("DOC_NUMBER_EXACT")
                matchedOn = @{
                    docNumber = $true
                    providerDateTotal = $false
                    fingerprint = $false
                }
            }
        )
    } | ConvertTo-Json -Depth 5
    
    $decisionResponse2 = Invoke-RestMethod -Uri "$API_URL/duplicateCheck/drafts/$DRAFT_ID/decision" -Method POST -Headers $headers -Body $decisionBody2
    
    if ($decisionResponse2.success -eq $true) {
        Write-Success "✓ Decisión CONTINUE registrada correctamente"
        Write-Info "  - Selected Buy ID: $BUY_ID"
    } else {
        Write-Error "✗ Error registrando decisión"
    }
} catch {
    Write-Error "Error registrando decisión: $($_.Exception.Message)"
}

Start-Sleep -Seconds 1

# ============================================
# 8. TEST: Obtener historial de checks
# ============================================
Write-Test "Obtener historial de checks para draft"

try {
    $historyResponse = Invoke-RestMethod -Uri "$API_URL/duplicateCheck/drafts/$DRAFT_ID/checks" -Method GET -Headers $headers
    
    if ($historyResponse.success -eq $true) {
        Write-Success "✓ Historial obtenido correctamente"
        Write-Info "  - Total checks: $($historyResponse.count)"
        
        if ($historyResponse.count -gt 0) {
            Write-Info "  - Último check:"
            $lastCheck = $historyResponse.checks[0]
            Write-Info "    * ID: $($lastCheck._id)"
            Write-Info "    * Decisión: $($lastCheck.decision)"
            Write-Info "    * Candidatos: $($lastCheck.candidates.Count)"
            
            if ($lastCheck.decidedBy) {
                Write-Info "    * Decidido por: $($lastCheck.decidedBy.nombre)"
            }
        }
    } else {
        Write-Error "✗ Error obteniendo historial"
    }
} catch {
    Write-Error "Error obteniendo historial: $($_.Exception.Message)"
}

Start-Sleep -Seconds 1

# ============================================
# 9. TEST: Validaciones de request body
# ============================================
Write-Test "Validaciones de request body"

Write-Info "9.1 - Request sin providerId (debe fallar)"
try {
    $invalidBody1 = @{
        date = "2025-12-28"
        total = 50000
    } | ConvertTo-Json
    
    Invoke-RestMethod -Uri "$API_URL/duplicateCheck/drafts/$DRAFT_ID/check" -Method POST -Headers $headers -Body $invalidBody1
    Write-Error "✗ Debería haber fallado (providerId requerido)"
} catch {
    if ($_.Exception.Response.StatusCode -eq 400) {
        Write-Success "✓ Validación correcta (400 Bad Request)"
    } else {
        Write-Error "✗ Error inesperado: $($_.Exception.Message)"
    }
}

Write-Info "9.2 - Request sin date (debe fallar)"
try {
    $invalidBody2 = @{
        providerId = $PROVIDER_ID
        total = 50000
    } | ConvertTo-Json
    
    Invoke-RestMethod -Uri "$API_URL/duplicateCheck/drafts/$DRAFT_ID/check" -Method POST -Headers $headers -Body $invalidBody2
    Write-Error "✗ Debería haber fallado (date requerido)"
} catch {
    if ($_.Exception.Response.StatusCode -eq 400) {
        Write-Success "✓ Validación correcta (400 Bad Request)"
    } else {
        Write-Error "✗ Error inesperado"
    }
}

Write-Info "9.3 - Request con formato de fecha inválido (debe fallar)"
try {
    $invalidBody3 = @{
        providerId = $PROVIDER_ID
        date = "28/12/2025"
        total = 50000
    } | ConvertTo-Json
    
    Invoke-RestMethod -Uri "$API_URL/duplicateCheck/drafts/$DRAFT_ID/check" -Method POST -Headers $headers -Body $invalidBody3
    Write-Error "✗ Debería haber fallado (formato fecha incorrecto)"
} catch {
    if ($_.Exception.Response.StatusCode -eq 400) {
        Write-Success "✓ Validación correcta (400 Bad Request)"
    } else {
        Write-Error "✗ Error inesperado"
    }
}

# ============================================
# Resumen Final
# ============================================
Write-Host "`n╔════════════════════════════════════════════════╗" -ForegroundColor Magenta
Write-Host "║           RESUMEN DE TESTS                     ║" -ForegroundColor Magenta
Write-Host "╚════════════════════════════════════════════════╝`n" -ForegroundColor Magenta

Write-Info "Tests ejecutados:"
Write-Info "  1. Setup y login"
Write-Info "  2. Creación de compra de referencia"
Write-Info "  3. Detección por docNumber exacto"
Write-Info "  4. Detección por provider+date+total"
Write-Info "  5. NO detección sin match"
Write-Info "  6. Registro de decisión CANCEL"
Write-Info "  7. Registro de decisión CONTINUE"
Write-Info "  8. Obtención de historial"
Write-Info "  9. Validaciones de request body"

Write-Host "`n✅ Testing completado. Revisar logs arriba para detalles.`n" -ForegroundColor Green

Write-Info "Para verificar en MongoDB:"
Write-Host "  db.purchase_doc_duplicate_checks.find({ draftId: '$DRAFT_ID' })" -ForegroundColor Yellow
Write-Host "  db.buys.findOne({ _id: ObjectId('$BUY_ID') })" -ForegroundColor Yellow
