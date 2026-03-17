# H.E.L.P. — Especificación: WhatsApp API Simulator
## Componente 1 · Baileys-based WhatsApp Cloud API Simulator

> **Objetivo de diseño:** Paridad total con la WhatsApp Cloud API de Meta.  
> La plataforma H.E.L.P. no debe saber ni importarle si está hablando con el simulador o con Meta.  
> La migración a producción = cambiar una URL + registrar webhook en Meta Dashboard.

---

## 1. Contexto y responsabilidades

El simulador es un proceso Node.js independiente que:

1. Mantiene una sesión activa de WhatsApp Web vía **Baileys** (WebSocket)
2. Recibe mensajes entrantes del usuario real y los reenvía como webhooks a H.E.L.P. Platform (exactamente como haría Meta)
3. Expone una REST API compatible con la WhatsApp Cloud API para que H.E.L.P. Platform envíe mensajes
4. Valida la ventana de 24 horas y rechaza mensajes libres fuera de ella con el error code exacto de Meta
5. Gestiona media (descarga desde WhatsApp y expone endpoints de acceso)
6. Expone templates hardcodeados con el mismo contrato que la API de Meta

**Lo que NO es el simulador:** no tiene base de datos propia compleja, no tiene lógica de negocio, no conoce tickets. Es un adaptador de protocolo.

---

## 2. Arquitectura interna

```
WhatsApp Web (WebSocket)
        │
   ┌────▼──────────────────────────────────────────┐
   │              Baileys Session Manager          │
   │  - Mantiene sesión autenticada                │
   │  - Re-conecta automáticamente                 │
   │  - Almacena credenciales en ./auth_info/      │
   └────┬──────────────────────────────────────────┘
        │ eventos: message, message.update
        ▼
   ┌────────────────────────────────────────────────┐
   │              Event Handler                     │
   │  - Normaliza eventos Baileys → formato Meta    │
   │  - Genera IDs ficticios compatibles            │
   │  - Gestiona media_id local                     │
   │  - Valida / actualiza ventana de 24h           │
   └────┬───────────────────────────────────────────┘
        │ HTTP POST (webhook)
        ▼
   H.E.L.P. Platform  (Callback URL configurada)
   
   ┌────────────────────────────────────────────────┐
   │              REST API Server (Express)         │
   │  Compatible con WhatsApp Cloud API             │
   │                                                │
   │  POST  /{phone-number-id}/messages             │
   │  GET   /{waba-id}/message_templates            │
   │  GET   /{media-id}                             │
   │  GET   /webhook   (hub.challenge)              │
   │  POST  /webhook   (test endpoint)              │
   └────────────────────────────────────────────────┘
```

---

## 3. Estado interno del simulador

El simulador mantiene estado mínimo en memoria (+ persistencia en archivo JSON para sobrevivir reinicios):

```typescript
interface SimulatorState {
  // Ventana de 24h por número de usuario
  // key: phone_number (e.g. "51999000001")
  // value: timestamp del último mensaje INBOUND del usuario
  lastInboundAt: Record<string, number>;

  // Registro de media recibida
  // key: media_id (generado por el simulador)
  // value: ruta local del archivo descargado
  mediaStore: Record<string, MediaEntry>;
}

interface MediaEntry {
  mediaId: string;
  localPath: string;       // ./media/{mediaId}.{ext}
  mimeType: string;
  fileSize: number;
  sha256: string;
  downloadedAt: number;
}
```

---

## 4. Endpoints REST

### 4.1 Verificación de webhook (requerido por Meta)

```
GET /webhook
```

Meta llama este endpoint para verificar que la URL es válida antes de registrarla.

**Query params:**
| Param | Descripción |
|---|---|
| `hub.mode` | Siempre `subscribe` |
| `hub.verify_token` | Token configurado en el simulador |
| `hub.challenge` | String que debe retornarse tal cual |

**Respuesta exitosa:** `200 OK` con body = `hub.challenge` (plain text)  
**Respuesta fallida:** `400 Bad Request`

```typescript
// Implementación
app.get('/webhook', (req, res) => {
  const mode    = req.query['hub.mode'];
  const token   = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.VERIFY_TOKEN) {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(400);
  }
});
```

---

### 4.2 Envío de mensaje

```
POST /{phone-number-id}/messages
Authorization: Bearer {access-token}
Content-Type: application/json
```

Este es el endpoint principal. Un solo endpoint para todos los tipos de mensaje.

#### 4.2.1 Mensaje de texto libre

**Request body:**
```json
{
  "messaging_product": "whatsapp",
  "recipient_type": "individual",
  "to": "51999000001",
  "type": "text",
  "text": {
    "preview_url": false,
    "body": "Hola, ¿en qué podemos ayudarte?"
  }
}
```

**Validación de ventana 24h:**
1. El simulador consulta `lastInboundAt[to]`
2. Si `now - lastInboundAt[to] > 86400000ms (24h)` → rechazar con error Meta

**Error de ventana expirada (idéntico a Meta):**
```json
HTTP 400 Bad Request
{
  "error": {
    "message": "Message failed to send because more than 24 hours have passed since the customer last replied to this number.",
    "type": "OAuthException",
    "code": 131026,
    "error_data": {
      "messaging_product": "whatsapp",
      "details": "Message failed to send because more than 24 hours have passed since the customer last replied to this number."
    },
    "fbtrace_id": "sim_{uuid}"
  }
}
```

**Respuesta exitosa:**
```json
HTTP 200 OK
{
  "messaging_product": "whatsapp",
  "contacts": [{ "input": "51999000001", "wa_id": "51999000001" }],
  "messages": [{ "id": "wamid.sim_{uuid}" }]
}
```

#### 4.2.2 Mensaje de template

**Request body:**
```json
{
  "messaging_product": "whatsapp",
  "to": "51999000001",
  "type": "template",
  "template": {
    "name": "reopen_conversation",
    "language": { "code": "es" },
    "components": [
      {
        "type": "body",
        "parameters": [
          { "type": "text", "text": "Cristian" }
        ]
      }
    ]
  }
}
```

**Comportamiento:** Los templates NO validan la ventana de 24h — pueden enviarse siempre.  
El simulador resuelve el template por `name`, aplica los parámetros, y envía el texto resultante vía Baileys.

**Respuesta exitosa:** Igual que mensaje de texto.

**Error: template no encontrado:**
```json
HTTP 400 Bad Request
{
  "error": {
    "message": "Template name does not exist in the translation",
    "type": "OAuthException",
    "code": 132001,
    "fbtrace_id": "sim_{uuid}"
  }
}
```

#### 4.2.3 Typing indicator (nice-to-have)

```json
{
  "messaging_product": "whatsapp",
  "to": "51999000001",
  "type": "reaction",
  "status": "typing"
}
```

> **Nota:** Meta usa un mecanismo diferente para typing. El simulador lo implementa con el método Baileys `sendPresenceUpdate('composing', jid)`. El contrato del request es simplificado para el MVP.

#### 4.2.4 Marcar como leído (nice-to-have)

```json
{
  "messaging_product": "whatsapp",
  "status": "read",
  "message_id": "wamid.sim_{uuid}"
}
```

El simulador envía `sendReadReceipt` vía Baileys.

---

### 4.3 Descarga de media

#### 4.3.1 Obtener URL de descarga

```
GET /{media-id}
Authorization: Bearer {access-token}
```

**Respuesta:**
```json
{
  "url": "http://localhost:3001/media/download/{media-id}",
  "mime_type": "image/jpeg",
  "sha256": "abc123...",
  "file_size": 204800,
  "id": "{media-id}",
  "messaging_product": "whatsapp"
}
```

#### 4.3.2 Descargar el binario

```
GET /media/download/{media-id}
Authorization: Bearer {access-token}
```

**Respuesta:** `200 OK` con body binario y `Content-Type` correcto.

**Tipos de media soportados:**

| Tipo | MIME types | Tamaño máx (simulado) |
|---|---|---|
| Imagen | `image/jpeg`, `image/png`, `image/webp` | 5 MB |
| Video | `video/mp4`, `video/3gpp` | 16 MB |
| Audio | `audio/ogg; codecs=opus`, `audio/mpeg` | 16 MB |
| Documento | `application/pdf`, `image/jpeg` (docs escaneados) | 100 MB |

**Comportamiento interno:** Cuando Baileys recibe un mensaje con media, el simulador descarga el binario inmediatamente (no lazy), lo guarda en `./media/`, genera un `media_id` propio, y ya tiene el archivo listo cuando la plataforma lo solicita.

---

### 4.4 Consulta de templates

```
GET /{waba-id}/message_templates
Authorization: Bearer {access-token}
```

**Query params opcionales:** `name`, `status`, `language`

**Respuesta:**
```json
{
  "data": [
    {
      "name": "reopen_conversation",
      "status": "APPROVED",
      "category": "UTILITY",
      "language": "es",
      "components": [
        {
          "type": "BODY",
          "text": "Hola {{1}}, vimos que tu consulta fue cerrada. ¿Pudimos ayudarte? Si necesitas algo más, escríbenos.",
          "example": { "body_text": [["Cristian"]] }
        }
      ],
      "id": "sim_template_001"
    }
  ],
  "paging": { "cursors": { "before": "", "after": "" } }
}
```

---

## 5. Webhooks hacia H.E.L.P. Platform

El simulador envía webhooks a la `CALLBACK_URL` configurada en dos situaciones:

### 5.1 Mensaje entrante (inbound)

Disparado cuando Baileys recibe un mensaje del usuario.

```json
POST {CALLBACK_URL}
Content-Type: application/json
X-Hub-Signature-256: sha256={hmac}

{
  "object": "whatsapp_business_account",
  "entry": [{
    "id": "{WABA_ID}",
    "changes": [{
      "value": {
        "messaging_product": "whatsapp",
        "metadata": {
          "display_phone_number": "999000000",
          "phone_number_id": "{PHONE_NUMBER_ID}"
        },
        "contacts": [{
          "profile": { "name": "Juan Pérez" },
          "wa_id": "51999000001"
        }],
        "messages": [{
          "id": "wamid.sim_{uuid}",
          "from": "51999000001",
          "timestamp": "1710000000",
          "type": "text",
          "text": { "body": "Hola, necesito ayuda con mi crédito" }
        }]
      },
      "field": "messages"
    }]
  }]
}
```

**Para mensajes con media (imagen, video, audio, documento):**

```json
"messages": [{
  "id": "wamid.sim_{uuid}",
  "from": "51999000001",
  "timestamp": "1710000000",
  "type": "image",
  "image": {
    "id": "{media-id}",
    "mime_type": "image/jpeg",
    "sha256": "abc123...",
    "caption": "Mi voucher de pago"
  }
}]
```

> El binario NO está en el webhook — igual que Meta. La plataforma debe llamar a `GET /{media-id}` para descargarlo.

**Efecto secundario:** el simulador actualiza `lastInboundAt[from] = now()`.

### 5.2 Status update (delivered / read)

Disparado cuando Baileys confirma entrega o lectura del mensaje enviado.

```json
{
  "object": "whatsapp_business_account",
  "entry": [{
    "id": "{WABA_ID}",
    "changes": [{
      "value": {
        "messaging_product": "whatsapp",
        "metadata": { ... },
        "statuses": [{
          "id": "wamid.sim_{uuid}",
          "recipient_id": "51999000001",
          "status": "delivered",        // o "read"
          "timestamp": "1710000001",
          "conversation": {
            "id": "sim_conv_{uuid}",
            "expiration_timestamp": "1710086400",
            "origin": { "type": "service" }
          },
          "pricing": {
            "billable": false,           // siempre false en simulador
            "pricing_model": "CBP",
            "category": "service"
          }
        }]
      },
      "field": "messages"
    }]
  }]
}
```

### 5.3 Firma HMAC

Meta firma cada webhook con `X-Hub-Signature-256`. El simulador hace lo mismo usando `APP_SECRET` configurado, para que la plataforma pueda validar autenticidad desde el día 1.

```typescript
const signature = crypto
  .createHmac('sha256', process.env.APP_SECRET)
  .update(rawBody)
  .digest('hex');
headers['X-Hub-Signature-256'] = `sha256=${signature}`;
```

---

## 6. Templates hardcodeados

Solo un template para el MVP — el de reapertura post-24h. Definido en `templates.ts`:

```typescript
export const TEMPLATES: Template[] = [
  {
    id: 'sim_template_001',
    name: 'reopen_conversation',
    status: 'APPROVED',
    category: 'UTILITY',
    language: 'es',
    components: [
      {
        type: 'BODY',
        text: 'Hola {{1}}, vimos que tu consulta fue cerrada. ¿Pudimos ayudarte? Si necesitas algo más, escríbenos.',
        paramCount: 1
      }
    ]
  }
];

// Resolver template con parámetros
export function resolveTemplate(name: string, params: string[]): string {
  const template = TEMPLATES.find(t => t.name === name);
  if (!template) throw new Error(`Template not found: ${name}`);
  
  let body = template.components.find(c => c.type === 'BODY')?.text ?? '';
  params.forEach((param, i) => {
    body = body.replace(`{{${i + 1}}}`, param);
  });
  return body;
}
```

---

## 7. Configuración

```env
# .env

# Puerto del servidor REST
PORT=3001

# Baileys
PHONE_NUMBER=51999000000        # número que va a usar el simulador

# Compatibilidad Meta
PHONE_NUMBER_ID=sim_pnid_001
WABA_ID=sim_waba_001
ACCESS_TOKEN=sim_access_token   # token que la plataforma debe enviar en Authorization

# Webhook hacia la plataforma
CALLBACK_URL=http://help-platform:8080/webhooks/whatsapp
VERIFY_TOKEN=help_verify_secret_2024
APP_SECRET=help_app_secret_2024

# Media
MEDIA_DIR=./media
MEDIA_MAX_SIZE_MB=100
```

---

## 8. Comportamiento de reconexión

Baileys puede perder la sesión. El simulador debe:

1. Guardar credenciales en `./auth_info/` (Baileys lo hace por defecto)
2. Al perder conexión → retry automático con backoff exponencial (máx 5 intentos)
3. Si la sesión expira (QR necesario) → loggear error y exponer endpoint de health que retorne `503`

```
GET /health
```

```json
// Sesión activa
{ "status": "ok", "session": "connected", "phone": "51999000000" }

// Sin sesión
{ "status": "error", "session": "disconnected", "reason": "qr_required" }
```

---

## 9. Stack técnico

| Capa | Tecnología | Razón |
|---|---|---|
| Runtime | Node.js 20 LTS | Baileys es Node nativo |
| Framework HTTP | Express 4 | Minimalista, suficiente |
| WhatsApp | @whiskeysockets/baileys | Librería activa, usada por openclaw |
| Lenguaje | TypeScript | Tipado del contrato API = spec ejecutable |
| Persistencia estado | JSON file (`state.json`) | Simple, sin dependencias externas |
| Media storage | Sistema de archivos local (`./media/`) | MVP — suficiente |

---

## 10. Decisiones de arquitectura (ADR)

| ID | Decisión | Razón |
|---|---|---|
| ADR-S01 | Un solo endpoint `POST /{phone-number-id}/messages` para todos los tipos | Paridad total con Meta. La plataforma no necesita saber el tipo antes de enviar. |
| ADR-S02 | Error code `131026` idéntico al de Meta para ventana expirada | La plataforma maneja errores por código. Si el código cambia entre simulador y Meta, el error handler falla en producción. |
| ADR-S03 | Media se descarga inmediatamente al recibirla (eager, no lazy) | En producción, Meta expira las URLs de media en ~5 minutos. El comportamiento eager fuerza a que la plataforma implemente el flujo correcto. |
| ADR-S04 | Firma HMAC desde el simulador | La plataforma debe validar firmas desde el MVP, no solo en producción. |
| ADR-S05 | Templates en `templates.ts` (código), no en DB ni config externa | Son pocos, cambian raramente, y tener el contrato en TypeScript es la spec ejecutable. |
| ADR-S06 | Estado de ventana 24h en memoria + archivo JSON | No necesita DB para el MVP. Si el simulador reinicia, el archivo preserva el estado. |

---

## 11. Flujo completo: usuario manda imagen → agente responde

```
1. Usuario envía foto en WhatsApp
   │
   ▼
2. Baileys recibe evento message (type: image)
   │
   ├── Simulador descarga binario de WhatsApp Web
   ├── Guarda en ./media/{media-id}.jpg
   ├── Registra en mediaStore
   └── Actualiza lastInboundAt[from] = now()
   │
   ▼
3. Simulador envía webhook a H.E.L.P. Platform
   POST {CALLBACK_URL}
   { ..., "type": "image", "image": { "id": "{media-id}", ... } }
   │
   ▼
4. H.E.L.P. Platform procesa el webhook
   │
   ├── Crea / actualiza ticket
   └── Llama GET /{media-id} al simulador para descargar el binario
   │
   ▼
5. Simulador retorna URL → Plataforma descarga binario → guarda en su storage
   │
   ▼
6. Agente (humano o AI) ve la imagen en su contexto
   Decide responder
   │
   ▼
7. Agente invoca send_message vía MCP
   H.E.L.P. Platform llama POST /{phone-number-id}/messages al simulador
   │
   ├── Simulador valida ventana 24h → OK (mensaje reciente)
   └── Baileys.sendMessage(jid, { text: "..." })
   │
   ▼
8. Simulador recibe ACK de WhatsApp Web
   Envía webhook status "delivered" → H.E.L.P. Platform
   │
   ▼
9. Usuario recibe el mensaje en WhatsApp
```

---

*H.E.L.P. · Helpdesk Event Loop Processor*  
*WhatsApp API Simulator Spec v0.1 — CACSI*
