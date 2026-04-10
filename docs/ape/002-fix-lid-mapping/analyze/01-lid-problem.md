# Análisis: LID (Linked ID) mapping en wa_api

> APE State: **ANALYZE**  
> Contexto: Descubierto durante deploy (issue 001) — mensajes de texto fallan, solo templates funcionan.

---

## Problema

WhatsApp migró de usar números de teléfono como identificadores internos a usar **LIDs** (Linked IDs). Cuando un contacto envía un mensaje, Baileys recibe `remoteJid` como `48915483205670@lid` en vez de `51903429745@s.whatsapp.net`.

wa_api no maneja esta distinción: almacena LIDs donde debería almacenar phones, y construye JIDs inválidos al enviar.

**Resultado:** los mensajes de texto fallan con error `131026` (ventana no encontrada) incluso cuando el contacto acaba de escribir. Los templates funcionan por coincidencia (bypasean la ventana), no porque el JID esté bien construido.

---

## Flujo actual (roto)

```
1. INBOUND: contacto envía mensaje
   remoteJid = "48915483205670@lid"              ← LID, no phone
   
2. main.ts extrae "from":
   from = remoteJid.replace(/@.*/, '')
   from = "48915483205670"                       ← LID sin dominio
   
3. state.recordInbound("48915483205670", now)     ← guarda con key = LID
   
4. event-normalizer.ts → webhook payload:
   from = phoneFromJid("48915483205670@lid")
   from = "48915483205670"                       ← LID en el webhook (debería ser phone)

5. OUTBOUND: API recibe POST /{pnid}/messages { to: "51903429745" }
   
6. messages.route.ts:
   state.isWithin24hWindow("51903429745")        ← busca "51903429745"
   → lastInboundAt["51903429745"] = undefined    ← no existe, key es "48915483205670"
   → return false → ERROR 131026
   
7. Incluso si bypaseamos la ventana:
   session.sendTextMessage("51903429745")
   jid = "51903429745@s.whatsapp.net"            ← OK para PN, ¿pero Baileys lo resuelve?
```

---

## Puntos de fallo (3)

### F1 — `recordInbound` guarda LID como key

**Archivo:** `src/main.ts` líneas 37-40

```typescript
const from = msg.key?.remoteJid?.replace(/@.*/, '');
if (from) {
  state.recordInbound(from, Date.now());
}
```

El `remoteJid` puede ser `48915483205670@lid` o `51903429745@s.whatsapp.net`. El `.replace(/@.*/, '')` los strip a ambos, pero **no distingue entre LID y phone**. Si llega un LID, guarda `"48915483205670"` como key.

### F2 — `isWithin24hWindow` busca por phone, pero key es LID

**Archivo:** `src/state/simulator-state.ts` línea 37

```typescript
isWithin24hWindow(phone: string, now: number = Date.now()): boolean {
  const lastTimestamp = this.lastInboundAt[phone];
  ...
}
```

La API REST recibe `to: "51903429745"` (un phone), pero `lastInboundAt` tiene `"48915483205670"` (un LID). **Mismatch → siempre false → error 131026.**

### F3 — `sendTextMessage` construye JID incorrecto para LIDs

**Archivo:** `src/baileys/session.ts` línea 139

```typescript
const jid = `${phoneNumber}@s.whatsapp.net`;
```

Si `phoneNumber` fuera un LID (hipotético), construiría `48915483205670@s.whatsapp.net` que es un JID inválido. Pero  en la práctica, el API REST siempre recibe phone numbers reales (ej: `51903429745`), así que este punto es menos urgente — Baileys **sí puede enviar** a `phone@s.whatsapp.net` y resolver internamente.

---

## ¿Por qué los templates funcionaron?

Los templates en `messages.route.ts` (línea 53+) **no llaman** a `isWithin24hWindow()`. Van directo a `sendTextMessage()` con el phone number del request. Baileys resuelve el envío a `51903429745@s.whatsapp.net` correctamente porque tiene el mapping LID↔PN en `auth_info_baileys/`.

Es decir: **el envío funciona**. Lo que está roto es la **ventana de 24h** y el **webhook payload**.

---

## API disponible en Baileys v7

Baileys ya gestiona los LID mappings internamente:

### Almacenamiento automático

`useMultiFileAuthState` persiste los mappings como archivos JSON:
- `lid-mapping-51903429745.json` → `"48915483205670"` (phone → LID user)
- `lid-mapping-48915483205670_reverse.json` → `"51903429745"` (LID → phone user)

Estos se crean automáticamente cuando Baileys procesa mensajes entrantes.

### LIDMappingStore (accesible desde el socket)

```typescript
// Acceso:
sock.signalRepository.lidMapping: LIDMappingStore

// Métodos:
await sock.signalRepository.lidMapping.getPNForLID("48915483205670@lid")
// → "51903429745@s.whatsapp.net"

await sock.signalRepository.lidMapping.getLIDForPN("51903429745@s.whatsapp.net")
// → "48915483205670@lid"
```

### Utilidades de JID

```typescript
import { isLidUser, isPnUser, jidDecode } from '@whiskeysockets/baileys'

isLidUser("48915483205670@lid")            // → true
isPnUser("51903429745@s.whatsapp.net")     // → true
jidDecode("48915483205670@lid")            // → { user: "48915483205670", server: "lid" }
```

### Tipo LIDMapping

```typescript
type LIDMapping = {
  pn: string;  // "51903429745@s.whatsapp.net"
  lid: string; // "48915483205670@lid"
};
```

---

## Opciones de solución

### Opción A — Resolver LID → phone en `recordInbound`

Al recibir un mensaje inbound, si `remoteJid` es un LID, usar `getPNForLID()` para convertir a phone antes de guardar.

```
Inbound: remoteJid = "48915483205670@lid"
  → getPNForLID("48915483205670@lid") → "51903429745@s.whatsapp.net"
  → recordInbound("51903429745", now)
```

**Ventajas:**
- Fix mínimo: solo cambia un punto (main.ts)
- `isWithin24hWindow("51903429745")` funciona sin cambios
- `sendTextMessage("51903429745")` funciona sin cambios
- El webhook payload también se corrige (event-normalizer.ts usa el mismo `from`)

**Desventajas:**
- `getPNForLID()` es async — agrega una await al path de inbound
- Si el mapping no existe aún (primera vez que un contacto escribe), `getPNForLID()` podría retornar `null`

### Opción B — Almacenar ambos (LID y phone) en `lastInboundAt`

Guardar dos entries: una con el LID y otra con el phone number resuelto.

**Ventajas:**
- lookup por phone O por LID, ambos funcionan
- Fallback si `getPNForLID()` falla

**Desventajas:**
- Duplica entries en state. Más complejo. Beneficio marginal.

### Opción C — Normalizar en el punto de entrada (crear helper)

Crear un helper `resolvePhoneFromJid(jid, lidStore)` que:
1. Si es `@s.whatsapp.net` → strip dominio, retornar phone
2. Si es `@lid` → `getPNForLID()` → strip dominio, retornar phone
3. Si falla → retornar raw user (fallback)

Usar este helper en `main.ts` y en `event-normalizer.ts`.

**Ventajas:**
- Un solo punto de normalización
- Reutilizable en cualquier lugar que reciba un `remoteJid`
- Fallback graceful si el mapping no existe

**Desventajas:**
- Necesita acceso al `LIDMappingStore` desde fuera de session.ts → requiere exponer `sock.signalRepository.lidMapping`

---

## Análisis de impacto

| Componente | Cambio necesario |
|---|---|
| `session.ts` | Exponer `lidMapping` (o un método `resolvePhone(jid)`) |
| `main.ts` | Usar `resolvePhone()` antes de `recordInbound()` y webhook |
| `event-normalizer.ts` | Recibir phone ya resuelto (no cambia si main.ts resuelve antes) |
| `simulator-state.ts` | Sin cambios |
| `messages.route.ts` | Sin cambios |
| Tests | Agregar tests para resolución LID → phone |

---

## Recomendación

**Opción C** — helper `resolvePhoneFromJid`. Es el fix más limpio:

1. No cambia la interfaz pública de `SimulatorState` ni de las rutas.
2. Un solo lugar donde se resuelve la distinción LID/PN.
3. Fallback seguro si el mapping no existe.
4. La operación async de `getPNForLID()` ocurre una sola vez por mensaje inbound.

El cambio está contenido a:
- **1 archivo nuevo**: helper de resolución (o método en `session.ts`)
- **1 archivo modificado**: `main.ts` (usar el helper al procesar inbound)
- **Tests**: verificar que LIDs se resuelven a phones

---

## Preguntas abiertas

1. **¿Puede `remoteJid` ser un LID en TODOS los mensajes o solo en algunos?**
   Basado en las observaciones, parece que WhatsApp está migrando progresivamente. Algunos mensajes llegan como `@lid`, otros como `@s.whatsapp.net`. El helper debe manejar ambos.

2. **¿Qué pasa si `getPNForLID()` retorna null?**
   El mapping debería existir porque Baileys lo almacena automáticamente al recibir el mensaje (en `decode-wa-message.js`). Pero como medida defensiva, el helper debería usar el raw user como fallback.

3. **¿Necesitamos resolver phone → LID para envío?**
   No por ahora. Baileys acepta `phone@s.whatsapp.net` para enviar y resuelve internamente. Solo necesitamos resolver LID → phone para tracking.
