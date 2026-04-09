<#
.SYNOPSIS
  Crea la VM, IP estática y firewall en GCP para un simulador wa_api.
.PARAMETER SimId
  Identificador numérico del simulador (1, 2, 3...).
.EXAMPLE
  .\01-create-vm.ps1 -SimId 1
#>

param(
  [Parameter(Mandatory)]
  [int]$SimId
)

$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\config.ps1"

$names = Resolve-SimulatorNames -SimId $SimId

Write-Host "=== 01-create-vm.ps1 (SimId=$SimId) ===" -ForegroundColor Cyan
Write-Host "Proyecto  : $GcpProject"
Write-Host "VM        : $($names.VmName)"
Write-Host "Subdominio: $($names.Subdomain)"
Write-Host ''

# ── 1. Reservar IP estática ──
Write-Host '[1/4] Reservando IP estática...' -ForegroundColor Yellow
gcloud compute addresses create $names.IpName `
  --project $GcpProject `
  --region $GcpRegion

$StaticIp = gcloud compute addresses describe $names.IpName `
  --project $GcpProject `
  --region $GcpRegion `
  --format 'value(address)'

Write-Host "  IP reservada: $StaticIp" -ForegroundColor Green

# ── 2. Crear VM ──
Write-Host '[2/4] Creando VM...' -ForegroundColor Yellow
gcloud compute instances create $names.VmName `
  --project $GcpProject `
  --zone $GcpZone `
  --machine-type $Machine `
  --image $Image `
  --boot-disk-size $DiskSize `
  --boot-disk-type pd-balanced `
  --address $StaticIp `
  --tags http-server,https-server `
  --metadata startup-script='#!/bin/bash
echo "VM ready"'

Write-Host "  VM creada: $($names.VmName)" -ForegroundColor Green

# ── 3. Firewall rules (compartidas, se crean solo si no existen) ──
Write-Host '[3/4] Configurando firewall...' -ForegroundColor Yellow

$existingHttp = gcloud compute firewall-rules list `
  --project $GcpProject `
  --filter "name=allow-http-wa-sim" `
  --format "value(name)" 2>$null

if (-not $existingHttp) {
  gcloud compute firewall-rules create allow-http-wa-sim `
    --project $GcpProject `
    --allow tcp:80 `
    --target-tags http-server `
    --description 'Allow HTTP for Caddy redirect'
}

$existingHttps = gcloud compute firewall-rules list `
  --project $GcpProject `
  --filter "name=allow-https-wa-sim" `
  --format "value(name)" 2>$null

if (-not $existingHttps) {
  gcloud compute firewall-rules create allow-https-wa-sim `
    --project $GcpProject `
    --allow tcp:443 `
    --target-tags https-server `
    --description 'Allow HTTPS for Caddy'
}

Write-Host '  Firewall configurado (80, 443)' -ForegroundColor Green

# ── 4. Resumen ──
Write-Host ''
Write-Host '[4/4] Resumen' -ForegroundColor Yellow
Write-Host "  VM        : $($names.VmName) ($GcpZone)" -ForegroundColor Green
Write-Host "  IP        : $StaticIp" -ForegroundColor Green
Write-Host "  Máquina   : $Machine" -ForegroundColor Green
Write-Host "  Disco     : $DiskSize" -ForegroundColor Green
Write-Host ''
Write-Host '  SIGUIENTE PASO:' -ForegroundColor Cyan
Write-Host "  1. Crear DNS A record: $($names.Subdomain) -> $StaticIp"
Write-Host "  2. Ejecutar: .\02-setup-vm.ps1 -SimId $SimId"
