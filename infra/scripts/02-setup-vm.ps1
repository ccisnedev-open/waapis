<#
.SYNOPSIS
  Instala Docker y configura la VM para un simulador wa_api.
.PARAMETER SimId
  Identificador numérico del simulador (1, 2, 3...).
.EXAMPLE
  .\02-setup-vm.ps1 -SimId 1
#>

param(
  [Parameter(Mandatory)]
  [int]$SimId
)

$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\config.ps1"

$names = Resolve-SimulatorNames -SimId $SimId

Write-Host "=== 02-setup-vm.ps1 (SimId=$SimId) ===" -ForegroundColor Cyan

function Invoke-VmSsh {
  param([string]$Command)
  gcloud compute ssh "${SshUser}@$($names.VmName)" `
    --project $GcpProject `
    --zone $GcpZone `
    --command $Command
}

# ── 1. Instalar Docker ──
Write-Host '[1/3] Instalando Docker...' -ForegroundColor Yellow
Invoke-VmSsh @'
sudo apt-get update -qq && \
sudo apt-get install -y -qq ca-certificates curl gnupg && \
sudo install -m 0755 -d /etc/apt/keyrings && \
curl -fsSL https://download.docker.com/linux/debian/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg && \
sudo chmod a+r /etc/apt/keyrings/docker.gpg && \
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian $(. /etc/os-release && echo $VERSION_CODENAME) stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null && \
sudo apt-get update -qq && \
sudo apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin && \
sudo usermod -aG docker $USER
'@

Write-Host '  Docker instalado' -ForegroundColor Green

# ── 2. Crear directorios de trabajo ──
Write-Host '[2/3] Creando directorios...' -ForegroundColor Yellow
Invoke-VmSsh @'
sudo mkdir -p /opt/wa-api && \
sudo chown $USER:$USER /opt/wa-api && \
mkdir -p /opt/wa-api/auth_info_baileys && \
mkdir -p /opt/wa-api/media
'@

Write-Host '  /opt/wa-api/ preparado' -ForegroundColor Green

# ── 3. Verificar ──
Write-Host '[3/3] Verificando instalación...' -ForegroundColor Yellow
Invoke-VmSsh 'docker --version && docker compose version'

Write-Host ''
Write-Host '  SIGUIENTE PASO:' -ForegroundColor Cyan
Write-Host "  1. Ejecutar: .\03-deploy.ps1 -SimId $SimId"
