<#
.SYNOPSIS
  Abre SSH tunnel para acceder al dashboard de un simulador wa_api.
.DESCRIPTION
  Expone el puerto 3001 de la VM como localhost:3001.
  Abrir http://localhost:3001/dashboard en el browser para vincular número.
  Cerrar con Ctrl+C cuando termines.
.PARAMETER SimId
  Identificador numérico del simulador (1, 2, 3...).
.EXAMPLE
  .\04-ssh-tunnel.ps1 -SimId 1
#>

param(
  [Parameter(Mandatory)]
  [int]$SimId
)

. "$PSScriptRoot\config.ps1"

$names = Resolve-SimulatorNames -SimId $SimId

Write-Host "=== 04-ssh-tunnel.ps1 (SimId=$SimId) ===" -ForegroundColor Cyan
Write-Host ''
Write-Host "Abriendo tunnel SSH a $($names.VmName)..." -ForegroundColor Yellow
Write-Host '  Dashboard: http://localhost:3001/dashboard' -ForegroundColor Green
Write-Host '  Health:    http://localhost:3001/health' -ForegroundColor Green
Write-Host ''
Write-Host 'Presiona Ctrl+C para cerrar el tunnel.' -ForegroundColor DarkGray
Write-Host ''

gcloud compute ssh "${SshUser}@$($names.VmName)" `
  --project $GcpProject `
  --zone $GcpZone `
  -- -L 3001:localhost:3001 -N
