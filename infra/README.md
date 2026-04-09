# wa_api — Infraestructura de despliegue

> Despliegue de wa_api en Google Cloud Compute Engine.

## Prerequisitos

- [Google Cloud CLI](https://cloud.google.com/sdk/docs/install) (`gcloud`) instalado y autenticado
- Proyecto GCP: `wa-api-simulator`
- DNS: acceso para crear A records en `cacsi.dev`
- `.env.production` configurado en `wa_api/` (ver `.env.production.example`)

## Estructura

```
infra/
├── Dockerfile                    # Build multi-stage Node 20 Alpine
├── docker-compose.prod.yml       # wa-api + Caddy (reverse proxy + TLS)
├── .env.production.example       # Template de variables de entorno
├── caddy/
│   └── Caddyfile                 # Bloquea /dashboard, proxy al API
├── scripts/
│   ├── 01-create-vm.ps1          # Crea VM + IP + firewall
│   ├── 02-setup-vm.ps1           # Instala Docker en la VM
│   ├── 03-deploy.ps1             # Build + deploy containers
│   ├── 04-ssh-tunnel.ps1         # Tunnel para acceder al dashboard
│   └── 05-backup.ps1             # Backup credenciales → GCS
└── README.md
```

## Quickstart

### 1. Configurar .env.production

```powershell
cd wa_api
cp infra/.env.production.example .env.production
# Editar con valores reales (ACCESS_TOKEN, CALLBACK_URL, etc.)
```

### 2. Crear VM

```powershell
cd wa_api/infra/scripts
.\01-create-vm.ps1
```

Output: IP estática. Crear A record `wa-api-s1.cacsi.dev` → IP.

### 3. Setup VM

```powershell
.\02-setup-vm.ps1
```

Instala Docker y prepara directorios en `/opt/wa-api/`.

### 4. Deploy

```powershell
.\03-deploy.ps1
```

Copia código, build del container, levanta wa-api + Caddy.

### 5. Vincular número (QR scan)

```powershell
.\04-ssh-tunnel.ps1
```

1. Se abre un tunnel SSH que trae el puerto 3001 de la VM a tu PC
2. Abrir `http://localhost:3001/dashboard` en el browser
3. Escanear el QR con WhatsApp (Dispositivos vinculados → Vincular)
4. Esperar a que muestre "Connected"
5. Cerrar tunnel con Ctrl+C — wa_api sigue corriendo

### 6. Verificar

```powershell
# Health (público)
curl https://wa-api-s1.cacsi.dev/health

# Dashboard (debe dar 403)
curl https://wa-api-s1.cacsi.dev/dashboard

# API sin token (debe dar 401)
curl https://wa-api-s1.cacsi.dev/sim_pnid_001/messages

# API con token
curl -X POST https://wa-api-s1.cacsi.dev/sim_pnid_001/messages `
  -H "Authorization: Bearer <ACCESS_TOKEN>" `
  -H "Content-Type: application/json" `
  -d '{"messaging_product":"whatsapp","to":"51XXXXXXXXX","type":"text","text":{"body":"Hola"}}'
```

## Operaciones

### Redeploy (después de cambios)

```powershell
.\03-deploy.ps1
```

### Backup de credenciales

```powershell
.\05-backup.ps1
```

Sube `auth_info_baileys/` + `state.json` a `gs://wa-sim-cacsi-backups/`.

### Ver logs

```powershell
gcloud compute ssh ccisnedev@wa-sim-cacsi-1 `
  --project wa-api-simulator `
  --zone us-central1-a `
  --command "docker logs wa-api --tail 100 -f"
```

### Restart

```powershell
gcloud compute ssh ccisnedev@wa-sim-cacsi-1 `
  --project wa-api-simulator `
  --zone us-central1-a `
  --command "cd /opt/wa-api && docker compose -f infra/docker-compose.prod.yml restart"
```

## Seguridad

| Capa | Protege | Mecanismo |
|------|---------|-----------|
| Firewall GCP | Solo puertos 80, 443, 22 | Tags `http-server`, `https-server` |
| Caddy | `/dashboard`, `/api/session/*` → 403 | Caddyfile |
| Bearer token | API de mensajes/templates/media | Middleware `auth-token.ts` |
| SSH tunnel | Dashboard solo accesible vía tunnel | `gcloud compute ssh -L` |

## CALLBACK_URL (webhook)

wa_api envía webhooks de mensajes entrantes al `CALLBACK_URL` configurado.

| Entorno | CALLBACK_URL |
|---------|-------------|
| Dev (help_api en tu PC) | `https://{id}.devtunnels.ms/api/v1/ingress/webhook` |
| Producción | `https://help-api.cacsi.dev/api/v1/ingress/webhook` |

Para desarrollo con devtunnel:

```powershell
# Crear tunnel persistente (una sola vez)
devtunnel create wa-api-callback --allow-anonymous
devtunnel port create wa-api-callback -p 8080

# Antes de desarrollar
devtunnel host wa-api-callback
```

## Costos

| Recurso | Costo/mes |
|---------|:---------:|
| VM e2-small | ~$12.23 |
| Disco 10 GB | ~$1.00 |
| IP estática | $0.00 |
| GCS backups | ~$0.02 |
| **Total** | **~$13.25** |
