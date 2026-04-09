<#
.SYNOPSIS
  Configuración compartida para todos los scripts de infraestructura.
.DESCRIPTION
  Define constantes del proyecto y una función que resuelve nombres de recursos
  a partir del SimId. Todos los scripts hacen dot-source de este archivo.
#>

# ── Constantes del proyecto ──
$Script:GcpProject = 'wa-api-simulator'
$Script:GcpZone    = 'us-central1-a'
$Script:GcpRegion  = 'us-central1'
$Script:SshUser    = 'ccisnedev'
$Script:Domain     = 'cacsi.dev'
$Script:Machine    = 'e2-small'
$Script:DiskSize   = '10GB'
$Script:Image      = 'projects/debian-cloud/global/images/family/debian-12'
$Script:RemoteDir  = '/opt/wa-api'
$Script:GcsBucket  = 'gs://wa-sim-cacsi-backups'

<#
.SYNOPSIS
  Resuelve nombres de recursos a partir del SimId.
.PARAMETER SimId
  Identificador numérico del simulador (1, 2, 3...).
.OUTPUTS
  Hashtable con VmName, IpName, Subdomain, EnvFile.
#>
function Resolve-SimulatorNames {
  param(
    [Parameter(Mandatory)]
    [ValidateRange(1, 99)]
    [int]$SimId
  )

  @{
    VmName    = "wa-sim-cacsi-$SimId"
    IpName    = "wa-sim-cacsi-$SimId-ip"
    Subdomain = "wa-api-s$SimId.$Script:Domain"
    EnvFile   = ".env.production.s$SimId"
  }
}
