# Plan: Desplegar wa_api en Compute Engine

> APE State: **PLAN** (v3 — actualizado 2026-04-09)  
> Análisis: [analyze/01-hosting-options.md](analyze/01-hosting-options.md),
>           [analyze/02-security-and-dashboard-access.md](analyze/02-security-and-dashboard-access.md)

---

## Alcance

Crear la infraestructura de despliegue de wa_api en GCP. Todos los scripts
son parametrizados con `-SimId` — soportan N simuladores con el mismo proceso.

**Despliegue inicial:** ambos simuladores en la misma ejecución.
Primero s1 (con devtunnel + webhook), luego s2 (solo outbound, sin webhook).

Al terminar:

- 2 VMs corriendo en `us-central1-a` con wa_api en Docker
- HTTPS vía Caddy en `wa-api-s1.cacsi.dev` y `wa-api-s2.cacsi.dev`
- Dashboards protegidos (solo SSH tunnel)
- APIs protegidos por Bearer token
- s1 con webhook vía devtunnel, s2 sin webhook
- Backup manual a GCS
- Scripts parametrizados en `wa_api/infra/` — listos para replicar

## Instancias planificadas

| SimId | Subdominio | Número | Webhook | Estado |
|:-----:|-----------|--------|:-------:|--------|
| 1 | `wa-api-s1.cacsi.dev` | 51933182642 | ✅ Sí (devtunnel → help_api) | Desplegar primero |
| 2 | `wa-api-s2.cacsi.dev` | 51933152391 | ❌ No (solo outbound) | Desplegar segundo |

## Cambios de código previos al deploy

Antes de crear infraestructura, wa_api necesita estas modificaciones:

**`CALLBACK_URL`, `VERIFY_TOKEN`, `APP_SECRET` opcionales** (fidelidad con Meta):
- `config.ts` — de `requireEnv()` a `process.env[] || undefined`
- `main.ts` — dispatch webhook solo si `callbackUrl && appSecret` están presentes
- `app.ts` — registrar ruta `/webhook` solo si `verifyToken` está presente

Si `CALLBACK_URL` está ausente o vacío, los mensajes entrantes se reciben pero
no se reenvían. Silencioso, sin error — exacto como hace Meta sin webhook registrado.

## Estructura de archivos

```
wa_api/
├── .env.production.s1             # Config instancia s1 (gitignored)
├── .env.production.s2             # Config instancia s2 (gitignored)
└── infra/
    ├── Dockerfile                 # Build multi-stage Node 20 Alpine
    ├── docker-compose.prod.yml    # wa-api + Caddy
    ├── .env.production.example    # Template de referencia
    ├── caddy/
    │   └── Caddyfile              # Generado por 03-deploy.ps1 (no editar)
    ├── scripts/
    │   ├── config.ps1             # Constantes + Resolve-SimulatorNames
    │   ├── 01-create-vm.ps1       # -SimId → crea VM + IP + firewall
    │   ├── 02-setup-vm.ps1        # -SimId → instala Docker
    │   ├── 03-deploy.ps1          # -SimId → build + deploy (también updates)
    │   ├── 04-ssh-tunnel.ps1      # -SimId → tunnel para QR scan
    │   └── 05-backup.ps1          # -SimId → backup → GCS
    └── README.md                  # Guía completa de operaciones
```

### Naming por SimId

Todos los nombres se resuelven desde `config.ps1 → Resolve-SimulatorNames`:

| SimId | VM | IP | Subdominio | .env |
|:-----:|----|----|-----------|------|
| 1 | `wa-sim-cacsi-1` | `wa-sim-cacsi-1-ip` | `wa-api-s1.cacsi.dev` | `.env.production.s1` |
| 2 | `wa-sim-cacsi-2` | `wa-sim-cacsi-2-ip` | `wa-api-s2.cacsi.dev` | `.env.production.s2` |
| N | `wa-sim-cacsi-N` | `wa-sim-cacsi-N-ip` | `wa-api-sN.cacsi.dev` | `.env.production.sN` |

---

## Pasos

### Paso 1 — Cambios de código (webhook opcional)

Modificar wa_api para que `CALLBACK_URL` sea opcional:
- `src/config.ts` — `callbackUrl`, `verifyToken`, `appSecret` opcionales
- `src/main.ts` — condicionar `dispatchWebhook` a presencia de URL
- `src/app.ts` — condicionar registro de ruta `/webhook` a presencia de token

**Criterio:** `npm run build` limpio + 88 tests pasando.

### Paso 2 — Dockerfile

`wa_api/infra/Dockerfile` multi-stage:
- Build: `node:20-alpine`, `npm ci`, `npm run build`
- Production: `node:20-alpine`, `npm ci --omit=dev`, solo `dist/`
- Expone 3001, CMD `node dist/main.js`

### Paso 3 — Docker Compose de producción

`wa_api/infra/docker-compose.prod.yml`:
- Servicio `wa-api`: build desde Dockerfile, `env_file: ../.env.production`,
  restart always, healthcheck vía `/health`, volúmenes bind-mount para
  `auth_info_baileys/` y `media/`
- Servicio `caddy`: imagen `caddy:2-alpine`, Caddyfile montado, puertos 80/443,
  volúmenes para data y config de TLS
- Red interna `wa-net`

El `03-deploy.ps1` copia `.env.production.sN` como `.env.production` en la VM.

### Paso 4 — Caddyfile (generado dinámicamente)

El Caddyfile **no se edita manualmente** — `03-deploy.ps1` lo genera con el
subdominio correcto según el SimId:
- Bloquea `/dashboard*` y `/api/session/*` → `respond 403`
- Proxy todo lo demás a `wa-api:3001`

### Paso 5 — Archivos .env por instancia

Template en `infra/.env.production.example`. Por instancia en `wa_api/`:

**`.env.production.s1`** (webhook habilitado):
- `PHONE_NUMBER=51933182642`
- `CALLBACK_URL=https://{devtunnel}/api/v1/ingress/webhook`
- `VERIFY_TOKEN`, `APP_SECRET` presentes

**`.env.production.s2`** (solo outbound):
- `PHONE_NUMBER=51933152391`
- `CALLBACK_URL=` (vacío — sin webhook)
- `VERIFY_TOKEN`, `APP_SECRET` ausentes o vacíos

Cada instancia tiene su propio `ACCESS_TOKEN` único.

### Paso 6 — Scripts parametrizados

`config.ps1` — constantes compartidas:
- Proyecto: `wa-api-simulator`, zona: `us-central1-a`, usuario: `ccisnedev`
- `Resolve-SimulatorNames -SimId N` → resuelve nombres de todos los recursos

`01-create-vm.ps1 -SimId N`:
1. Reservar IP estática
2. Crear VM e2-small, debian-12, disco 10 GB
3. Crear firewall rules (compartidas, idempotentes)
4. Mostrar IP para DNS

`02-setup-vm.ps1 -SimId N`:
1. Instalar Docker + Docker Compose vía SSH
2. Crear `/opt/wa-api/` con subdirectorios

`03-deploy.ps1 -SimId N` (primer deploy y updates):
1. Verificar que `.env.production.sN` existe
2. Generar Caddyfile con subdominio correcto
3. Crear tarball del código (excluye node_modules, auth_info, .env)
4. SCP tarball + `.env.production.sN` (como `.env.production`) a la VM
5. Build y up containers
6. Health check

`04-ssh-tunnel.ps1 -SimId N`:
1. Abre tunnel SSH (`-L 3001:localhost:3001`)
2. Dashboard web accesible en `http://localhost:3001/dashboard`

`05-backup.ps1 -SimId N`:
1. Crear bucket GCS si no existe (compartido entre instancias)
2. Comprimir `auth_info_baileys/` + `state.json` en la VM
3. Subir a GCS con timestamp

### Paso 7 — README de infra

Documentar en `wa_api/infra/README.md`:
- Prerequisitos (gcloud CLI, proyecto, DNS)
- Quickstart paso a paso
- Vinculación de número (QR scan vía tunnel)
- Guía para agregar un nuevo simulador (5 pasos)
- Operaciones: update, backup, restore, logs, restart
- Seguridad (Caddy, Bearer token, firewall, SSH)
- CALLBACK_URL: devtunnel (dev) vs dominio (prod)
- Costos

### Paso 8 — Devtunnel para s1

Solo s1 necesita devtunnel (recibe webhooks de mensajes entrantes):

1. `devtunnel create wa-api-callback --allow-anonymous`
2. `devtunnel port create wa-api-callback -p 8080`
3. Obtener URL → actualizar `CALLBACK_URL` en `.env.production.s1`
4. Antes de desarrollar: `devtunnel host wa-api-callback`

Temporal. Cuando help_api esté en la nube: `https://help-api.cacsi.dev/...`

### Paso 9 — DNS + Despliegue s1

1. `.\01-create-vm.ps1 -SimId 1` → anotar IP estática
2. Crear A record `wa-api-s1.cacsi.dev` → IP estática de s1
3. `.\02-setup-vm.ps1 -SimId 1`
4. `.\03-deploy.ps1 -SimId 1`
5. `.\04-ssh-tunnel.ps1 -SimId 1` → escanear QR en dashboard
6. Verificar health: `curl https://wa-api-s1.cacsi.dev/health`
7. Probar outbound: enviar mensaje a un número real
8. Probar inbound: enviar mensaje desde WhatsApp, verificar webhook llega

### Paso 10 — Despliegue s2 (sin webhook)

1. `.\01-create-vm.ps1 -SimId 2` → anotar IP estática
2. Crear A record `wa-api-s2.cacsi.dev` → IP estática de s2
3. `.\02-setup-vm.ps1 -SimId 2`
4. `.\03-deploy.ps1 -SimId 2`
5. `.\04-ssh-tunnel.ps1 -SimId 2` → escanear QR en dashboard
6. Verificar health: `curl https://wa-api-s2.cacsi.dev/health`
7. Probar outbound: enviar mensaje a un número real
8. Confirmar que NO envía webhooks (no hay CALLBACK_URL)

---

## Guía: agregar un nuevo simulador

Para desplegar `wa-api-sN.cacsi.dev` con un número nuevo:

```
1. Crear .env.production.sN con el nuevo PHONE_NUMBER y ACCESS_TOKEN
2. .\01-create-vm.ps1 -SimId N
3. Crear DNS A record: wa-api-sN.cacsi.dev → IP mostrada
4. .\02-setup-vm.ps1 -SimId N
5. .\03-deploy.ps1 -SimId N
6. .\04-ssh-tunnel.ps1 -SimId N → escanear QR
```

Para actualizar código en una instancia existente:
```
.\03-deploy.ps1 -SimId N
```

---

## Criterio de aceptación

### s1 (inbound + outbound)
- [ ] `curl https://wa-api-s1.cacsi.dev/health` → `200 { status: connected }`
- [ ] `curl https://wa-api-s1.cacsi.dev/dashboard` → `403`
- [ ] `curl -H "Authorization: Bearer wrong" .../{pnid}/messages` → `401`
- [ ] SSH tunnel + browser → dashboard muestra sesión conectada
- [ ] Outbound: enviar mensaje vía API, llega al teléfono
- [ ] Inbound: enviar WhatsApp al número, webhook llega a help_api (devtunnel)
- [ ] Backup en GCS contiene `auth_info_baileys/`

### Infraestructura parametrizada
- [ ] `.\01-create-vm.ps1 -SimId 2` crea VM y IP con nombres correctos
- [ ] `.\03-deploy.ps1 -SimId 2` genera Caddyfile con `wa-api-s2.cacsi.dev`
- [ ] wa_api sin `CALLBACK_URL` arranca correctamente (solo outbound)

---

## Riesgos del plan

| Riesgo | Mitigación |
|--------|-----------|
| DNS no propagado al probar | Esperar TTL o usar `--resolve` en curl |
| Let's Encrypt rate limit | TLS staging primero, cambiar a prod |
| `auth_info_baileys/` local no compatible con VM | Sesión nueva, QR fresh |
| Firewall bloquea WebSocket saliente | Default egress es abierto en GCE |
| Baileys rompe por update de protocolo | Monitorear repo, tener número de contingencia |

---

## No incluido en este plan

- Migración de `auth_info_baileys/` desde la máquina local (sesión nueva)
- Monitoring avanzado (Cloud Monitoring, alertas)
- CI/CD automático (GitHub Actions → deploy)
- Despliegue de s2 (se ejecuta cuando haya segundo número, mismos scripts)
