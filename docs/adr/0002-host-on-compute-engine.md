# 2. Host wa_api on Compute Engine VM

Date: 2026-04-08

## Status

Accepted

## Context

wa_api es un **simulador completo e independiente** de la WhatsApp Cloud API de
Meta, basado en Baileys — un cliente WebSocket puro (no usa navegador headless).
Es un producto autónomo: cualquier aplicación que consuma la Cloud API de Meta
puede usar wa_api sin modificaciones, cambiando solo la URL base.

**Capacidades del simulador:**
- **Outbound:** `POST /{phoneId}/messages` → Baileys → WhatsApp → usuario
- **Inbound:** Usuario → WhatsApp → Baileys → wa_api → `POST CALLBACK_URL`
- **Webhook idéntico a Meta:** firma HMAC-SHA256, mismo payload, mismos retries
- **Templates:** resolución de parámetros, validación de ventana 24h
- **Media:** descarga, almacenamiento, endpoints de acceso

H.E.L.P. es solo uno de los posibles consumidores. Necesitamos desplegar wa_api
en producción en Google Cloud.

### Restricciones del servicio

1. **Stateful por diseño.** Baileys persiste credenciales en
   `auth_info_baileys/` (~3000+ archivos JSON pequeños, 50–200 MB). Sin estos
   archivos, la sesión se pierde y hay que re-escanear el QR code.

2. **Single-instance por número.** WhatsApp permite exactamente 1 sesión web
   por número. No hay HA posible, no se puede escalar horizontalmente.

3. **WebSocket long-lived.** La conexión a WhatsApp debe mantenerse 24/7.
   Cualquier interrupción requiere reconexión (5 intentos, backoff exponencial).

4. **I/O adversarial para object storage.** Miles de archivos <1 KB con
   lecturas/escrituras frecuentes. GCS FUSE añadiría ~50-200ms por operación,
   haciendo el arranque de 2s pasar a 30-60s.

### Opciones evaluadas

| Opción | Costo/mes | Problema principal |
|--------|:---------:|-------------------|
| Compute Engine e2-small | ~$13 | Gestión manual de OS |
| Cloud Run + GCS FUSE | ~$30 | Latencia I/O inaceptable con 3000+ archivos |
| Cloud Run + sync script | ~$30 | Complejidad innecesaria, ventana de pérdida |
| Cloud Run + Filestore NFS | ~$200 | Costo absurdo para 200 MB |
| GKE Autopilot | ~$70+ | Overkill para 1 proceso |
| App Engine Flex | ~$40 | Obsoleto, sin ventajas |

## Decision

Desplegar wa_api en **Compute Engine** con la siguiente configuración:

| Atributo | Valor |
|----------|-------|
| Proyecto GCP | `wa-api-simulator` |
| Tipo de máquina | `e2-small` (2 vCPU shared, 2 GB RAM) |
| Región / Zona | `us-central1-a` |
| SO | Container-Optimized OS (o Debian + Docker) |
| Disco | 10 GB balanced persistent disk |
| IP | Estática reservada |
| Dominio | `wa-api-s1.cacsi.dev` (primer simulador) |
| TLS | Caddy con Let's Encrypt automático |
| DNS | A record → IP estática |
| Convención de nombres | `wa-sim-cacsi-{N}` para VMs |
| Subdominios | `wa-api-s{N}.cacsi.dev` para N simuladores |
| SSH user | `ccisnedev` (siempre explícito) |

Instancias planificadas:

| SimId | Subdominio | Número | Webhook |
|:-----:|-----------|--------|:-------:|
| 1 | `wa-api-s1.cacsi.dev` | 51933182642 | Sí (devtunnel → help_api) |
| 2 | `wa-api-s2.cacsi.dev` | 51933152391 | No (solo outbound) |

El dashboard `/dashboard` queda accesible solo vía SSH tunnel — no se expone
públicamente. Caddy bloquea `/dashboard` y `/api/session/*` con `respond 403`.
El API de mensajes queda expuesto vía HTTPS en el subdominio, protegido por
Bearer token (`ACCESS_TOKEN`).

`CALLBACK_URL` es opcional (fidelidad con Meta): si está ausente o vacío,
los mensajes entrantes se reciben pero no se reenvían — silencioso, sin error.

## Consequences

**Positivas:**
- I/O nativo en disco local — rendimiento óptimo para el patrón de Baileys
- Costo mínimo (~$13/mes por simulador)
- QR scanning simple vía SSH tunnel
- Escalamiento multi-número natural: 1 VM + 1 subdominio por número
- Control total sobre restart, backups, monitoring

**Negativas:**
- Responsabilidad de gestionar OS updates y seguridad
- No hay auto-healing (hay que configurar systemd + health checks)
- Backups manuales (cron → GCS)

**Riesgos aceptados:**
- Baileys no es oficial — Meta puede romperlo o banear el número
- SPOF inherente — 1 sesión por número, sin failover posible
- Re-scan de QR requiere acceso físico al teléfono + SSH a la VM
