# Análisis: TDD y precauciones anti-ban para fix LID

> APE State: **ANALYZE**  
> Complemento a: [01-lid-problem.md](01-lid-problem.md)

---

## Estrategia TDD

### Principio: todo el fix es testeable offline

El `LIDMappingStore` de Baileys es una dependencia externa con I/O (lee archivos,
conecta WebSocket). **No lo usamos en tests.** Lo que testeamos:

1. **La lógica de resolución** — dado un JID, ¿produce el phone correcto?
2. **Los fallbacks** — si el mapping no existe, ¿retorna el raw user?
3. **La integración** — el inbound flow registra el phone correcto en `lastInboundAt`.

Baileys nunca se instancia en tests. Ya tenemos ese patrón establecido
en `session.test.ts` (mock completo del módulo).

### Ciclo RED → GREEN → REFACTOR

#### Paso 1 — Tests RED para `resolvePhoneFromJid`

Escribir tests para un helper puro:

```typescript
// src/__tests__/baileys/jid-resolver.test.ts

describe('resolvePhoneFromJid', () => {
  // --- Phone-based JIDs (no resolution needed) ---
  
  it('returns phone number from standard JID', async () => {
    // "51903429745@s.whatsapp.net" → "51903429745"
  });

  it('strips device suffix from phone JID', async () => {
    // "51903429745:0@s.whatsapp.net" → "51903429745"
  });

  // --- LID-based JIDs (need resolution) ---
  
  it('resolves LID to phone number via mapping store', async () => {
    // "48915483205670@lid" + mock store returns "51903429745@s.whatsapp.net"
    // → "51903429745"
  });

  it('strips device suffix from resolved phone', async () => {
    // "48915483205670:0@lid" + mock store returns "51903429745:0@s.whatsapp.net"
    // → "51903429745"
  });

  // --- Fallbacks ---
  
  it('returns raw LID user when mapping store is null', async () => {
    // "48915483205670@lid" + lidStore = null → "48915483205670"
  });

  it('returns raw LID user when getPNForLID returns null', async () => {
    // "48915483205670@lid" + mock store returns null → "48915483205670"
  });

  // --- Edge cases ---
  
  it('handles group JIDs unchanged', async () => {
    // "120363123456789@g.us" → "120363123456789"
  });

  it('handles undefined/null JID gracefully', async () => {
    // undefined → undefined
  });
});
```

**Mock del LIDMappingStore:** solo necesitamos mockear `getPNForLID`:

```typescript
const mockLidStore = {
  getPNForLID: vi.fn(async (lid: string) => '51903429745@s.whatsapp.net'),
};
```

No necesitamos mockear toda la clase — solo la interfaz que consumimos.

#### Paso 2 — Implementar `resolvePhoneFromJid` → GREEN

```typescript
// src/baileys/jid-resolver.ts

interface LidResolver {
  getPNForLID(lid: string): Promise<string | null>;
}

async function resolvePhoneFromJid(
  jid: string | undefined,
  lidResolver: LidResolver | null,
): Promise<string | undefined> {
  // ... implementación
}
```

El helper recibe una **interfaz mínima** (`LidResolver`), no el `LIDMappingStore`
completo. Esto permite:
- Mockear trivialmente en tests
- No acoplar a Baileys internals
- Inyectar desde `BaileysSession` en producción

#### Paso 3 — Tests RED para integración en `main.ts`

El inbound flow en `main.ts` usa `msg.key?.remoteJid`. Ahora necesita
acceso al `LidResolver`. Opciones:

**Opción 3a — Exponer desde BaileysSession:**

```typescript
// session.ts agrega:
asLidResolver(): LidResolver | null {
  if (!this.sock) return null;
  return this.sock.signalRepository.lidMapping;
}
```

**Opción 3b — Callback en BaileysSessionConfig:**

```typescript
// BaileysSessionConfig agrega:
onInboundMessage: (message: any, lidResolver: LidResolver | null) => void;
```

Y en `session.ts`, al llamar `onInboundMessage`, pasa el lidMapping:

```typescript
this.config.onInboundMessage(msg, this.sock?.signalRepository?.lidMapping ?? null);
```

**Recomendación: Opción 3b** — menos acoplamiento. El callback ya recibe
todo lo que necesita. `main.ts` no necesita conocer `session.sock`.

Tests para esto: ya cubiertos por los tests unitarios del helper +
test del mock en `session.test.ts` que verifica que `onInboundMessage`
se llama con el argumento correcto.

#### Paso 4 — Tests para event-normalizer

`normalizeInboundMessage` recibe `waMessage` con `remoteJid`. Actualmente
extrae el phone con `phoneFromJid()` (su helper privado que hace `.replace`).

Dos opciones:
- **A)** Resolver en `main.ts` antes de llamar a `normalizeInboundMessage` y pasar
  el phone resuelto como parámetro extra.
- **B)** Pasar el `lidResolver` a `normalizeInboundMessage` y que resuelva internamente.

**Recomendación: A** — resolver en `main.ts` y pasar el phone como override.
`event-normalizer` es una función pura hoy (sin async). Hacerla async por
un caso de LID rompe su naturaleza. Mejor que `main.ts` resuelva y le pase
el phone ya limpio.

Test existente de event-normalizer: no cambia (sigue recibiendo phones normales).
Test nuevo: verificar que el override de `from` se usa correctamente.

---

## Inventario de cambios (scope del fix)

| Archivo | Cambio | Tests |
|---|---|---|
| `src/baileys/jid-resolver.ts` | **NUEVO** — helper `resolvePhoneFromJid` | `jid-resolver.test.ts` — 7+ tests |
| `src/baileys/session.ts` | Pasar `lidMapping` al callback `onInboundMessage` | `session.test.ts` — 1-2 tests nuevos |
| `src/main.ts` | Usar `resolvePhoneFromJid` antes de `recordInbound` y `normalizeInboundMessage` | (cubierto por unit tests del helper) |
| `src/baileys/event-normalizer.ts` | Aceptar `from` override opcional | `event-normalizer.test.ts` — 1-2 tests nuevos |

**No cambian:** `simulator-state.ts`, `messages.route.ts`, `templates.ts`.

---

## Precauciones anti-ban

### Contexto: por qué wa_api es riesgoso

WhatsApp detecta:
- Múltiples conexiones/reconexiones rápidas desde la misma cuenta
- Envío a JIDs inválidos o inexistentes
- Patrones de envío automatizado (ráfagas, sin interacción humana)
- Uso de clientes no oficiales (Baileys se detecta por el user agent)

### Precaución 1 — Tests 100% offline (CERO conexiones a WhatsApp)

Todo el fix de LID se testea con mocks. Los tests:
- **NO** instancian `BaileysSession` con conexión real
- **NO** hacen `makeWASocket` — el módulo está mockeado
- **NO** leen archivos reales de `auth_info_baileys`
- **NO** envían mensajes a WhatsApp

`npm test` es completamente seguro. Nunca toca la red.

### Precaución 2 — Deploy con prueba controlada

Cuando el fix esté listo y pase todos los tests locales:

1. **Redeploy solo s1** (s2 está bloqueado/detenido, no tocarlo).
2. **No enviar mensajes por 5 minutos** después del redeploy.
3. **Primera prueba: health check** — verificar que s1 sigue conectado.
4. **Segunda prueba: recibir un mensaje** (que alguien escriba al número de s1).
   - Verificar en logs que `recordInbound` registra phone, no LID.
5. **Tercera prueba: enviar texto** (no template) al phone que escribió.
   - Si `isWithin24hWindow` retorna true → fix funciona.
6. **Esperar 1 hora** antes de probar envío desde s2.

### Precaución 3 — Restart policy más segura

Actualmente los docker-compose usan `restart: unless-stopped`. Si Baileys
crashea por 401 (ban), Docker lo reinicia infinitamente, empeorando el ban.

**Fix paralelo** (puede ir en el mismo deploy):

```yaml
# docker-compose.yml de cada sim
restart: on-failure
deploy:
  restart_policy:
    max_attempts: 3
```

O mejor: que `session.ts` detecte `statusCode=401` y entre en modo sleep
(log error, no reintentar) en vez de lanzar excepción que mata el proceso.

### Precaución 4 — No enviar a JIDs no verificados

El fix de LID resuelve el lado inbound (recepción → tracking). Para outbound,
`sendTextMessage` ya funciona con `phone@s.whatsapp.net` — Baileys resuelve.

Pero como medida extra, podríamos validar que `to` en `messages.route.ts`
es un número de teléfono real (regex de dígitos, 10-15 chars) y no un LID
accidental. Esto previene envíos a JIDs malformados.

**Scope:** esto es un nice-to-have, no parte del fix crítico.

### Precaución 5 — Delay entre sims para tests manuales

El `test-send-message.ps1` dispara desde ambos sims en secuencia rápida.
Agregar un `Start-Sleep -Seconds 5` entre sims. Ya documentado en
`alerta-bloqueo.md` (L2), pero falta aplicarlo al script.

---

## Orden de ejecución TDD

```
1. jid-resolver.test.ts    → RED   (7 tests fallan)
2. jid-resolver.ts          → GREEN (helper implementado)
3. session.test.ts           → RED   (2 tests nuevos para lidMapping en callback)
4. session.ts                → GREEN (pasar lidMapping al callback)
5. event-normalizer.test.ts  → RED   (1-2 tests para from override)
6. event-normalizer.ts       → GREEN (aceptar from override)
7. main.ts                   → integrar todo
8. npm test                  → 88 tests existentes + ~10 nuevos → ALL GREEN
9. npm run build             → build limpio
10. Deploy s1 → prueba controlada
```

---

## Resumen

| Aspecto | Decisión |
|---|---|
| TDD viable? | **Sí** — todo el fix es lógica pura + interfaz mínima, sin I/O |
| Mock de Baileys | Interfaz `LidResolver { getPNForLID }` — trivial de mockear |
| Conexiones reales | **Cero** en tests. Solo en deploy final |
| Riesgo de ban en tests | **Nulo** — `npm test` es 100% offline |
| Riesgo de ban en deploy | **Bajo** — s1 ya está conectado, solo rebuild + restart |
| Scope | 1 archivo nuevo + 3 modificados + ~10 tests nuevos |
| Tests existentes | No se rompen — cambios son backward-compatible |
