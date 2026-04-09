# Análisis: Desplegar wa_api en Google Cloud

> APE State: **ANALYZE**  
> Fecha: 2026-04-08  
> Contexto: wa_api es un simulador completo e independiente de la WhatsApp Cloud
> API de Meta. Funciona en ambas direcciones: envía mensajes (outbound) y recibe
> mensajes vía webhook (inbound). Cualquier app que consuma la Cloud API de Meta
> puede usarlo sin modificaciones. Necesitamos llevarlo a producción en GCP.

---

## Hallazgo crítico: NO requiere navegador headless

Baileys (`@whiskeysockets/baileys` v7) es un cliente WebSocket puro que
reimplementa el protocolo de WhatsApp Web. **No usa Puppeteer, Playwright ni
Chrome.** La cadena `Browsers.ubuntu('WA API Simulator')` es solo un user-agent
a nivel de protocolo.

Esto significa que **cualquier contenedor Linux básico puede ejecutar wa_api**
— no necesita Chrome, no necesita memoria extra para un navegador, no necesita
GPU ni X11.

---

## Requisitos de runtime (verificados contra el código)

| Requisito | Valor | Implicación cloud |
|-----------|-------|-------------------|
| Runtime | Node.js ≥20 LTS | Cualquier imagen `node:20-alpine` |
| CPU | 0.25–0.5 vCPU | Carga mínima |
| RAM | 256–512 MB | Instancia pequeña suficiente |
| Disco persistente | `auth_info_baileys/` (~50–200 MB, ~3000+ archivos pequeños) | **CRÍTICO**: debe sobrevivir reinicios |
| Estado | `state.json` (~5 MB, flush cada 10s) | Debe persistir |
| Media | `./media/` (hasta 100 MB, configurable) | Puede ser efímero o persistente |
| Red | WebSocket saliente (long-lived a WhatsApp) | Conexión 24/7, no se puede interrumpir |
| Puerto | 3001 HTTP (Express) | Sin HTTPS nativo |
| Proceso | Single process, no clusterable | 1 réplica = 1 sesión de WhatsApp |
| Shutdown | Captura SIGTERM, guarda estado | Compatible con graceful drain |
| Reconexión | 5 intentos, backoff exponencial (2s–30s) | Tolera reinicios breves |
| QR inicial | Dashboard en `/dashboard`, escaneo manual | Necesita acceso interactivo al dashboard |

### Patrón de I/O que define la decisión

Baileys escribe **miles de archivos pequeños** en `auth_info_baileys/`:
- ~1650 pre-keys (JSON, <1 KB c/u)
- ~1000+ session files por contacto
- ~1000+ lid-mapping files
- `creds.json` (leído en cada reconexión)

Este patrón de I/O es **adversarial para object storage** (GCS) y
**costoso para network filesystems** (NFS/Filestore). El disco local SSD o
persistent disk nativo es el medio natural.

---

## Opciones evaluadas

### Opción A: Compute Engine (VM dedicada)

**Descripción:** Una VM `e2-small` (2 vCPU, 2 GB RAM) con Docker y disco
persistente de 10 GB. wa_api corre como container con volume mounts al disco.

| Aspecto | Evaluación |
|---------|------------|
| Disco persistente | ✅ Disco nativo, I/O óptimo para archivos pequeños |
| WebSocket long-lived | ✅ Sin restricciones |
| QR scanning | ✅ SSH tunnel + browser, o dashboard expuesto |
| Complejidad operativa | ⚠️ Gestionar OS, updates, firewall, PM2/systemd |
| Costo mensual | ~$13–15 USD (e2-small, us-central1, disco 10 GB) |
| Escalabilidad | N/A (single session by design) |
| Disponibilidad | ⚠️ Single VM, sin HA automático — pero WhatsApp es single-session igualmente |
| IP estable | ✅ IP estática reservada (gratis si está en uso) |
| HTTPS | ⚠️ Requiere reverse proxy (Caddy/nginx) o Load Balancer |

**Costo detallado:**
- e2-small (2 vCPU shared, 2 GB): ~$12.23/mes (us-central1, sustained discount)
- Disco estándar 10 GB: ~$0.40/mes
- IP estática: $0 (en uso) / $7.30 (ociosa)
- **Total: ~$13/mes**

**Alternativa micro:** e2-micro (2 vCPU shared, 1 GB) es gratis por billing
account (Free Tier), pero 1 GB RAM puede ser justo con Node.js + WebSocket.
**Riesgo de OOM bajo carga de mensajes.**

---

### Opción B: Cloud Run (Service, always-on)

**Descripción:** Container en Cloud Run con `min-instances: 1`,
`cpu-allocation: always`, facturación por instancia. Montaje de GCS bucket via
Cloud Storage FUSE para `auth_info_baileys/`.

| Aspecto | Evaluación |
|---------|------------|
| Disco persistente | 🔴 **Riesgo alto**: GCS FUSE añade ~50-200ms de latencia por operación de archivo. Con 3000+ archivos small I/O, el arranque y reconexión serán lentos |
| WebSocket long-lived | ✅ Soportado (Cloud Run soporta WebSocket y streaming) |
| QR scanning | ⚠️ Dashboard expuesto públicamente — necesita autenticación (IAP o custom) |
| Complejidad operativa | ✅ Zero ops: deploy, escala, TLS, logs automáticos |
| Costo mensual | ~$25–40 USD (1 vCPU always-on + RAM + networking) |
| Escalabilidad | N/A (forzar max-instances: 1) |
| Disponibilidad | ✅ Cloud Run maneja reinicios y health checks |
| IP estable | ⚠️ Necesita Cloud NAT para IP estática de salida |
| HTTPS | ✅ Automático con certificado managed |

**Problema fundamental: GCS FUSE + archivos pequeños**

GCS FUSE presenta los archivos de GCS como un filesystem POSIX, pero:
- Cada `open()` / `read()` / `write()` hace un HTTP call a GCS
- Baileys hace I/O síncrono en `useMultiFileAuthState()` — lee `creds.json` +
  todos los pre-keys al conectar
- Con ~3000 archivos, el arranque puede tomar **30-60 segundos** vs 1-2s en
  disco local
- Escrituras frecuentes (nuevo pre-key, nuevo session file) generan latencia
  acumulada

**Esto NO es teórico — es el patrón exacto para el que GCS FUSE advierte bajo
rendimiento en su documentación.**

**Mitigación posible:** Copiar `auth_info_baileys/` del bucket a `/tmp` al
arranque, y hacer sync periódico de vuelta. Pero esto introduce complejidad y
ventana de pérdida de datos.

---

### Opción C: Cloud Run + Filestore (NFS)

**Descripción:** Igual que B pero con Filestore (NFS managed) en lugar de GCS
FUSE. Resuelve el problema de latencia de archivos pequeños.

| Aspecto | Evaluación |
|---------|------------|
| Disco persistente | ✅ NFS nativo, latencia ~1-5ms por operación |
| Costo mensual | 🔴 **$175–200 USD** (Filestore Basic mínimo: 1 TB = $0.20/GB/mes) |

**Descartada por costo.** Pagar $175/mes por almacenar 200 MB es absurdo.

---

### Opción D: Cloud Run + init container sync

**Descripción:** Cloud Run con GCS bucket. Un script de inicio copia
`auth_info_baileys/` de GCS a `/tmp` (in-memory filesystem). Un sync
periódico sube cambios de vuelta a GCS. Al recibir SIGTERM, hace flush final.

| Aspecto | Evaluación |
|---------|------------|
| Disco persistente | ⚠️ Funcional pero frágil: ventana de pérdida de ~10s en crash |
| I/O performance | ✅ In-memory filesystem = rápido |
| Complejidad | 🔴 Script de sync custom, manejo de edge cases, race conditions |
| Costo mensual | ~$25–40 USD (Cloud Run) + ~$0.02 (GCS bucket) |

**Viable técnicamente pero introduce complejidad innecesaria para un servicio
que es inherentemente single-instance y stateful.**

---

### Opción E: GKE Autopilot

**Descripción:** Kubernetes cluster con un pod y PersistentVolumeClaim.

| Aspecto | Evaluación |
|---------|------------|
| Todo | 🔴 Overkill extremo para 1 proceso |
| Costo | ~$70+ USD/mes (control plane + nodo + disco + networking) |

**Descartada.** Complejidad y costo injustificados.

---

### Opción F: App Engine Flexible

| Aspecto | Evaluación |
|---------|------------|
| Disco | 🔴 Efímero, mismos problemas que Cloud Run |
| Costo | ~$30–50 USD/mes (más caro que Cloud Run) |
| Estado | 🟡 En desuso progresivo a favor de Cloud Run |

**Descartada.** Inferior a Cloud Run en todo aspecto.

---

## Matriz de decisión

| Criterio (peso) | VM e2-small (A) | Cloud Run + FUSE (B) | Cloud Run + sync (D) |
|------------------|:---:|:---:|:---:|
| **I/O compatible** (30%) | ✅ 10 | 🔴 2 | ⚠️ 6 |
| **Costo** (25%) | ✅ 9 | ⚠️ 5 | ⚠️ 5 |
| **Simplicidad ops** (20%) | ⚠️ 5 | ✅ 9 | 🔴 3 |
| **Confiabilidad** (15%) | ⚠️ 7 | ⚠️ 6 | ⚠️ 5 |
| **QR/onboarding** (10%) | ✅ 9 | ⚠️ 5 | ⚠️ 5 |
| **Score ponderado** | **8.05** | **4.90** | **4.80** |

---

## Riesgos transversales (aplican a TODAS las opciones)

### 🔴 Riesgo 1: Baileys no es un cliente oficial

Baileys es reverse-engineering del protocolo de WhatsApp Web. Meta no lo
soporta, no lo autoriza, y activamente intenta bloquearlo.

**Consecuencias:**
- Actualizaciones de protocolo pueden romper Baileys sin aviso
- Meta puede banear el número asociado a la sesión
- No hay SLA, no hay soporte, no hay garantías

**Mitigación:**
- Monitorear el repo de Baileys para updates de protocolo
- Tener un número de contingencia
- Health checks que alerten cuando la sesión cae
- Considerar migración futura a WhatsApp Business API oficial (Meta Cloud API)

### 🟡 Riesgo 2: Sesión unique, SPOF absoluto

WhatsApp permite exactamente 1 sesión web por número. Esto significa:
- No hay HA posible (no se puede tener un standby activo)
- Si alguien abre WhatsApp Web en un browser, desconecta wa_api
- Si wa_api crashea, no hay failover — solo reconexión automática

**Mitigación:**
- Process manager (PM2 o systemd) con restart automático
- Alertas sobre desconexión (health endpoint + uptime monitor)
- Documentar que el número de wa_api NO se debe usar en WhatsApp Web

### 🟡 Riesgo 3: QR re-scan

Si la sesión expira o se invalida (cambio de dispositivo, update de WhatsApp,
ban temporal), se necesita re-escanear el QR code. Esto requiere:
- Acceso al dashboard (browser)
- Acceso físico al teléfono con WhatsApp

En una VM: SSH tunnel → abrir dashboard → escanear. ~2 minutos.
En Cloud Run: necesitas que el dashboard sea accesible + autenticado. Más fricción.

---

## Recomendación

**Compute Engine e2-small** es la opción más adecuada para este servicio.

**Razones:**
1. **El patrón de I/O manda.** Baileys escribe miles de archivos pequeños
   continuamente. Solo un disco local maneja esto sin degradar rendimiento.
2. **El servicio es inherentemente stateful y single-instance.** Las ventajas
   de Cloud Run (escala, efímero, managed) no aplican — son desventajas.
3. **Costo mínimo.** $13/mes vs $25–40/mes para una solución objectively peor.
4. **Operaciones simples.** Docker + systemd + Caddy (reverse proxy) es una
   stack conocida y debuggable. No hay magia, no hay abstracciones.
5. **QR scanning sin fricción.** SSH tunnel directo al dashboard.

**La complejidad de Cloud Run no se justifica cuando el servicio necesita
exactamente lo que una VM ofrece: un proceso, un disco, un IP.**

---

## Siguiente: Qué necesitamos para PLAN

Si avanzamos con la VM, el plan debe cubrir:

1. Dockerfile para wa_api
2. Docker Compose de producción (wa_api + Caddy reverse proxy)
3. Provisión de VM (gcloud CLI o Terraform)
4. Disco persistente para `auth_info_baileys/`
5. Setup de DNS (subdominio para wa_api)
6. TLS via Caddy (Let's Encrypt automático)
7. Process management (restart automático)
8. Monitoring (health check + alertas)
9. Backup de `auth_info_baileys/` (cron → GCS bucket)
10. Firewall rules (solo puertos 80, 443, 22)
11. CALLBACK_URL apuntando a la API de HELP (¿ya en la nube o local?)
12. Primer QR scan y verificación end-to-end
