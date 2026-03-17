# RUNBOOK – WhatsApp API Simulator (Baileys v7)

## Objective

Implementar el simulador de WhatsApp Cloud API para la plataforma H.E.L.P., usando Baileys v7 + Express 4 + TypeScript (ESM). El simulador debe exponer endpoints 100% compatibles con la API de Meta, convertir eventos Baileys → webhooks Meta, y ofrecer un dashboard web en `/dashboard` para gestión de sesión (QR code, estado, logout).

## Scope

**In:**
- Scaffolding del proyecto Node.js (ESM, TypeScript, Vitest)
- Gestión de sesión Baileys (connect, disconnect, QR code, reconexión automática)
- Dashboard web en `/dashboard` (QR, estado, logout, pairing code)
- REST API compatible con WhatsApp Cloud API de Meta:
  - `POST /{phone-number-id}/messages` (text, template)
  - `GET /{media-id}` + `GET /media/download/{media-id}`
  - `GET /{waba-id}/message_templates`
  - `GET /webhook` (verificación hub.challenge)
  - `GET /health`
- Normalización de eventos Baileys → webhooks Meta (inbound messages, status updates)
- Firma HMAC-SHA256 en webhooks salientes
- Validación de ventana de 24 horas (error code `131026`)
- Templates hardcodeados con resolución de parámetros
- Descarga eager de media + endpoints de acceso
- Persistencia de estado en `state.json`

**Out:**
- Lógica de negocio de tickets (pertenece a `help/`)
- Base de datos relacional (el simulador usa JSON file)
- Autenticación/autorización avanzada en dashboard (herramienta interna)
- UI con framework frontend (HTML estático con vanilla JS)
- Docker / docker-compose (se hará en fase posterior)
- Tests de integración end-to-end con WhatsApp real (requiere sesión activa)

## Context

- Module: `wa_api`
- Location: `d:\source\cacsi-dev\helpdesk\wa_api\`
- Repository: `ccisnedev-open/waapis` (branch: `main`)
- Related components: `help/api` (consumer de webhooks), `help/mcp` (invoca REST API del simulador)
- Spec de referencia: `wa_api/docs/spec/HELP_whatsapp_simulator_spec.md`
- Assumptions:
  - Node.js 20 LTS disponible en el entorno de desarrollo
  - Baileys v7.0.0-rc.9 (última versión, ESM obligatorio)
  - Express 4 (como indica la spec)
  - El simulador corre en una VM dedicada, accesible desde la VM de H.E.L.P. Core
- Methodology: **Test Driven Development (TDD)**

## Decisions Log

- 2026-03-16: Baileys v7 (ESM) — última versión activa, breaking change obliga ESM
- 2026-03-16: Express 4 (no 5) — spec lo indica explícitamente
- 2026-03-16: Dashboard con polling cada 2s (no WebSocket/SSE) — QR cambia cada ~20s, suficiente
- 2026-03-16: `qrcode` npm para renderizar QR en dashboard — librería liviana, genera data URL PNG
- 2026-03-16: Sin auth en `/dashboard` — herramienta interna, VM privada
- 2026-03-16: Estado en JSON file (no DB) — ADR-S06 de spec, estado minimal
- 2026-03-16: Vitest para tests — nativo ESM, rápido, compatible con TypeScript
- 2026-03-16: Pairing code como alternativa a QR en dashboard — útil para acceso remoto
- 2026-03-16: Media: soportar imagen, video, audio y documento desde el inicio — manejo idéntico vía `downloadMediaMessage`

## Execution Plan (TDD Checklist)

Cada step sigue el ciclo Red-Green-Refactor. Al completar cada sub-paso, marcar su checkbox (`[x]`). El commit final de cada step debe incluir el RUNBOOK con los checks actualizados.

---

### Step 1: Project scaffolding — package.json, tsconfig, .env.example, .gitignore

- [x] Write failing test: crear `src/__tests__/config.test.ts` que importa `config.ts` y valida que las variables de entorno requeridas se cargan correctamente (falla porque no existen los archivos)
- [x] Implement minimum code to pass:
  - Crear `package.json` con `"type": "module"`, dependencias: `@whiskeysockets/baileys`, `express`, `dotenv`, `qrcode`, `pino`, `pino-pretty`. DevDeps: `typescript`, `@types/express`, `@types/node`, `tsx`, `vitest`
  - Crear `tsconfig.json` (target ES2022, module NodeNext, moduleResolution NodeNext, outDir dist)
  - Crear `.env.example` con todas las variables de la spec
  - Actualizar `.gitignore` (node_modules, dist, auth_info_baileys, media, state.json, .env)
  - Crear `src/config.ts` — carga y valida variables de entorno con valores por defecto
  - `npm install`
- [x] Refactor if needed
- [x] Mark completed checks in this RUNBOOK
- [ ] `git add . && git commit -m "step 1: project scaffolding — package.json, tsconfig, config"` (all tests green, RUNBOOK updated)

---

### Step 2: Simulator state + JSON persistence

- [x] Write failing test: `src/__tests__/state/simulator-state.test.ts` — verifica que `SimulatorState` almacena/recupera `lastInboundAt` y `mediaStore`, y que `persistence.ts` lee/escribe `state.json`
- [x] Implement minimum code to pass:
  - `src/state/simulator-state.ts` — clase `SimulatorState` con métodos `recordInbound(phone, timestamp)`, `isWithin24hWindow(phone)`, `registerMedia(entry)`, `getMedia(mediaId)`
  - `src/state/persistence.ts` — funciones `loadState(filePath)` y `saveState(state, filePath)`, escritura periódica cada 10s
- [x] Refactor if needed
- [x] Mark completed checks in this RUNBOOK
- [ ] `git add . && git commit -m "step 2: simulator state + JSON persistence"` (all tests green, RUNBOOK updated)

---

### Step 3: Templates hardcodeados + resolveTemplate

- [ ] Write failing test: `src/__tests__/templates/templates.test.ts` — verifica que `resolveTemplate('reopen_conversation', ['Cristian'])` retorna el texto correcto, y que un template inexistente lanza error
- [ ] Implement minimum code to pass:
  - `src/templates/templates.ts` — array `TEMPLATES` con `reopen_conversation`, función `resolveTemplate(name, params)` que reemplaza `{{N}}`
- [ ] Refactor if needed
- [ ] Mark completed checks in this RUNBOOK
- [ ] `git add . && git commit -m "step 3: templates hardcodeados + resolveTemplate"` (all tests green, RUNBOOK updated)

---

### Step 4: Webhook dispatcher con firma HMAC

- [ ] Write failing test: `src/__tests__/webhooks/webhook-dispatcher.test.ts` — verifica que `dispatchWebhook(payload)` genera header `X-Hub-Signature-256` correcto con HMAC-SHA256, y que el payload enviado tiene la estructura Meta esperada
- [ ] Implement minimum code to pass:
  - `src/webhooks/webhook-dispatcher.ts` — función `dispatchWebhook(payload, callbackUrl, appSecret)` que hace POST con firma HMAC, retry con backoff (máx 3 intentos)
- [ ] Refactor if needed
- [ ] Mark completed checks in this RUNBOOK
- [ ] `git add . && git commit -m "step 4: webhook dispatcher con firma HMAC"` (all tests green, RUNBOOK updated)

---

### Step 5: Event normalizer — Baileys WAMessage → payload Meta

- [ ] Write failing test: `src/__tests__/baileys/event-normalizer.test.ts` — dado un `WAMessage` mock de tipo texto, verifica que `normalizeInboundMessage(msg)` retorna payload idéntico a §5.1 de spec (con `wamid.sim_*`, estructura `entry[].changes[].value.messages[]`). Repetir para imagen, audio, video, documento
- [ ] Implement minimum code to pass:
  - `src/baileys/event-normalizer.ts` — función `normalizeInboundMessage(msg, metadata)` que transforma WAMessage → webhook payload Meta. Función `normalizeStatusUpdate(status, metadata)` para delivered/read
- [ ] Refactor if needed
- [ ] Mark completed checks in this RUNBOOK
- [ ] `git add . && git commit -m "step 5: event normalizer — Baileys → Meta payload"` (all tests green, RUNBOOK updated)

---

### Step 6: Auth token middleware

- [ ] Write failing test: `src/__tests__/middleware/auth-token.test.ts` — verifica que requests sin `Authorization` header retornan 401, con token inválido retornan 401, y con token correcto pasan al siguiente middleware
- [ ] Implement minimum code to pass:
  - `src/middleware/auth-token.ts` — middleware Express que valida `Bearer {ACCESS_TOKEN}`
- [ ] Refactor if needed
- [ ] Mark completed checks in this RUNBOOK
- [ ] `git add . && git commit -m "step 6: auth token middleware"` (all tests green, RUNBOOK updated)

---

### Step 7: Health route

- [ ] Write failing test: `src/__tests__/routes/health.test.ts` — verifica que `GET /health` retorna `{ status, session, phone? }` con los valores correctos según el estado de la sesión (disconnected, connected)
- [ ] Implement minimum code to pass:
  - `src/routes/health.route.ts` — ruta `GET /health` que consulta estado de sesión Baileys
- [ ] Refactor if needed
- [ ] Mark completed checks in this RUNBOOK
- [ ] `git add . && git commit -m "step 7: health route"` (all tests green, RUNBOOK updated)

---

### Step 8: Webhook verification route (hub.challenge)

- [ ] Write failing test: `src/__tests__/routes/webhook.test.ts` — verifica que `GET /webhook?hub.mode=subscribe&hub.verify_token=correct&hub.challenge=test123` retorna 200 con body `test123`, y que token incorrecto retorna 400
- [ ] Implement minimum code to pass:
  - `src/routes/webhook.route.ts` — ruta `GET /webhook` que implementa verificación §4.1 de spec
- [ ] Refactor if needed
- [ ] Mark completed checks in this RUNBOOK
- [ ] `git add . && git commit -m "step 8: webhook verification route (hub.challenge)"` (all tests green, RUNBOOK updated)

---

### Step 9: Templates route

- [ ] Write failing test: `src/__tests__/routes/templates.test.ts` — verifica que `GET /{waba-id}/message_templates` retorna lista de templates con estructura Meta, y filtra por `name`
- [ ] Implement minimum code to pass:
  - `src/routes/templates.route.ts` — ruta `GET /:wabaId/message_templates` con filtros opcionales (`name`, `status`, `language`)
- [ ] Refactor if needed
- [ ] Mark completed checks in this RUNBOOK
- [ ] `git add . && git commit -m "step 9: templates route"` (all tests green, RUNBOOK updated)

---

### Step 10: Messages route — envío de texto con validación de ventana 24h

- [ ] Write failing test: `src/__tests__/routes/messages.test.ts` — verifica:
  - `POST /{phone-number-id}/messages` con tipo `text` dentro de ventana → 200 con `wamid.sim_*`
  - `POST` con tipo `text` fuera de ventana → 400 con error code `131026`
  - `POST` sin auth → 401
  - `POST` con tipo `template` fuera de ventana → 200 (templates no validan ventana)
- [ ] Implement minimum code to pass:
  - `src/routes/messages.route.ts` — ruta `POST /:phoneNumberId/messages` que:
    - Valida auth token
    - Para `text`: consulta `SimulatorState.isWithin24hWindow(to)`, si no → error `131026`
    - Para `template`: resuelve template, sin validación de ventana
    - Envía mensaje vía Baileys `sock.sendMessage(jid, content)`
    - Retorna respuesta Meta-compatible con `wamid.sim_{uuid}`
- [ ] Refactor if needed
- [ ] Mark completed checks in this RUNBOOK
- [ ] `git add . && git commit -m "step 10: messages route — text + template + ventana 24h"` (all tests green, RUNBOOK updated)

---

### Step 11: Media store — descarga eager + registro en state

- [ ] Write failing test: `src/__tests__/media/media-store.test.ts` — verifica que `registerMedia(mediaId, buffer, mimeType)` guarda archivo en `./media/`, calcula SHA256, y registra en `SimulatorState.mediaStore`. Verifica que `getMediaMetadata(mediaId)` retorna la entrada correcta
- [ ] Implement minimum code to pass:
  - `src/media/media-store.ts` — funciones `registerMedia(mediaId, buffer, mimeType, originalFileName?)` y `getMediaMetadata(mediaId)`
- [ ] Refactor if needed
- [ ] Mark completed checks in this RUNBOOK
- [ ] `git add . && git commit -m "step 11: media store — descarga eager + registro"` (all tests green, RUNBOOK updated)

---

### Step 12: Media routes — metadata + descarga binaria

- [ ] Write failing test: `src/__tests__/routes/media.test.ts` — verifica:
  - `GET /{media-id}` retorna JSON con `url`, `mime_type`, `sha256`, `file_size`, `id`
  - `GET /media/download/{media-id}` retorna binario con Content-Type correcto
  - Media inexistente → 404
  - Sin auth → 401
- [ ] Implement minimum code to pass:
  - `src/routes/media.route.ts` — rutas `GET /:mediaId` y `GET /media/download/:mediaId`
- [ ] Refactor if needed
- [ ] Mark completed checks in this RUNBOOK
- [ ] `git add . && git commit -m "step 12: media routes — metadata + descarga binaria"` (all tests green, RUNBOOK updated)

---

### Step 13: Baileys session manager — connect, disconnect, QR, reconnect

- [ ] Write failing test: `src/__tests__/baileys/session.test.ts` — verifica que `BaileysSession` expone `isConnected()`, `currentQR()`, `phoneNumber()`, y que `connect()` inicializa el socket. (Tests unitarios con mock de `makeWASocket`)
- [ ] Implement minimum code to pass:
  - `src/baileys/session.ts` — clase `BaileysSession`:
    - `connect()`: `makeWASocket` + `useMultiFileAuthState('./auth_info_baileys')`, browser `Browsers.ubuntu('HELP Simulator')`
    - Evento `connection.update` → almacena QR, detecta open/close, reconexión con backoff exponencial (máx 5 intentos, no reconectar si `DisconnectReason.loggedOut`)
    - Evento `creds.update` → `saveCreds()`
    - Evento `messages.upsert` → delega a normalizer → webhook dispatcher
    - `disconnect()`: cierra socket, opcionalmente borra `./auth_info_baileys/`
    - `isConnected()`, `currentQR()`, `phoneNumber()`
- [ ] Refactor if needed
- [ ] Mark completed checks in this RUNBOOK
- [ ] `git add . && git commit -m "step 13: Baileys session manager"` (all tests green, RUNBOOK updated)

---

### Step 14: Dashboard — HTML + API endpoints de sesión

- [ ] Write failing test: `src/__tests__/routes/dashboard.test.ts` — verifica:
  - `GET /dashboard` retorna HTML con status 200
  - `GET /api/session/status` retorna JSON con `{ status, phone?, qr? }`
  - `POST /api/session/logout` retorna 200 y desconecta sesión
- [ ] Implement minimum code to pass:
  - `src/dashboard/index.html` — SPA minimal con:
    - Área de QR code (renderizado vía polling cada 2s a `/api/session/status`)
    - Indicador de estado: `connected` / `disconnected` / `connecting`
    - Número de teléfono vinculado (cuando conectado)
    - Botón "Cerrar sesión" → POST `/api/session/logout`
    - Campo + botón "Vincular con código" (pairing code alternativo)
  - `src/routes/dashboard.route.ts` — rutas:
    - `GET /dashboard` → sirve `index.html`
    - `GET /api/session/status` → JSON con estado actual
    - `POST /api/session/logout` → desconecta y borra credenciales
    - `POST /api/session/pair` → solicita pairing code para número dado
- [ ] Refactor if needed
- [ ] Mark completed checks in this RUNBOOK
- [ ] `git add . && git commit -m "step 14: dashboard — HTML + API session endpoints"` (all tests green, RUNBOOK updated)

---

### Step 15: Entrypoint main.ts — integración de todos los módulos

- [ ] Write failing test: `src/__tests__/main.test.ts` — verifica que el servidor arranca correctamente, responde en `/health`, sirve `/dashboard`, y se cierra limpiamente (shutdown graceful)
- [ ] Implement minimum code to pass:
  - `src/main.ts` — entrypoint que:
    1. Carga config desde `.env` con `dotenv`
    2. Restaura `SimulatorState` desde `state.json`
    3. Crea instancia de `BaileysSession`
    4. Registra todas las rutas en Express (health, webhook, dashboard, messages, media, templates)
    5. Inicia conexión Baileys
    6. Sirve en `PORT` (default 3001)
    7. Maneja SIGINT/SIGTERM: persiste estado, cierra socket, cierra servidor
- [ ] Refactor if needed
- [ ] Mark completed checks in this RUNBOOK
- [ ] `git add . && git commit -m "step 15: main.ts — entrypoint + integración completa"` (all tests green, RUNBOOK updated)

---

### Step 16: README con instrucciones de setup y uso

- [ ] Write failing test: N/A (documentación)
- [ ] Implement:
  - Actualizar `README.md` con:
    - Descripción del simulador
    - Requisitos previos (Node.js 20 LTS)
    - Instrucciones de setup (`npm install`, configurar `.env`, `npm run dev`)
    - Endpoints disponibles (tabla resumen)
    - Uso del dashboard
    - Troubleshooting (QR no aparece, sesión expira, etc.)
- [ ] Mark completed checks in this RUNBOOK
- [ ] `git add . && git commit -m "step 16: README con instrucciones de setup y uso"` (RUNBOOK updated)

---

## Constraints

- **Paridad total con Meta Cloud API**: Los payloads de request/response y los error codes deben ser idénticos a los de la API de Meta. La plataforma H.E.L.P. no debe distinguir entre simulador y Meta
- **ESM obligatorio**: Baileys v7 requiere `"type": "module"`. No usarCommonJS
- **Sin schema de DB**: El simulador usa JSON file para estado, no PostgreSQL
- **Sin lógica de tickets**: El simulador es un adaptador de protocolo, no conoce tickets ni estados
- **Escritura vía funciones, no SQL directo**: N/A (no hay DB)
- **No romper la spec**: Cada endpoint debe coincidir exactamente con la sección correspondiente de `HELP_whatsapp_simulator_spec.md`
- **No enviar ACKs**: Baileys v7 los removió porque WhatsApp banea por esto
- **Firma HMAC desde día 1**: Los webhooks deben firmarse con `APP_SECRET` (ADR-S04)
- **Media eager download**: Descargar media inmediatamente al recibirla, no lazy (ADR-S03)

## Validation

- [ ] `npm install` completa sin errores
- [ ] `npm run build` compila TypeScript sin errores
- [ ] `npm test` ejecuta todos los tests y pasan (verde)
- [ ] `npm run dev` arranca servidor en `:3001`
- [ ] `GET /health` retorna `{ "status": "error", "session": "disconnected", "reason": "not_started" }` antes de conectar
- [ ] `GET /dashboard` muestra página web con estado "desconectado" y área para QR
- [ ] Escanear QR en dashboard → estado cambia a "connected" con número de teléfono
- [ ] Enviar mensaje desde WhatsApp → webhook POST llega a `CALLBACK_URL` con formato Meta exacto
- [ ] `POST /{phone-number-id}/messages` con texto → mensaje llega al WhatsApp del destinatario
- [ ] `POST` mensaje texto fuera de ventana 24h → error `131026`
- [ ] `POST` mensaje template fuera de ventana → funciona correctamente
- [ ] Enviar imagen desde WhatsApp → descarga eager → `GET /{media-id}` retorna metadata → `GET /media/download/{media-id}` retorna binario
- [ ] "Cerrar sesión" desde dashboard → estado "disconnected" → al reconectar, QR reaparece
- [ ] Reiniciar simulador → `state.json` se carga → ventanas 24h preservadas

## Rollback / Safety

- El simulador es un componente aislado — no afecta a `help/` ni a `helper/`
- Si la sesión de Baileys se corrompe, borrar `./auth_info_baileys/` y re-escanear QR
- Si `state.json` se corrompe, borrarlo — el simulador arranca con estado vacío (pierde ventanas 24h y registros de media, que se regeneran con uso)
- Todo el código está en el repo `ccisnedev-open/waapis`, branch de feature separado del `main`

## Blockers / Open Questions

- **Baileys v7 estabilidad**: La versión actual es `7.0.0-rc.9` (release candidate). Monitorear issues en GitHub por posibles bugs en la API de sesión
- **LID vs PN**: Baileys v7 migra a LIDs. Para el simulador, los webhooks hacia H.E.L.P. deben incluir el número de teléfono (PN), no el LID. Verificar que `signalRepository.lidMapping.getPNForLID()` funciona correctamente
- **Rate limiting de WhatsApp**: WhatsApp puede bloquear cuentas que envían muchos mensajes automatizados. Para desarrollo, usar un número dedicado exclusivamente al simulador
