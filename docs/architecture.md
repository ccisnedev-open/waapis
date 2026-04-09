# wa_api — Arquitectura de despliegue

> Documento de referencia para el despliegue en producción de wa_api.  
> ADR relacionado: [0002-host-on-compute-engine](adr/0002-host-on-compute-engine.md)

## Qué es wa_api

wa_api es un **simulador completo e independiente** de la WhatsApp Cloud API de
Meta. No es un componente de H.E.L.P. — es un producto autónomo que cualquier
aplicación compatible con la Cloud API puede consumir sin modificaciones.

Funciona en ambas direcciones:

```
Outbound: App ──POST /{phoneId}/messages──► wa_api ──Baileys──► WhatsApp ──► usuario
Inbound:  Usuario ──► WhatsApp ──Baileys──► wa_api ──POST CALLBACK_URL──► App
```

El `CALLBACK_URL` es la dirección donde wa_api envía los webhooks de mensajes
entrantes — simula exactamente el comportamiento de Meta (payload idéntico,
firma HMAC-SHA256, reintentos). La app consumidora debe exponer un endpoint
HTTP accesible desde la VM donde corre wa_api.

**`CALLBACK_URL` es opcional**: si está ausente o vacío, los mensajes entrantes
se reciben pero no se reenvían — silencioso, sin error. Esto replica fielmente
a Meta, donde una app sin webhook registrado simplemente no recibe eventos.

---

## Diagrama de red

```
                        Internet
                           │
                    ┌──────┴──────┐
                    │  DNS A rec  │
                    │  cacsi.dev  │
                    └──────┬──────┘
                           │
              wa-api-s1.cacsi.dev
                           │
                    ┌──────┴──────┐
                    │  IP estática │
                    │  (reservada) │
                    └──────┬──────┘
                           │
               ┌───────────┴───────────┐
               │  GCE VM: e2-small     │
               │  us-central1-a        │
               │                       │
               │  ┌─────────────────┐  │
               │  │  Caddy :443     │──┼── HTTPS (público)
               │  │  reverse proxy  │  │
               │  └────────┬────────┘  │
               │           │           │
               │  ┌────────┴────────┐  │
               │  │  wa_api :3001   │  │
               │  │  (Docker)       │  │
               │  └────────┬────────┘  │
               │           │           │
               │  ┌────────┴────────┐  │
               │  │  auth_info/     │  │   SSH tunnel
               │  │  state.json     │──┼── :3001/dashboard (privado)
               │  │  media/         │  │
               │  │  (persistent    │  │
               │  │   disk)         │  │
               │  └─────────────────┘  │
               └───────────────────────┘
                           │
                    WebSocket saliente
                    (WhatsApp servers)
```

## Convención de nombres

| Recurso | Patrón | Ejemplo |
|---------|--------|---------|
| Proyecto GCP | `wa-api-simulator` | — |
| VM | `wa-sim-{org}-{N}` | `wa-sim-cacsi-1` |
| IP estática | `wa-sim-{org}-{N}-ip` | `wa-sim-cacsi-1-ip` |
| Subdominio | `wa-api-s{N}.cacsi.dev` | `wa-api-s1.cacsi.dev` |
| Firewall rule | `allow-{protocol}-wa-sim` | `allow-https-wa-sim` |
| GCS bucket (backups) | `wa-sim-{org}-backups` | `wa-sim-cacsi-backups` |

Cuando se necesite un segundo número (otra cooperativa u otro canal), se crea
`wa-sim-cacsi-2` con `wa-api-s2.cacsi.dev`. Mismo proyecto, misma
infraestructura, otro número de WhatsApp.

### Instancias planificadas

| SimId | VM | Subdominio | Número | Webhook |
|:-----:|----|-----------:|--------|:-------:|
| 1 | `wa-sim-cacsi-1` | `wa-api-s1.cacsi.dev` | 51933182642 | Sí (devtunnel → help_api) |
| 2 | `wa-sim-cacsi-2` | `wa-api-s2.cacsi.dev` | 51933152391 | No (solo outbound) |

## Stack por VM

| Componente | Versión | Puerto | Rol |
|------------|---------|--------|-----|
| Caddy | latest | 80, 443 | Reverse proxy + TLS automático |
| wa_api | Node 20 Alpine | 3001 (interno) | Simulador WhatsApp Cloud API |
| Docker | latest | — | Runtime de contenedores |

## Exposición de puertos

| Puerto | Protocolo | Acceso | Destino |
|--------|-----------|--------|---------|
| 443 | HTTPS | Público | Caddy → wa_api API |
| 80 | HTTP | Público | Caddy (redirect → 443) |
| 22 | SSH | IAP only | Administración |
| 3001 | HTTP | Interno only | wa_api (no expuesto) |

El dashboard (`/dashboard`, `/api/session/*`) queda accesible solo vía
SSH tunnel. Caddy bloquea estas rutas con `respond 403` — no llegan a wa_api
desde internet. El tunnel conecta directamente al puerto 3001 de la VM:

```
Tu PC (Windows)                         VM en Google Cloud
┌─────────────────┐    SSH tunnel       ┌──────────────────┐
│  Browser abre:  │◄═══════════════════►│  wa_api :3001    │
│  localhost:3001 │  reenvía directo    │  /dashboard      │
│  /dashboard     │  (sin pasar Caddy)  │  (web SPA)       │
└─────────────────┘                     └──────────────────┘
```

```powershell
gcloud compute ssh ccisnedev@wa-sim-cacsi-1 `
  --project wa-api-simulator `
  --zone us-central1-a `
  -- -L 3001:localhost:3001
```

Luego abrir `http://localhost:3001/dashboard` en el browser local.

### Vincular número (QR scan)

Se ejecuta al crear un nuevo simulador o si la sesión expira.

1. Abrir SSH tunnel (comando anterior)
2. Abrir `http://localhost:3001/dashboard` en el browser
3. En el teléfono: WhatsApp → Dispositivos vinculados → Vincular
4. Escanear el QR del dashboard
5. Esperar ~5s — dashboard muestra "Connected"
6. Verificar: `GET http://localhost:3001/health` → `{ status: connected }`
7. Cerrar tunnel (Ctrl+C) — wa_api sigue corriendo

No requiere re-scan en: reinicios de VM, deploys, crashes (auto-reconnect).
Sí requiere re-scan en: sesión expirada, ban, o uso de WhatsApp Web en otro browser.

## Persistencia

| Dato | Ubicación | Backup |
|------|-----------|--------|
| `auth_info_baileys/` | Disco persistente VM | Diario → GCS bucket |
| `state.json` | Disco persistente VM | Diario → GCS bucket |
| `media/` | Disco persistente VM | Opcional |

**Pérdida de `auth_info_baileys/` = re-scan de QR obligatorio.**
El backup diario a GCS minimiza el impacto de un disco corrupto.

## Flujo de despliegue

```
Developer (Windows)
       │
       ├── 01-create-vm.ps1      →  Crea VM + IP + firewall en GCP
       ├── 02-setup-vm.ps1       →  Instala Docker + Caddy en la VM
       ├── 03-deploy.ps1         →  Build + deploy wa_api container
       ├── 04-ssh-tunnel.ps1     →  Abre tunnel para QR scan
       └── 05-backup.ps1         →  Backup manual a GCS
```

Todos los scripts usan `ccisnedev` como usuario SSH (explícito, no default).

## Estimación de costos

| Recurso | Costo/mes |
|---------|:---------:|
| VM e2-small (us-central1) | ~$12.23 |
| Disco balanced 10 GB | ~$1.00 |
| IP estática (en uso) | $0.00 |
| GCS bucket (backups, <1 GB) | ~$0.02 |
| Egress (<1 GB) | ~$0.00 |
| **Total por simulador** | **~$13.25** |
