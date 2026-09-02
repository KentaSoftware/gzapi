# Script de prueba para el middleware de logging
# Ejecutar después de iniciar el servidor con npm run dev

# 1. Login para obtener token
Write-Host "`n=== 1. LOGIN ===" -ForegroundColor Cyan
$loginResponse = Invoke-RestMethod -Uri "http://localhost:5000/auth/login" -Method Post -ContentType "application/json" -Body '{"nickname":"admin","password":"admin123"}'
$token = $loginResponse.tokenSession
Write-Host "✅ Token obtenido" -ForegroundColor Green

$headers = @{
    "Authorization" = "Bearer $token"
}

# 2. Probar GET /catalog/providers
Write-Host "`n=== 2. GET /catalog/providers ===" -ForegroundColor Cyan
Start-Sleep -Seconds 1
Invoke-RestMethod -Uri "http://localhost:5000/catalog/providers" -Method Get -Headers $headers | ConvertTo-Json -Depth 3

# 3. Probar GET /catalog/version con parámetros
Write-Host "`n=== 3. GET /catalog/version ===" -ForegroundColor Cyan
Start-Sleep -Seconds 1
Invoke-RestMethod -Uri "http://localhost:5000/catalog/version?providerId=63a746bb2592ff7d6101630d" -Method Get -Headers $headers | ConvertTo-Json -Depth 3

# 4. Probar GET /catalog/search con query
Write-Host "`n=== 4. GET /catalog/search (query) ===" -ForegroundColor Cyan
Start-Sleep -Seconds 1
Invoke-RestMethod -Uri "http://localhost:5000/catalog/search?q=chocolate&limit=5" -Method Get -Headers $headers | ConvertTo-Json -Depth 3

# 5. Probar GET /catalog/search con barcode
Write-Host "`n=== 5. GET /catalog/search (barcode) ===" -ForegroundColor Cyan
Start-Sleep -Seconds 1
Invoke-RestMethod -Uri "http://localhost:5000/catalog/search?barcode=7790742076724" -Method Get -Headers $headers | ConvertTo-Json -Depth 3

# 6. Probar error 400 (providerId inválido)
Write-Host "`n=== 6. Error 400 - ProviderId inválido ===" -ForegroundColor Cyan
Start-Sleep -Seconds 1
try {
    Invoke-RestMethod -Uri "http://localhost:5000/catalog/version?providerId=invalid-id" -Method Get -Headers $headers
} catch {
    Write-Host "⚠️ Error capturado (esperado):" -ForegroundColor Yellow
    $_.Exception.Message
}

Write-Host "`n=== Pruebas completadas ===" -ForegroundColor Green
Write-Host "Revisa la consola del servidor para ver los logs del middleware" -ForegroundColor Yellow
