# H.E.L.P.E.R.
### Helpdesk Event Loop Processor · Event Responder

> *Un único runtime genérico instanciable N veces con diferente configuración.*  
> *El rol es configuración — prompt + tools. El runtime es siempre el mismo.*

---

## ¿Qué es un H.E.L.P.E.R.?

Un H.E.L.P.E.R. es un agente AI que se conecta al sistema [H.E.L.P.](https://github.com/cacsi/help) y responde tickets en nombre de un rol específico. Su nombre lo describe con precisión: es un **Event Responder** — vive en un loop infinito a la espera de eventos, y cuando llega uno, responde.

Un evento es cualquier cambio que activa su FSM: un mensaje nuevo del socio, un ticket recién asignado, el resultado de una llamada al LLM, el resultado de una tool MCP. El H.E.L.P.E.R. no hace nada hasta que llega un evento. Cuando llega, procesa exactamente un paso y vuelve a esperar.

Este repositorio contiene el runtime — el programa que cualquier H.E.L.P.E.R. ejecuta, independientemente de su rol.

---

## El modelo de ejecución

Un H.E.L.P.E.R. implementa un **scheduler cooperativo orientado a eventos** — análogo al scheduler de un sistema operativo de tiempo real.

Cada conversación activa es una **Máquina de Estados Finita (FSM)** persistida en base de datos. El scheduler recorre todas las conversaciones en cada tick y ejecuta exactamente un paso de su FSM. El LLM y las tools MCP son efectos externos asíncronos — el scheduler nunca bloquea esperando su resultado.

```
TICK N:
  conv_001 → AWAIT_LLM   → LLM aún no responde → skip
  conv_002 → IDLE        → sin mensajes nuevos  → skip
  conv_003 → READ        → cargar contexto      → → PROCESSING
  conv_004 → AWAIT_TOOL  → tool respondió       → → PROCESSING
  [polling plataforma cada 6 ticks]
  sleep(500ms)
TICK N+1: ...
```

### Analogía sistema operativo

| Sistema Operativo | H.E.L.P.E.R. |
|---|---|
| Tabla de procesos | `active_conversations` |
| Proceso | Conversación activa (FSM) |
| Scheduler | `agent_loop()` — asyncio |
| Syscall bloqueante | `await llm.complete()` / `await mcp.call()` |
| Quantum de CPU | Un paso de FSM por tick |
| Interrupción | Mensaje nuevo del usuario |
| Proceso nuevo | Ticket asignado por la plataforma |
| Proceso terminado | Ticket resuelto, delegado o escalado |

---

## Principios de diseño

| Principio | Descripción |
|---|---|
| **Un runtime, N roles** | El comportamiento varía por `agent.config.yaml`, no por código. |
| **LLM como efecto externo** | El scheduler nunca bloquea esperando al LLM. |
| **DB propia** | Memoria de largo plazo independiente de la plataforma. El H.E.L.P.E.R. recuerda conversaciones pasadas. |
| **Sin estado crítico en memoria** | Un reinicio recupera el estado completo desde la DB. |
| **LLM client abstracto** | El proveedor (Gemini, Claude, etc.) se configura, no se hardcodea. |
| **Polling, no push** | H.E.L.P. no conoce la existencia del H.E.L.P.E.R. El agente decide cuándo consultar. |

---

## Estructura del repositorio

```
helper/
├── agent.config.yaml            # configuración del rol (el único archivo que cambia por rol)
├── prompts/
│   └── system.md                # system prompt del rol
├── src/
│   └── agent/
│       ├── main.py              # entrypoint — asyncio.gather(scheduler, api)
│       ├── config.py            # carga y valida agent.config.yaml
│       ├── scheduler.py         # event loop principal
│       ├── fsm.py               # ConvFSM + ConvState + engine
│       ├── db/
│       │   ├── client.py        # pool asyncpg
│       │   ├── Tables/          # SQL schema del agente
│       │   ├── StoredProcedures/
│       │   └── Views/
│       ├── llm/
│       │   ├── base.py          # Protocol abstracto (LLMClient)
│       │   ├── tools.py         # definiciones de tools para el LLM
│       │   ├── gemini.py        # Vertex AI + Gemini
│       │   ├── claude_vertex.py # Claude en Vertex AI
│       │   └── claude_direct.py # API Anthropic directa
│       ├── mcp/
│       │   └── client.py        # MCP client → H.E.L.P. Platform
│       └── api/
│           └── server.py        # REST API de estado y config en caliente
├── configs/                     # un directorio por rol desplegado
│   ├── router/
│   │   ├── agent.config.yaml
│   │   └── prompts/system.md
│   ├── credits/
│   │   ├── agent.config.yaml
│   │   └── prompts/system.md
│   └── accounts/
│       ├── agent.config.yaml
│       └── prompts/system.md
├── Dockerfile
├── docker-compose.yml           # on-prem: agent-core + agent-db
├── requirements.txt
└── .env.example
```

---

## FSM de conversación

```
IDLE ──(mensaje nuevo)──► READ ──► PROCESSING ──► AWAIT_LLM
  ▲                                                    │
  │                                          ┌─────────┴──────────┐
  │                                      tool_call           text / acción terminal
  │                                          │                    │
  │                                      CALL_TOOL    RESPOND · DELEGATE · RESOLVE · ESCALATE
  │                                          │                    │
  │                                       AWAIT_TOOL         IDLE / TERMINAL
  │                                          │
  └──────────── (tool result → PROCESSING) ──┘
```

`AWAIT_LLM` y `AWAIT_TOOL` son los estados que hacen el scheduler no bloqueante — mientras el H.E.L.P.E.R. espera al LLM o a una tool, el loop continúa atendiendo las demás conversaciones activas.

---

## Configurar un nuevo rol

Todo el comportamiento de un H.E.L.P.E.R. se define en dos archivos:

**`agent.config.yaml`** — parámetros del runtime:
```yaml
agent:
  id: "credits-001"
  role_name: "Credit Specialist"
  api_key: "${AGENT_API_KEY}"

platform:
  mcp_url: "http://help-mcp:8081"

llm:
  provider: "gemini"
  model: "gemini-2.0-flash"
  system_prompt_file: "./prompts/system.md"
  temperature: 0.2

scheduler:
  tick_ms: 500
  max_active_conversations: 20
  polling_interval_ticks: 6

tools_allowed:
  - get_assigned_tickets
  - get_ticket_messages
  - get_ticket_state
  - claim_ticket
  - send_message
  - resolve_ticket
  - escalate_ticket

database:
  url: "${DATABASE_URL}"

api:
  port: 9000
```

**`prompts/system.md`** — la personalidad y el dominio del agente.

**Desplegar un nuevo H.E.L.P.E.R. = nuevo config + nuevo prompt. Sin código nuevo.**

---

## Stack técnico

| Capa | Tecnología |
|---|---|
| Runtime | Python 3.12 |
| Scheduler | `asyncio` |
| LLM (GCP) | Vertex AI — Gemini / Claude |
| LLM (directo) | Anthropic SDK |
| MCP Client | `httpx` async |
| REST API interna | FastAPI + Uvicorn |
| Base de datos | PostgreSQL 16 · `asyncpg` |
| Orquestación (on-prem) | Docker Compose |
| Deployment (VM dedicada) | systemd |

---

## Inicio rápido

### On-prem (Docker Compose)

```bash
# 1. Clonar
git clone https://github.com/cacsi/helper.git
cd helper

# 2. Configurar
cp .env.example .env
# editar .env: AGENT_API_KEY, DATABASE_URL, GCP_PROJECT_ID

# 3. Levantar H.E.L.P.E.R. + DB
docker compose up -d

# 4. Verificar estado
curl http://localhost:9000/health
```

### VM dedicada (systemd)

```bash
python3.12 -m venv .venv
.venv/bin/pip install -r requirements.txt
sudo cp deploy/helper.service /etc/systemd/system/
sudo systemctl enable helper
sudo systemctl start helper
```

---

## API de estado (puerto 9000)

Observabilidad y configuración en caliente — sin reiniciar el proceso:

```
GET  /health                       → estado del proceso y conexiones
GET  /status                       → conversaciones activas, métricas, utilización
GET  /conversations                → lista de FSMs activas con su estado
GET  /conversations/{ticket_id}    → estado detallado de una conversación
POST /config/reload                → recarga system prompt y parámetros sin reiniciar
POST /conversations/{id}/drop      → forzar salida del loop (emergencia)
```

---

## Memoria del H.E.L.P.E.R.

H.E.L.P. cierra tickets. El H.E.L.P.E.R. **nunca olvida**.

Su base de datos propia guarda el historial completo de todas las conversaciones — activas y cerradas. Cuando un socio vuelve semanas después, el H.E.L.P.E.R. especializado en créditos recuerda todo lo que conversaron antes. Memoria perfecta que ningún humano puede garantizar.

---

## H.E.L.P.E.R.s disponibles en CACSI

| Rol | Responsabilidad |
|---|---|
| **Router** | Clasifica y delega todos los tickets entrantes. Primer punto de contacto. |
| **Créditos** | Consultas sobre préstamos, tasas y refinanciamiento. |
| **Cuentas** | Consultas sobre ahorros, saldos y depósitos. |
| **Pagos** | Consultas sobre transferencias, vouchers y comprobantes. |

---

## Relación con `help`

Un H.E.L.P.E.R. consume el MCP Server expuesto por [`help`](https://github.com/cacsi/help). La relación es unidireccional — el H.E.L.P.E.R. hace polling a H.E.L.P., H.E.L.P. no sabe que el H.E.L.P.E.R. existe.

```
H.E.L.P.E.R. ──polling──► H.E.L.P. MCP Server
```

---

*H.E.L.P.E.R. · Helpdesk Event Loop Processor · Event Responder*  
*CACSI · Cooperativa de Ahorro y Crédito Santa Isabel*
