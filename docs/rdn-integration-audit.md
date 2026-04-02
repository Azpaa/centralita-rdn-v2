# Integración Centralita ↔ RDN — Auditoría Completa y Arquitectura

> **Fecha**: Junio 2025  
> **Sistema**: Centralita RDN v2.0  
> **Commit base**: `172fda5` (master)  
> **Autor**: Copilot / Equipo Centralita

---

## 1. Resumen de Entendimiento del Objetivo

### Qué se quiere conseguir

Integración **bidireccional completa** entre la centralita telefónica (Twilio PBX) y el sistema empresarial RDN:

| Dirección | Flujo | Ejemplo |
|---|---|---|
| **RDN → Centralita** | Control y gestión | Crear usuarios, lanzar llamadas, transferir, colgar, cambiar disponibilidad |
| **Centralita → RDN** | Eventos en tiempo real | Llamada entrante, contestada, en espera, transferida, finalizada, agente online/offline |

### Resultado esperado

1. RDN puede **gestionar usuarios** de la centralita (sync bidireccional)
2. RDN puede **controlar llamadas activas** (marcar, colgar, transferir, silenciar, poner en espera)
3. RDN recibe **eventos en tiempo real** de todo lo que pasa en la centralita
4. RDN puede **consultar historial de llamadas** y grabaciones
5. **Documentación completa** para que el equipo RDN implemente su lado

---

## 2. Auditoría del Sistema Actual

### 2.1 Stack Tecnológico

| Componente | Tecnología | Versión |
|---|---|---|
| Framework | Next.js (App Router) | 16.2.0 |
| Frontend | React + Tailwind + shadcn/ui | 19.2.4 / v4 / v4 |
| Base de datos | Supabase (PostgreSQL) | - |
| Auth | Supabase Auth (email/password) | @supabase/ssr 0.9.0 |
| Telefonía | Twilio (Voice SDK + REST) | twilio 5.13.0 / @twilio/voice-sdk 2.18 |
| Producción | nginx 1.24.0 + Cloudflare Tunnel | - |
| URL | https://centralita.reparacionesdelnorte.es | - |

### 2.2 Esquema de Base de Datos (10 tablas, 7 enums)

```
users              → auth_id, email(unique), role, available, active, rdn_user_id(unique), deleted_at
queues             → name(unique), strategy, ring_timeout, max_wait_time, timeout_action
queue_users        → queue_id→queues, user_id→users, priority. UNIQUE(queue_id,user_id)
schedules          → name(unique), timezone
schedule_slots     → schedule_id→schedules, day_of_week, start_time, end_time
phone_numbers      → twilio_sid(unique), phone_number(unique), queue_id, schedule_id, ooh_action
call_records       → twilio_call_sid(unique), direction, from/to_number, status, timestamps, queue_id
recordings         → twilio_recording_sid(unique), call_record_id→call_records, url, duration
api_keys           → name, key_hash(unique), prefix, active, last_used_at
audit_logs         → action, entity, entity_id, user_id→users, details(jsonb)
```

**Enums PostgreSQL:**
- `user_role`: admin, operator
- `queue_strategy`: ring_all, round_robin
- `timeout_action`: hangup, forward, voicemail, keep_waiting
- `ooh_action`: hangup, forward, voicemail
- `call_direction`: inbound, outbound
- `call_status`: ringing, in_queue, in_progress, completed, no_answer, busy, failed, canceled
- `recording_status`: processing, completed, failed, deleted

### 2.3 API Endpoints Existentes (39 rutas)

#### REST API (`/api/v1/`) — Requieren autenticación (sesión O API key)

| Método | Ruta | Propósito |
|---|---|---|
| GET | `/users` | Listar usuarios (filtros: active, available, rdn_linked, search) |
| POST | `/users` | Crear usuario |
| GET | `/users/:id` | Detalle de usuario |
| PUT | `/users/:id` | Actualizar usuario |
| DELETE | `/users/:id` | Soft-delete usuario |
| PATCH | `/users/:id/activate` | Activar usuario |
| PATCH | `/users/:id/deactivate` | Desactivar usuario |
| PATCH | `/users/:id/availability` | Cambiar disponibilidad |
| POST | `/users/:id/link-rdn` | Vincular con rdn_user_id |
| POST | `/users/match-email` | Buscar usuario por email |
| GET | `/calls` | Listar llamadas (filtros: direction, status, queue_id, from/to_number, dates) |
| GET | `/calls/:id` | Detalle de llamada + grabaciones |
| POST | `/calls/dial` | Iniciar llamada saliente |
| POST | `/calls/transfer` | Transferencia en frío |
| POST | `/calls/conference` | Conferencia (create/add/leave/kick) |
| GET | `/queues` | Listar colas |
| POST | `/queues` | Crear cola |
| GET | `/queues/:id` | Detalle cola |
| PUT | `/queues/:id` | Actualizar cola |
| DELETE | `/queues/:id` | Eliminar cola |
| GET | `/queues/:id/users` | Usuarios de una cola |
| POST | `/queues/:id/users` | Asignar usuario a cola |
| DELETE | `/queues/:id/users/:userId` | Quitar usuario de cola |
| GET | `/schedules` | Listar horarios |
| POST | `/schedules` | Crear horario |
| GET | `/schedules/:id` | Detalle horario |
| PUT | `/schedules/:id` | Actualizar horario |
| DELETE | `/schedules/:id` | Eliminar horario |
| GET | `/phone-numbers` | Listar números |
| PUT | `/phone-numbers/:id` | Actualizar número |
| POST | `/phone-numbers/sync` | Sincronizar con Twilio |
| GET | `/recordings` | Listar grabaciones |
| GET | `/recordings/:id` | Detalle grabación |
| GET | `/token` | Token Twilio Voice SDK |
| GET | `/stats/summary` | Estadísticas resumen |
| GET | `/health` | Health check |

#### Webhooks Twilio (`/api/webhooks/twilio/`) — Validados con firma Twilio

| Ruta | Propósito |
|---|---|
| `/voice/incoming` | Punto de entrada llamadas entrantes |
| `/voice/dial-action` | Resultado de <Dial> (fuente autoritativa) |
| `/voice/queue-retry` | Reintento de cola cuando nadie contesta |
| `/voice/status` | Cambios de estado de llamada |
| `/voice/outbound-connect` | TwiML para llamadas salientes |
| `/voice/transfer-connect` | TwiML para transferencias |
| `/voice/conference-join` | TwiML para unirse a conferencia |
| `/voice/client` | TwiML App para Twilio Client |
| `/voice/whisper` | Whisper a operador antes de conectar |
| `/voice/fallback` | Fallback en caso de error |
| `/voice/voicemail-action` | Acción post-buzón de voz |
| `/recording/status` | Notificación de grabación lista |

### 2.4 Autenticación (3 métodos)

1. **Sesión Supabase** (panel web) — Cookies httpOnly con refresh automático
2. **API Key** (para RDN) — Bearer token → SHA256 hash → lookup en `api_keys`
3. **Firma Twilio** (webhooks) — X-Twilio-Signature validada contra TWILIO_AUTH_TOKEN

### 2.5 Eventos en Tiempo Real

⚠️ **NO EXISTE sistema de eventos en tiempo real hacia sistemas externos.**

El sistema actual usa:
- Polling cada 30 segundos (dashboard frontend)
- Twilio Voice SDK events (solo en el navegador del agente)
- Browser Notifications API (alertas de llamadas entrantes)
- Visibility change listener + keepalive de 5 minutos

**No hay**: WebSockets, SSE, webhooks salientes, Supabase Realtime, ni ningún mecanismo para notificar a RDN.

---

## 3. Gaps Detectados

### 3.1 Clasificación por Capacidad

| Capacidad | Estado | Acción |
|---|---|---|
| CRUD de usuarios | ✅ Válido tal cual | Extender con bulk sync |
| Vinculación RDN ↔ Centralita | ✅ Válido tal cual | Ya existe link-rdn + match-email |
| Auth por API Key | ✅ Válido tal cual | Ya existe y funciona |
| Listar/filtrar llamadas | ✅ Válido tal cual | - |
| Detalle llamada + grabaciones | ✅ Válido tal cual | - |
| Iniciar llamada saliente | ✅ Válido tal cual | Ya existe /calls/dial |
| Transferencia en frío | ✅ Válido tal cual | Ya existe /calls/transfer |
| Conferencia 3 vías | ✅ Válido tal cual | Ya existe /calls/conference |
| Disponibilidad de agente | ✅ Válido tal cual | Ya existe /users/:id/availability |
| Eventos → RDN (webhooks) | ❌ No existe | **Construir desde cero** |
| Colgar llamada remoto | ❌ No existe | **Construir desde cero** |
| Hold/Unhold remoto | ❌ No existe | **Construir desde cero** |
| Mute/Unmute remoto | ❌ No existe | **Construir desde cero** |
| Bulk sync de usuarios | ❌ No existe | **Construir desde cero** |
| Gestión de webhook subs | ❌ No existe | **Construir desde cero** |
| Role-based auth | ⚠️ Requiere adaptación | authenticate() no verifica role |
| middleware.ts | ⚠️ Requiere adaptación | proxy.ts existe pero no middleware.ts |
| CORS | ⚠️ Requiere adaptación | next.config.ts vacío |
| CallStatus enum | ⚠️ Requiere adaptación | Faltan 'forwarded' y 'voicemail' |
| Input sanitization | ⚠️ Requiere adaptación | ilike sin escape de wildcards |

### 3.2 Bugs Críticos para la Integración

1. **No existe `src/middleware.ts`**: `proxy.ts` exporta la función y matcher pero Next.js requiere `middleware.ts` en raíz de `src/` o proyecto. Sin esto, el proxy de autenticación web NO se ejecuta. Las APIs sí funcionan porque tienen su propio `authenticate()`.

2. **CallStatus enum incompleto**: `dial-action` y `queue-retry` escriben `'forwarded'` y `'voicemail'` como status, pero estos valores NO están en el enum `call_status` de PostgreSQL. Esto causa errores silenciosos de DB.

3. **Sin autorización por rol**: `authenticate()` verifica que hay sesión o API key válida pero NUNCA verifica el rol del usuario. Cualquier usuario autenticado (incluido un operador) puede hacer cualquier operación admin.

4. **getTwilioClient duplicado**: Definido en `src/lib/twilio/client.ts` Y en `src/lib/api/twilio-auth.ts`. Esto no causa bug pero es confuso.

---

## 4. Arquitectura Objetivo

### 4.1 Diagrama de Flujo

```
┌─────────────┐      REST API (Bearer API Key)      ┌──────────────────┐
│             │ ──────────────────────────────────── → │                  │
│   Sistema   │                                       │    Centralita    │
│    RDN      │ ← ──────────────────────────────────  │   (Next.js +    │
│             │      Webhooks HTTP POST (eventos)     │    Supabase +    │
└─────────────┘                                       │     Twilio)      │
                                                      └──────────────────┘
                                                             ↕
                                                      ┌──────────────────┐
                                                      │   Twilio Cloud   │
                                                      └──────────────────┘
```

### 4.2 Comunicación M2M

| Canal | Dirección | Protocolo | Auth |
|---|---|---|---|
| REST API | RDN → Centralita | HTTPS + JSON | Bearer API Key |
| Webhooks | Centralita → RDN | HTTPS POST + JSON | HMAC-SHA256 signature |

### 4.3 Nuevas Tablas

```sql
-- Suscripciones de webhook (RDN registra sus endpoints)
webhook_subscriptions (
  id uuid PK,
  url text NOT NULL,                    -- https://rdn.example.com/webhooks/centralita
  secret text NOT NULL,                 -- Secreto para firmar payloads (HMAC-SHA256)
  events text[] NOT NULL,               -- Array de eventos: ['call.*', 'agent.*']
  active boolean DEFAULT true,
  api_key_id uuid → api_keys,          -- Vinculada a la API key que la creó
  created_at timestamptz,
  updated_at timestamptz
)

-- Log de entregas de webhook (para debugging y retry)
webhook_delivery_log (
  id uuid PK,
  subscription_id uuid → webhook_subscriptions,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  response_status integer,
  response_body text,
  attempts integer DEFAULT 0,
  next_retry_at timestamptz,
  delivered boolean DEFAULT false,
  created_at timestamptz
)
```

### 4.4 Catálogo de Eventos

| Evento | Cuándo se emite | Datos incluidos |
|---|---|---|
| `call.incoming` | Llamada entrante recibida | call_sid, from, to, queue_id, phone_number_id |
| `call.ringing` | Sonando a operador(es) | call_sid, operators[] |
| `call.answered` | Operador contestó | call_sid, answered_by_user_id, wait_time |
| `call.completed` | Llamada finalizada | call_sid, duration, status, recording_url |
| `call.missed` | Nadie contestó (timeout) | call_sid, queue_id, waited_seconds |
| `call.transferred` | Transferida a otro destino | call_sid, from_agent, to_destination |
| `call.hold` | Puesta en espera | call_sid, by_user_id |
| `call.resumed` | Sacada de espera | call_sid, by_user_id |
| `agent.online` | Agente se conectó al panel | user_id, rdn_user_id |
| `agent.offline` | Agente se desconectó | user_id, rdn_user_id |
| `agent.available` | Agente marcó disponible | user_id, rdn_user_id |
| `agent.unavailable` | Agente marcó no disponible | user_id, rdn_user_id |
| `agent.busy` | Agente en llamada | user_id, rdn_user_id, call_sid |
| `recording.ready` | Grabación disponible | recording_id, call_sid, url, duration |

---

## 5. Diseño de APIs Nuevas

### 5.1 Gestión de Webhooks

```
POST   /api/v1/webhooks          → Crear suscripción
GET    /api/v1/webhooks          → Listar suscripciones
GET    /api/v1/webhooks/:id      → Detalle suscripción
PUT    /api/v1/webhooks/:id      → Actualizar suscripción
DELETE /api/v1/webhooks/:id      → Eliminar suscripción
POST   /api/v1/webhooks/:id/test → Enviar evento de prueba
```

### 5.2 Control Remoto de Llamadas

```
POST   /api/v1/calls/:callSid/hangup   → Colgar llamada
POST   /api/v1/calls/:callSid/hold     → Poner en espera
POST   /api/v1/calls/:callSid/resume   → Sacar de espera
POST   /api/v1/calls/:callSid/mute     → Silenciar
POST   /api/v1/calls/:callSid/unmute   → Activar audio
```

### 5.3 Sync de Usuarios Masivo

```
POST   /api/v1/users/bulk-sync   → Sync batch de usuarios RDN
GET    /api/v1/users/sync-status  → Estado último sync
```

### 5.4 Firma de Webhooks (Centralita → RDN)

Cada webhook enviado por la centralita incluye cabeceras:

```
X-Centralita-Signature: sha256=HMAC(payload, subscription.secret)
X-Centralita-Event: call.answered
X-Centralita-Delivery-Id: uuid
X-Centralita-Timestamp: ISO8601
```

RDN verifica: `HMAC-SHA256(raw_body, secret) === X-Centralita-Signature.split('=')[1]`

---

## 6. Plan de Implementación

### Fase 0: Correcciones Fundacionales (antes de integración)

1. ✅ Crear `src/middleware.ts`
2. ✅ Añadir `forwarded` y `voicemail` al enum `call_status`
3. ✅ Añadir CORS en `next.config.ts`
4. ✅ Añadir autorización por rol
5. ✅ Sanitizar inputs ilike

### Fase 1: Sistema de Eventos (prioridad máxima)

1. ✅ Crear tablas `webhook_subscriptions` + `webhook_delivery_log`
2. ✅ Crear `src/lib/events/emitter.ts` (motor de emisión)
3. ✅ Crear `src/lib/events/delivery.ts` (entrega con retry)
4. ✅ Integrar emisión en webhooks Twilio existentes
5. ✅ Integrar emisión en cambios de disponibilidad
6. ✅ CRUD de suscripciones webhook

### Fase 2: Control Remoto de Llamadas

1. ✅ Endpoint hangup
2. ✅ Endpoint hold / resume
3. ✅ Endpoint mute / unmute

### Fase 3: Sync de Usuarios Mejorado

1. ✅ Endpoint bulk-sync
2. ✅ Endpoint sync-status

---

## 7. Riesgos y Mitigaciones

| Riesgo | Impacto | Mitigación |
|---|---|---|
| Webhook delivery falla (RDN down) | Eventos perdidos | Retry exponencial (3 intentos: 10s, 60s, 300s) + log persistente |
| API Key comprometida | Acceso no autorizado | Rate limiting, rotación de keys, IP whitelist (futuro) |
| Hold/Mute via REST no sincroniza UI | Estado inconsistente | Emitir eventos que el widget escucha vía polling mejorado |
| Bulk sync sobrecarga DB | Latencia | Límite 100 usuarios/batch, transacciones |
| Enum migration en producción | Downtime | ALTER TYPE es non-blocking en PostgreSQL |

---

## 8. Checklist de Validación

- [ ] `middleware.ts` redirige correctamente a /login
- [ ] API Keys permiten acceso a todos los endpoints REST
- [ ] Webhooks se envían cuando se contesta una llamada
- [ ] Webhooks se envían cuando un agente cambia disponibilidad
- [ ] POST /calls/:sid/hangup cuelga la llamada correctamente
- [ ] POST /calls/:sid/hold pone la llamada en espera
- [ ] POST /users/bulk-sync crea/actualiza usuarios correctamente
- [ ] Firma HMAC-SHA256 se puede verificar desde RDN
- [ ] Retry de webhooks funciona cuando RDN no responde
- [ ] CORS permite requests desde el dominio de RDN
- [ ] Roles: operador no puede crear/eliminar usuarios
- [ ] CallStatus 'forwarded' y 'voicemail' se guardan sin error
