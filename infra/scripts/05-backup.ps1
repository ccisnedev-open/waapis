<#
.SYNOPSIS
  Backup de auth_info_baileys y state.json a GCS.
.PARAMETER SimId
  Identificador numérico del simulador (1, 2, 3...).
.EXAMPLE
  .\05-backup.ps1 -SimId 1
#>

param(
  [Parameter(Mandatory)]
  [int]$SimId
)

$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\config.ps1"

$names     = Resolve-SimulatorNames -SimId $SimId
$Timestamp = Get-Date -Format 'yyyy-MM-dd_HHmmss'

Write-Host "=== 05-backup.ps1 (SimId=$SimId) ===" -ForegroundColor Cyan

# ── 1. Crear bucket si no existe ──
Write-Host '[1/3] Verificando bucket...' -ForegroundColor Yellow
$bucketExists = gsutil ls $GcsBucket 2>$null
if (-not $bucketExists) {
  gsutil mb -p $GcpProject -l $GcpRegion $GcsBucket
  Write-Host "  Bucket creado: $GcsBucket" -ForegroundColor Green
} else {
  Write-Host "  Bucket existe: $GcsBucket" -ForegroundColor Green
}

# ── 2. Comprimir en la VM ──
Write-Host '[2/3] Comprimiendo credenciales en la VM...' -ForegroundColor Yellow
$BackupFile = "wa-api-s${SimId}-backup-${Timestamp}.tar.gz"

gcloud compute ssh "${SshUser}@$($names.VmName)" `
  --project $GcpProject `
  --zone $GcpZone `
  --command "cd $RemoteDir && tar -czf /tmp/$BackupFile auth_info_baileys/ state.json 2>/dev/null || tar -czf /tmp/$BackupFile auth_info_baileys/"

Write-Host "  Comprimido: $BackupFile" -ForegroundColor Green

# ── 3. Copiar a GCS ──
Write-Host '[3/3] Subiendo a GCS...' -ForegroundColor Yellow
gcloud compute ssh "${SshUser}@$($names.VmName)" `
  --project $GcpProject `
  --zone $GcpZone `
  --command "gsutil cp /tmp/$BackupFile $GcsBucket/$BackupFile && rm /tmp/$BackupFile"

Write-Host "  Backup: ${GcsBucket}/${BackupFile}" -ForegroundColor Green
Write-Host ''
Write-Host '  Para restaurar:' -ForegroundColor Cyan
Write-Host "  gsutil cp ${GcsBucket}/${BackupFile} . && tar -xzf $BackupFile"
