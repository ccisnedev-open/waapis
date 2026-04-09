# Análisis: Seguridad y acceso al dashboard

> APE State: **ANALYZE**  
> Fecha: 2026-04-08  
> Contexto: ¿Cómo se protege el dashboard y el API al exponer la VM a internet?

---

## Problema

Al publicar wa_api en `wa-api-s1.cacsi.dev`, todas las rutas quedan accesibles
desde internet a menos que se bloqueen explícitamente. Las rutas peligrosas son:

| Ruta | Riesgo si queda pública |
|------|------------------------|
| `GET /dashboard` | Cualquiera ve el QR code o el estado de sesión |
| `GET /api/session/status` | Expone si hay QR pendiente |
| `POST /api/session/logout` | Cualquiera puede desconectar la sesión |
| `POST /api/session/reconnect` | Cualquiera puede forzar reconexión |

Las rutas del API de mensajes (`/{phoneId}/messages`, `/{wabaId}/templates`,
`/{mediaId}`) ya están protegidas por Bearer token (`ACCESS_TOKEN`).

---

## Solución: Caddy como filtro de rutas + SSH tunnel para dashboard

### Capa 1 — Caddy bloquea rutas administrativas

Caddy actúa como reverse proxy en `:443` y bloquea las rutas del dashboard
antes de hacer proxy a wa_api:

```
Internet → Caddy (:443) → wa_api (:3001)
               │
               ├─ /dashboard           → 403 Forbidden
               ├─ /api/session/*       → 403 Forbidden
               ├─ /health              → Público (monitoring)
               ├─ /{phoneId}/messages  → Público (requiere Bearer token)
               ├─ /{wabaId}/templates  → Público (requiere Bearer token)
               ├─ /{mediaId}           → Público (requiere Bearer token)
               └─ /webhook             → Público (verificación Meta)
```

### Capa 2 — SSH tunnel para acceso al dashboard

El SSH tunnel conecta **directamente** al puerto 3001 de la VM — sin pasar
por Caddy. El dashboard web funciona exactamente igual que en desarrollo local:

```
Tu PC (Windows)                         VM en Google Cloud
┌─────────────────┐    SSH tunnel       ┌──────────────────┐
│                 │◄═══════════════════►│                  │
│  Browser abre:  │  tu localhost:3001  │  wa_api :3001    │
│  http://        │  ─── reenvía ───►   │  /dashboard      │
│  localhost:3001 │                     │  (web SPA)       │
│  /dashboard     │                     │                  │
└─────────────────┘                     └──────────────────┘
```

**El tunnel toma el puerto 3001 remoto y lo expone como `localhost:3001` en tu
PC.** Tu browser local abre la web del dashboard normalmente — QR visible,
botones funcionales. Para internet, el puerto 3001 no existe (firewall cerrado).

### Comando para abrir el tunnel

```powershell
gcloud compute ssh ccisnedev@wa-sim-cacsi-1 `
  --project wa-api-simulator `
  --zone us-central1-a `
  -- -L 3001:localhost:3001
```

Luego abrir `http://localhost:3001/dashboard` en el browser.

**No se necesita software adicional ni cambios en wa_api.** El dashboard es
la misma web que ya existe — solo cambia el medio de acceso.

---

## Procedimiento de vinculación de número (QR scan)

Este procedimiento se ejecuta solo 2 veces: al crear un nuevo simulador y si
la sesión expira (raro, ocurre por ban o cambio de dispositivo).

### Requisitos previos

- `gcloud` CLI instalado y autenticado
- Acceso SSH a la VM con usuario `ccisnedev`
- Teléfono físico con WhatsApp instalado en el número a vincular

### Pasos

```
1. Abrir terminal PowerShell

2. Conectar SSH tunnel:
   gcloud compute ssh ccisnedev@wa-sim-cacsi-1 `
     --project wa-api-simulator `
     --zone us-central1-a `
     -- -L 3001:localhost:3001

3. Abrir en el browser: http://localhost:3001/dashboard
   → Si la sesión está activa: muestra "Connected" + número
   → Si necesita QR: muestra código QR

4. En el teléfono:
   WhatsApp → ⋮ (menú) → Dispositivos vinculados → Vincular dispositivo

5. Escanear el QR que aparece en el dashboard

6. Esperar ~5 segundos. El dashboard muestra "Connected"

7. Verificar: GET http://localhost:3001/health
   → Debe responder { "status": "connected", "phone": "51..." }

8. Cerrar el tunnel (Ctrl+C). wa_api sigue corriendo en la VM.
```

### ¿Cuándo hay que repetir este proceso?

| Evento | Re-scan necesario |
|--------|:-----------------:|
| Reinicio de VM | ❌ No (auto-reconnect con `auth_info_baileys/`) |
| Deploy nueva versión | ❌ No (credenciales persisten en disco) |
| Crash + restart | ❌ No (5 intentos de reconexión automática) |
| Sesión expirada por WhatsApp | ✅ Sí |
| Ban temporal del número | ✅ Sí |
| Alguien abre WhatsApp Web en otro browser | ✅ Sí (desplaza la sesión) |
| Cambio de teléfono | ✅ Sí |

---

## Resumen de capas de seguridad

| Capa | Protege | Mecanismo |
|------|---------|-----------|
| **Firewall GCP** | Solo puertos 80, 443, 22 (IAP) | `gcloud compute firewall-rules` |
| **Caddy (rutas)** | Dashboard + session API → 403 | Caddyfile `respond 403` |
| **Bearer token** | API de mensajes/templates/media | Middleware `auth-token.ts` |
| **SSH tunnel** | Acceso privado al dashboard | `gcloud compute ssh -L` |
| **IAP** | SSH solo para cuentas Google autorizadas | Identity-Aware Proxy |

### Caddyfile previsto

```caddyfile
wa-api-s1.cacsi.dev {
    # Bloquear dashboard y session management
    handle /dashboard* {
        respond 403
    }
    handle /api/session/* {
        respond 403
    }

    # Proxy todo lo demás a wa_api
    handle {
        reverse_proxy localhost:3001
    }
}
```
