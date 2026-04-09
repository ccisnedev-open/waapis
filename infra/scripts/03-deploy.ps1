<#
.SYNOPSIS
  Despliega (o actualiza) wa_api en una VM.
.DESCRIPTION
  Copia el código fuente, genera el Caddyfile para el subdominio correcto,
  hace build del container y levanta los servicios.
  Sirve tanto para el primer deploy como para actualizaciones.
.PARAMETER SimId
  Identificador numérico del simulador (1, 2, 3...).
.EXAMPLE
  .\03-deploy.ps1 -SimId 1
#>

param(
  [Parameter(Mandatory)]
  [int]$SimId
)

$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\config.ps1"

$names     = Resolve-SimulatorNames -SimId $SimId
$LocalRoot = Resolve-Path (Join-Path $PSScriptRoot '..' '..')  # wa_api/
$EnvPath   = Join-Path $LocalRoot $names.EnvFile

Write-Host "=== 03-deploy.ps1 (SimId=$SimId) ===" -ForegroundColor Cyan

# ── Verificar que existe el .env del simulador ──
if (-not (Test-Path $EnvPath)) {
  Write-Host "  ERROR: No existe $($names.EnvFile) en $LocalRoot" -ForegroundColor Red
  Write-Host "  Crea el archivo con las variables de entorno antes de deployar." -ForegroundColor Red
  exit 1
}

# ── 1. Generar Caddyfile con el subdominio correcto ──
Write-Host '[1/5] Generando Caddyfile...' -ForegroundColor Yellow
$CaddyfileContent = @"
$($names.Subdomain) {
	handle /dashboard* {
		respond 403
	}
	handle /api/session/* {
		respond 403
	}
	handle {
		reverse_proxy wa-api:3001
	}
}
"@

$CaddyfilePath = Join-Path $LocalRoot 'infra' 'caddy' 'Caddyfile'
Set-Content -Path $CaddyfilePath -Value $CaddyfileContent -Encoding utf8
Write-Host "  Caddyfile generado para $($names.Subdomain)" -ForegroundColor Green

# ── 2. Copiar archivos a la VM ──
Write-Host '[2/5] Copiando archivos a la VM...' -ForegroundColor Yellow

$TarFile = Join-Path $env:TEMP 'wa-api-deploy.tar.gz'
Push-Location $LocalRoot
tar -czf $TarFile `
  --exclude='node_modules' `
  --exclude='auth_info_baileys' `
  --exclude='media' `
  --exclude='dist' `
  --exclude='.env' `
  --exclude='.env.production.*' `
  --exclude='state.json' `
  .
Pop-Location

# Copiar tarball + env file
gcloud compute scp $TarFile `
  "${SshUser}@$($names.VmName):${RemoteDir}/deploy.tar.gz" `
  --project $GcpProject `
  --zone $GcpZone

gcloud compute scp $EnvPath `
  "${SshUser}@$($names.VmName):${RemoteDir}/.env.production" `
  --project $GcpProject `
  --zone $GcpZone

Remove-Item $TarFile -Force
Write-Host '  Archivos copiados' -ForegroundColor Green

# ── 3. Extraer en la VM ──
Write-Host '[3/5] Extrayendo...' -ForegroundColor Yellow
gcloud compute ssh "${SshUser}@$($names.VmName)" `
  --project $GcpProject `
  --zone $GcpZone `
  --command "cd $RemoteDir && tar -xzf deploy.tar.gz && rm deploy.tar.gz"

Write-Host "  Extraído en $RemoteDir" -ForegroundColor Green

# ── 4. Build y deploy ──
Write-Host '[4/5] Building y desplegando containers...' -ForegroundColor Yellow
gcloud compute ssh "${SshUser}@$($names.VmName)" `
  --project $GcpProject `
  --zone $GcpZone `
  --command "cd $RemoteDir && docker compose -f infra/docker-compose.prod.yml build && docker compose -f infra/docker-compose.prod.yml up -d"

Write-Host '  Containers levantados' -ForegroundColor Green

# ── 5. Health check ──
Write-Host '[5/5] Verificando health...' -ForegroundColor Yellow
gcloud compute ssh "${SshUser}@$($names.VmName)" `
  --project $GcpProject `
  --zone $GcpZone `
  --command 'sleep 5 && curl -s http://localhost:3001/health'

Write-Host ''
Write-Host '  SIGUIENTE PASO:' -ForegroundColor Cyan
Write-Host "  1. Ejecutar .\04-ssh-tunnel.ps1 -SimId $SimId para vincular número (QR scan)"
Write-Host "  2. Verificar HTTPS: curl https://$($names.Subdomain)/health"
