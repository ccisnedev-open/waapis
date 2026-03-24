# WhatsApp API Simulator

> Simulador local de la WhatsApp Cloud API de Meta, basado en **Baileys v7** + **Express 4** + **TypeScript (ESM)**.  
> Parte de la plataforma [H.E.L.P.](https://github.com/cacsi/help) — Helpdesk Event Loop Processor.

---

## Descripción

El simulador expone endpoints **100% compatibles** con la API de Meta para WhatsApp Business. La plataforma H.E.L.P. interactúa con él exactamente igual que con Meta en producción. La migración a producción solo requiere cambiar la URL base y registrar el webhook en Meta Dashboard.

Funcionalidades principales:
- Envío/recepción de mensajes vía Baileys (WhatsApp Web)
- Webhooks con firma HMAC-SHA256 idénticos a los de Meta
- Validación de ventana de 24 horas (error code `131026`)
- Templates hardcodeados con resolución de parámetros
- Descarga eager de media + endpoints de acceso
- Dashboard web para gestión de sesión (QR, estado, logout)

---

## Requisitos previos

- **Node.js 20 LTS** o superior
- Un teléfono con WhatsApp para vincular la sesión

---

## Setup

```bash
# 1. Instalar dependencias
npm install

# 2. Configurar variables de entorno
cp .env.example .env
# Editar .env con tus valores

# 3. Iniciar en modo desarrollo
npm run dev

# 4. Abrir el dashboard para vincular WhatsApp
# http://localhost:3001/dashboard
```

---

## Scripts

| Comando | Descripción |
|---|---|
| `npm run dev` | Inicia con hot-reload (tsx watch) |
| `npm run build` | Compila TypeScript a `dist/` |
| `npm start` | Ejecuta la versión compilada |
| `npm test` | Ejecuta todos los tests (Vitest) |
| `npm run test:watch` | Tests en modo watch |

---

## Endpoints

### Meta-compatible (consumidos por H.E.L.P.)

| Método | Ruta | Descripción |
|---|---|---|
| `POST` | `/{phone-number-id}/messages` | Enviar mensaje (text, template) |
| `GET` | `/{media-id}` | Metadatos de media (url, mime, sha256) |
| `GET` | `/media/download/{media-id}` | Descarga binaria de media |
| `GET` | `/{waba-id}/message_templates` | Lista de templates disponibles |
| `GET` | `/webhook` | Verificación hub.challenge |

### Internos (simulador)

| Método | Ruta | Descripción |
|---|---|---|
| `GET` | `/health` | Estado de la sesión Baileys |
| `GET` | `/dashboard` | Dashboard web (QR, estado, logout) |
| `GET` | `/api/session/status` | Estado JSON de la sesión |
| `POST` | `/api/session/logout` | Cerrar sesión y borrar credenciales |
| `POST` | `/api/session/reconnect` | Reconectar sesión |

---

## Dashboard

Accede a `http://localhost:3001/dashboard` para:

1. **Vincular WhatsApp** — Escanea el código QR desde tu teléfono
2. **Ver estado** — Indicador de conexión (connected/connecting/disconnected)
3. **Cerrar sesión** — Botón para desconectar y borrar credenciales
4. **Reconectar** — Botón para reiniciar la conexión

El dashboard hace polling cada 2 segundos al endpoint `/api/session/status`.

---

## Variables de entorno

| Variable | Requerida | Default | Descripción |
|---|---|---|---|
| `PORT` | No | `3001` | Puerto del servidor |
| `PHONE_NUMBER` | Sí | — | Número de teléfono vinculado |
| `PHONE_NUMBER_ID` | Sí | — | ID del número (para rutas Meta) |
| `WABA_ID` | Sí | — | WhatsApp Business Account ID |
| `ACCESS_TOKEN` | Sí | — | Token de autenticación para endpoints |
| `CALLBACK_URL` | Sí | — | URL donde enviar webhooks |
| `VERIFY_TOKEN` | Sí | — | Token para verificación hub.challenge |
| `APP_SECRET` | Sí | — | Secreto para firma HMAC de webhooks |
| `MEDIA_DIR` | No | `./media` | Directorio para archivos de media |
| `MEDIA_MAX_SIZE_MB` | No | `100` | Tamaño máximo de media en MB |

---

## Arquitectura

```
┌─────────────────────────────────────────────┐
│            Express HTTP Server              │
│  ┌───────────┬────────────┬──────────────┐  │
│  │ Messages  │ Templates  │    Media     │  │
│  │  Route    │   Route    │    Route     │  │
│  └─────┬─────┴────────────┴──────┬───────┘  │
│        │                         │          │
│  ┌─────▼─────┐           ┌──────▼───────┐  │
│  │  Baileys   │           │  Simulator   │  │
│  │  Session   │           │    State     │  │
│  │  Manager   │           │  (JSON file) │  │
│  └─────┬─────┘           └──────────────┘  │
│        │                                    │
│  ┌─────▼──────────────────────────────────┐ │
│  │         Webhook Dispatcher             │ │
│  │    (HMAC-SHA256 signed POST)           │ │
│  └────────────────────────────────────────┘ │
└─────────────────────────────────────────────┘
         │                    ▲
         ▼                    │
   WhatsApp Web          H.E.L.P. Platform
   (via Baileys)         (callback URL)
```

---

## Troubleshooting

| Problema | Solución |
|---|---|
| QR no aparece en dashboard | Verificar que el servidor está corriendo. Revisar logs por errores de Baileys. |
| Sesión se desconecta frecuentemente | Normal en WhatsApp Web. El simulador reconecta automáticamente (máx 5 intentos con backoff). |
| Error `131026` al enviar mensaje | La ventana de 24h expiró. El usuario debe enviar un mensaje primero, o usar un template. |
| `401 Unauthorized` en endpoints | Verificar que el header `Authorization: Bearer {ACCESS_TOKEN}` es correcto. |
| Media no se descarga | Verificar permisos de escritura en `MEDIA_DIR`. |

---

## Stack técnico

| Capa | Tecnología |
|---|---|
| Runtime | Node.js 20 LTS |
| Framework HTTP | Express 4 |
| WhatsApp | @whiskeysockets/baileys v7 |
| Lenguaje | TypeScript (ESM) |
| Tests | Vitest |
| Persistencia | JSON file (`state.json`) |
| Media | Sistema de archivos local |

---

*H.E.L.P. · Helpdesk Event Loop Processor*  
*H.E.L.P. · Helpdesk Event Loop Processor*  
*WhatsApp API Simulator · CACSI*
