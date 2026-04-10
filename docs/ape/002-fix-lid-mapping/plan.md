# Plan: Fix LID mapping en wa_api

> APE State: **PLAN**  
> Análisis: [analyze/01-lid-problem.md](analyze/01-lid-problem.md),
>           [analyze/02-tdd-and-safety.md](analyze/02-tdd-and-safety.md)

---

## Problema

WhatsApp usa LIDs (Linked IDs) como `remoteJid` en mensajes entrantes.
wa_api no resuelve LID → phone, causando:
- Ventana 24h rota (guarda LID, busca por phone → mismatch → error 131026)
- Webhook payload con LID en vez de phone number

## Solución

Helper `resolvePhoneFromJid` que normaliza cualquier JID a phone number,
usando `LIDMappingStore.getPNForLID()` de Baileys cuando el JID es un LID.

## Archivos afectados

| Archivo | Acción |
|---|---|
| `src/baileys/jid-resolver.ts` | **Crear** — helper + interfaz `LidResolver` |
| `src/__tests__/baileys/jid-resolver.test.ts` | **Crear** — ~8 tests |
| `src/baileys/session.ts` | **Modificar** — pasar lidMapping al callback |
| `src/__tests__/baileys/session.test.ts` | **Modificar** — verificar 2do argumento |
| `src/baileys/event-normalizer.ts` | **Modificar** — aceptar `resolvedFrom` override |
| `src/__tests__/baileys/event-normalizer.test.ts` | **Modificar** — test con override |
| `src/main.ts` | **Modificar** — usar resolvePhoneFromJid en inbound flow |

**No cambian:** `simulator-state.ts`, `messages.route.ts`, rutas, templates, config.

---

## Pasos (TDD)

### Paso 1 — Test RED: `jid-resolver.test.ts`

Crear `src/__tests__/baileys/jid-resolver.test.ts` con estos tests:

```
describe('resolvePhoneFromJid')
  ✗ returns phone from standard JID (@s.whatsapp.net)
  ✗ strips device suffix from phone JID (:0@s.whatsapp.net)
  ✗ resolves LID to phone via resolver (@lid)
  ✗ strips device suffix from resolved LID (:0@lid)
  ✗ returns raw LID user when resolver is null
  ✗ returns raw LID user when getPNForLID returns null
  ✗ returns group id from group JID (@g.us)
  ✗ returns undefined for undefined input
```

Mock: `{ getPNForLID: vi.fn() }` — solo la interfaz mínima.

**Criterio:** `npm test -- jid-resolver` → 8 tests FAIL (módulo no existe).

### Paso 2 — GREEN: `jid-resolver.ts`

Crear `src/baileys/jid-resolver.ts`:

```typescript
export interface LidResolver {
  getPNForLID(lid: string): Promise<string | null>;
}

export async function resolvePhoneFromJid(
  jid: string | undefined,
  lidResolver: LidResolver | null,
): Promise<string | undefined> {
  // 1. undefined → undefined
  // 2. Extract user y server del JID
  // 3. Si @s.whatsapp.net o @g.us → strip dominio y device, retornar user
  // 4. Si @lid → getPNForLID(jid) → strip dominio y device del resultado
  // 5. Fallback → raw user
}
```

**Criterio:** `npm test -- jid-resolver` → 8 tests PASS.

### Paso 3 — Test RED: `session.test.ts` (lidMapping en callback)

Agregar 2 tests a `session.test.ts`:

```
describe('inbound message callback')
  ✗ passes lidMapping as second argument to onInboundMessage
  ✗ passes null when socket is not connected
```

Actualizar el `MockSocket` para exponer `signalRepository.lidMapping`.

**Criterio:** `npm test -- session` → 2 nuevos FAIL.

### Paso 4 — GREEN: `session.ts`

Modificar `BaileysSessionConfig`:

```typescript
export interface BaileysSessionConfig {
  authDir: string;
  onInboundMessage: (message: any, lidResolver: LidResolver | null) => void;
  onStatusUpdate: (update: any) => void;
}
```

En el handler de `messages.upsert`, pasar el lidMapping:

```typescript
this.config.onInboundMessage(msg, this.sock?.signalRepository?.lidMapping ?? null);
```

Agregar import de `LidResolver` desde `jid-resolver.ts`.

**Criterio:** `npm test -- session` → todos PASS (existentes + 2 nuevos).

### Paso 5 — Test RED: `event-normalizer.test.ts` (from override)

Agregar 2 tests:

```
describe('normalizeInboundMessage with resolvedFrom')
  ✗ uses resolvedFrom instead of remoteJid when provided
  ✗ falls back to remoteJid when resolvedFrom is undefined
```

**Criterio:** `npm test -- event-normalizer` → 2 nuevos FAIL.

### Paso 6 — GREEN: `event-normalizer.ts`

Agregar parámetro opcional `resolvedFrom`:

```typescript
export function normalizeInboundMessage(
  waMessage: any,
  metadata: InboundMetadata,
  mediaId?: string,
  resolvedFrom?: string,    // ← nuevo
): MetaWebhookPayload {
  const from = resolvedFrom ?? phoneFromJid(waMessage.key.remoteJid);
  // ... resto sin cambios
}
```

**Criterio:** `npm test -- event-normalizer` → todos PASS.

### Paso 7 — Integrar en `main.ts`

Modificar el callback `onInboundMessage`:

```typescript
onInboundMessage: async (msg: any, lidResolver: LidResolver | null) => {
  const rawJid = msg.key?.remoteJid;
  const from = await resolvePhoneFromJid(rawJid, lidResolver);

  if (from) {
    state.recordInbound(from, Date.now());
  }

  const payload = normalizeInboundMessage(msg, {
    phoneNumberId: config.phoneNumberId,
    displayPhoneNumber: config.phoneNumber,
    wabaId: config.wabaId,
  }, undefined, from);

  // ... dispatch webhook sin cambios
}
```

**Criterio:** `npm test` → todos los tests PASS (88 existentes + ~12 nuevos).

### Paso 8 — Build y verificación final

```
npm run build   → build limpio, 0 errores
npm test        → ~100 tests PASS
```

### Paso 9 — Deploy controlado a s1

1. Crear tarball, SCP a VM, rebuild container s1.
2. Verificar health: `https://wa-api-s1.cacsi.dev/health` → 200.
3. Verificar que s1 sigue CONNECTED en logs.
4. **Esperar 5 minutos** sin enviar nada.
5. Pedir a alguien que envíe un mensaje al número de s1 (51933182642).
6. Verificar en logs que `recordInbound` registra phone (no LID).
7. Enviar texto (no template) al phone que escribió.
8. Si responde 200 → **fix verificado end-to-end**.

### Paso 10 — Commit

```
git add -A
git commit -m "fix: resolve LID to phone number for 24h window tracking

- Add jid-resolver.ts with resolvePhoneFromJid helper
- Pass lidMapping from BaileysSession to onInboundMessage callback
- Use resolved phone in recordInbound and webhook payload
- Add LidResolver interface (minimal, mockable)
- event-normalizer accepts optional resolvedFrom override
- 12 new tests, all existing tests pass"
```

---

## Criterio de aceptación

| # | Criterio | Verificación |
|:-:|---|---|
| 1 | `resolvePhoneFromJid("48915483205670@lid", store)` → `"51903429745"` | Unit test |
| 2 | `resolvePhoneFromJid("51903429745@s.whatsapp.net", null)` → `"51903429745"` | Unit test |
| 3 | `resolvePhoneFromJid("48915483205670@lid", null)` → `"48915483205670"` (fallback) | Unit test |
| 4 | Inbound message con LID registra phone en `lastInboundAt` | Logs en deploy |
| 5 | `isWithin24hWindow("51903429745")` → `true` después de un inbound con LID | Deploy test |
| 6 | Envío de texto a phone dentro de ventana → 200 OK (no 131026) | Deploy test |
| 7 | Webhook payload contiene phone number en `from`, no LID | Logs en deploy |
| 8 | 88 tests existentes siguen pasando | `npm test` |
| 9 | Build limpio | `npm run build` |

---

## Riesgos y mitigaciones

| Riesgo | Probabilidad | Mitigación |
|---|:-:|---|
| `getPNForLID` retorna null para contacto nuevo | Baja | Fallback a raw user — funciona igual que hoy |
| `signalRepository.lidMapping` no existe en el socket | Baja | Optional chaining (`?.`) + null check |
| Restart de s1 desconecta WhatsApp | Baja | Container rebuild no mata la sesión Baileys (auth persistido en volumen) |
| Ban de s1 durante deploy | Muy baja | Solo rebuild, no envíos hasta verificar. Protocolo de alerta-bloqueo.md |
| Tests existentes rompen por cambio en callback signature | Media | Paso 3-4 actualiza mocks. Signature es backward-compatible (2do arg opcional en JS) |
