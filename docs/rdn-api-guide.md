# Guia contractual de integracion - Centralita <-> RDN

> Version contrato: 2.2
> Estado: Canónico (externo para RDN)
> Base URL: `https://centralita.reparacionesdelnorte.es`
> Formato: JSON sobre HTTPS
> Auth M2M: `Authorization: Bearer ck_...`

## 0. Alcance y documento canónico

Este archivo es el **unico contrato externo** para el equipo RDN.

- Fuente canónica: `docs/rdn-api-guide.md`
- Cualquier otro documento del repo se considera interno/no contractual.

## 1. Modelo de integracion recomendado

Modelo productivo recomendado: **hibrido API + Webhooks + reconciliacion**.

- RDN -> Centralita (comandos/consultas): API REST `/api/v1/*`
- Centralita -> RDN (tiempo casi real): Webhooks firmados
- Reconciliacion: polling periodico de `/api/v1/calls` y `/api/v1/recordings`

No usar acceso directo a tablas de Supabase como contrato de integracion.

## 2. Autenticacion

### 2.1 API REST (RDN -> Centralita)

Cabecera requerida:

```http
Authorization: Bearer ck_xxxxxxxxx
```

Notas:
- Las API keys M2M son tratadas como rol admin en backend.
- Si la key es invalida o esta inactiva: `401 UNAUTHORIZED`.

### 2.2 Webhooks (Centralita -> RDN)

Cada webhook incluye firma HMAC-SHA256:

- `X-Centralita-Signature: sha256=<hex>`
- Secret entregado en `POST /api/v1/webhooks` (solo una vez)

Validar firma sobre el body raw (sin parsear).

## 3. Politica de entrega de eventos

### 3.1 Garantias reales

Entrega: **at-least-once**.

RDN debe asumir:
- Posibles duplicados
- Posible desorden entre eventos
- Reintentos ante timeout o no-2xx

### 3.2 IDs para idempotencia

Cada delivery incluye:

- `delivery_id` (header): estable para la misma entrega y sus reintentos
- `event_id` (payload/header): estable para el evento logico

Cabeceras:

```http
X-Centralita-Event: call.completed
X-Centralita-Event-Id: <uuid>
X-Centralita-Delivery-Id: <uuid>
X-Centralita-Timestamp: 2026-04-03T10:05:30.000Z
```

Recomendacion RDN:
- deduplicar por `delivery_id` (tecnico)
- proteger negocio por `event_id` + `event` + entidad (`call_sid`)

### 3.3 Retries (persistentes)

Estrategia actual:
- Intento inicial inmediato
- Reintentos persistidos en DB (`webhook_delivery_log.next_retry_at`)
- Backoff: `10s`, `60s`, `300s`
- Max intentos por delivery: `4` (1 inicial + 3 retries)
- Auto-desactivacion de suscripcion al llegar a 50 fallos consecutivos

Endpoint operativo para worker/cron:

```http
POST /api/v1/webhooks/retry-deliveries
```

Body opcional:

```json
{ "limit": 100 }
```

Recomendacion operativa: ejecutar este endpoint cada 1 minuto (cron).

## 4. Semantica de IDs (obligatorio)

### 4.1 `call_sid` (Twilio Call SID, prefijo `CA`)

Uso:
- Control operativo en caliente (hangup/hold/resume/mute/unmute/transfer)
- Correlacion en eventos de llamada

### 4.2 `call_record_id` (UUID interno)

Uso:
- Persistencia e historico en DB
- Consultas de detalle por API (`GET /api/v1/calls/{call_record_id}`)
- Correlacion de grabaciones internas

### 4.3 `recording_id` (UUID interno) y `recording_sid` (Twilio `RE...`)

Uso:
- `recording_id`: ID interno de tabla `recordings`
- `recording_sid`: referencia Twilio

### 4.4 Regla practica para RDN

- Para mandar comandos en tiempo real: usar `call_sid`
- Para consultar/guardar historico: usar `call_record_id`
- Para grabaciones: guardar ambos (`recording_id`, `recording_sid`)

## 5. Endpoints contractuales (RDN)

## 5.1 Usuarios

### POST `/api/v1/users/bulk-sync`
Sincronizacion masiva idempotente (max 100 usuarios por batch).

Body:

```json
{
  "users": [
    {
      "rdn_user_id": "rdn-001",
      "name": "Juan Garcia",
      "email": "juan@rdn.com",
      "phone": "+34600000001",
      "role": "operator",
      "active": true,
      "password": "opcional"
    }
  ]
}
```

Notas:
- Si no se envia `password`, se genera temporal.
- En `results`, `_temp_password` solo aparece cuando aplica.

### POST `/api/v1/users/match-email`
Buscar usuario existente por email para vincular.

### POST `/api/v1/users/{user_id}/link-rdn`
Vincular usuario existente con `rdn_user_id`.

### PATCH `/api/v1/users/{user_id}/availability`
Cambiar disponibilidad del agente.
Emite `agent.available` o `agent.unavailable`.

## 5.2 Llamadas salientes y control

### POST `/api/v1/calls/dial`
Inicia llamada saliente.

Body:

```json
{
  "destination_number": "+34612345678",
  "from_number": "+34848819410",
  "user_id": "uuid-del-agente-opcional-pero-recomendado",
  "rdn_user_id": "id-operativo-rdn-opcional",
  "metadata": { "source": "rdn" }
}
```

Notas operativas:
- Si se envia `user_id` o `rdn_user_id`, backend resuelve ownership de agente y crea flujo attach `client:<agent_id>`.
- Fuente en `twilio_data.source`:
  - `rdn` para comandos M2M por API key.
  - `backend_outbound` para comandos iniciados por sesion web (panel), manteniendo backend como motor.

### POST `/api/v1/calls/{call_sid}/hangup`
Cuelga llamada.

Body opcional:

```json
{ "target": "all" }
```

Valores:
- `all` (default): cuelga ambas legs
- `agent`: cuelga solo leg `call_sid`
- `remote`: cuelga solo la otra leg

Control de ownership:
- Session `operator`: solo puede controlar llamadas propias (segun ownership backend).
- Session `admin` y API key M2M: permitido.

### POST `/api/v1/calls/{call_sid}/hold`
Pone en espera la otra leg.

Body opcional:

```json
{ "music_url": "https://.../hold.mp3" }
```

### POST `/api/v1/calls/{call_sid}/resume`
Saca de espera reconectando ambas legs via conferencia efimera.

Body: vacio.

### POST `/api/v1/calls/{call_sid}/mute`
Silencia participante en conferencia.

Body obligatorio:

```json
{ "conference_name": "conf-abc" }
```

No soportado para llamada directa no-conferencia.

### POST `/api/v1/calls/{call_sid}/unmute`
Reactiva audio de participante en conferencia.

Body obligatorio:

```json
{ "conference_name": "conf-abc" }
```

### POST `/api/v1/calls/transfer`
Transferencia en frio.

Body:

```json
{
  "callSid": "CAxxxxxxxx",
  "destination": "+34612345678",
  "callerId": "+34848819410"
}
```

Tambien soporta destino navegador: `"destination": "client:<user_id>"`.

Ownership: mismas reglas de control que en `hangup/hold/resume`.

## 5.5 Estado canonico de agente (web + futuro Tauri)

### GET `/api/v1/agent/me/state`
Estado operativo canonico del agente desde backend (fuente de verdad).

Sesion web:
- usa el agente de la sesion actual.

API key M2M:
- requiere query `?user_id=<uuid>`.

Respuesta (shape resumido):

```json
{
  "user_id": "uuid",
  "active": true,
  "available": true,
  "operational_status": "ready",
  "active_calls_count": 1,
  "active_calls": [
    {
      "call_record_id": "uuid",
      "call_sid": "CAxxxx",
      "status": "in_progress",
      "direction": "outbound",
      "from": "+34...",
      "to": "+34..."
    }
  ],
  "source_of_truth": "backend_call_records",
  "generated_at": "2026-04-07T10:15:00.000Z"
}
```

## 5.6 Stream canonico backend -> clientes (SSE)

### GET `/api/v1/stream/events`
Canal push canonico para clientes web y futuro cliente Tauri.

Formato:
- `Content-Type: text/event-stream`
- Mensajes JSON en `data: ...`

Auth y scope:
- Sesion `operator`: `scope=mine` (solo eventos del agente de sesion).
- Sesion `admin`: `scope=mine` (default), `scope=all` o `user_id=<uuid>`.
- API key M2M: requiere `user_id=<uuid>` para evitar streams globales accidentales.

Eventos canónicos:
- `connected`
- `snapshot` (incluye `agent_state` inicial)
- `incoming_call`
- `call_answered`
- `call_updated`
- `call_ended`
- `call_transfer_completed`
- `conference_updated` (reservado para acciones de conferencia)
- `agent_state_changed`
- `recording_ready`
- `heartbeat`

Shape base de evento:

```json
{
  "id": "uuid",
  "type": "call_updated",
  "timestamp": "2026-04-07T10:40:00.000Z",
  "domain_event": "call.hold",
  "call_sid": "CAxxxx",
  "agent_user_id": "uuid-agente",
  "target_user_ids": ["uuid-agente"],
  "payload": { "..." : "..." }
}
```

## 5.7 Voice Agent Desktop (bootstrap + releases)

### GET `/api/v1/voice-agent/bootstrap`
Config pública para cliente desktop (Tauri):
- base URL backend
- rutas canónicas (`stream/events`, `agent/me/state`, comandos de llamada)
- config pública de Supabase (`supabase_url`, `supabase_anon_key`)
- URLs de distribución y releases

### GET `/api/v1/voice-agent/releases/latest`
Devuelve manifest JSON de la última release desktop
(fuente: `apps/voice-agent-tauri/releases/latest.json`).

### Descargas web
- Índice: `/voice-agent/download`
- Artefactos públicos: `/downloads/voice-agent/...`

## 5.3 Consultas de historico

### GET `/api/v1/calls`
Lista llamadas (filtros por estado, direccion, fechas, numeros, etc.).

### GET `/api/v1/calls/{call_record_id}`
Detalle de llamada + grabaciones + usuario que atendio.

### GET `/api/v1/recordings`
Lista grabaciones.

### GET `/api/v1/recordings/{recording_id}`
Detalle de grabacion.

## 5.4 Webhooks de suscripcion

### POST `/api/v1/webhooks`
Crear suscripcion webhook.

Body:

```json
{
  "url": "https://rdn.example.com/webhooks/centralita",
  "events": ["call.*", "agent.*", "recording.ready"],
  "description": "RDN main webhook"
}
```

Respuesta devuelve `secret` solo en esta llamada.

### GET `/api/v1/webhooks`
Lista suscripciones.

### GET `/api/v1/webhooks/{id}`
Detalle + ultimas entregas.

### PUT `/api/v1/webhooks/{id}`
Actualiza URL/eventos/active/description.
Valida patrones de eventos.

### DELETE `/api/v1/webhooks/{id}`
Elimina suscripcion.

### POST `/api/v1/webhooks/{id}/test`
Envia evento `test.ping` firmado.

## 6. Catalogo de eventos (contrato)

## 6.1 Eventos operativos hoy (contractuales)

| Evento | Estado | Cuando se emite | Campos principales |
|---|---|---|---|
| `call.incoming` | Operativo | Entrada de llamada | `call_sid`, `from`, `to`, `queue_id`, `phone_number_id`, `route_type` |
| `call.completed` | Operativo | Dial finaliza con conversacion | `call_sid`, `direction`, `status`, `duration`, `wait_time`, `answered_at`, `ended_at` |
| `call.missed` | Operativo | Llamada inbound no contestada/fallida | `call_sid`, `direction`, `final_status`, `queue_id` |
| `call.transferred` | Operativo | Transferencia ejecutada | `call_sid`, `remote_call_sid`, `destination`, `transferred_by` |
| `call.hold` | Operativo | Se pone en espera | `call_sid`, `remote_call_sid`, `by_user_id` |
| `call.resumed` | Operativo | Se saca de espera | `call_sid`, `remote_call_sid`, `by_user_id` |
| `agent.available` | Operativo | Cambio disponibilidad a true | `user_id`, `rdn_user_id`, `name`, `available` |
| `agent.unavailable` | Operativo | Cambio disponibilidad a false | `user_id`, `rdn_user_id`, `name`, `available` |
| `recording.ready` | Operativo | Grabacion completada | `recording_id`, `recording_sid`, `call_sid`, `call_record_id`, `url`, `duration` |

## 6.2 Eventos reservados/futuros (no contractuales hoy)

Estos patrones pueden existir en validacion de suscripcion, pero **no deben asumirse activos**:

- `call.ringing`
- `call.answered`
- `agent.online`
- `agent.offline`
- `agent.busy`

## 7. Formato webhook

Headers:

```http
Content-Type: application/json
X-Centralita-Signature: sha256=<hex>
X-Centralita-Event: call.completed
X-Centralita-Event-Id: <uuid>
X-Centralita-Delivery-Id: <uuid>
X-Centralita-Timestamp: 2026-04-03T10:05:30.000Z
User-Agent: Centralita-RDN/2.0
```

Body:

```json
{
  "event_id": "f43f8f04-3c7e-4d1b-9d8d-4cd9a3b6a9e0",
  "event": "call.completed",
  "timestamp": "2026-04-03T10:05:30.000Z",
  "data": {
    "call_sid": "CAxxxxxxxx",
    "direction": "inbound",
    "status": "completed",
    "duration": 315,
    "wait_time": 15,
    "answered_at": "2026-04-03T10:00:15.000Z",
    "ended_at": "2026-04-03T10:05:30.000Z"
  }
}
```

## 8. Canonical Call Completion Contract

## 8.1 Cierre funcional de llamada

Para RDN, una llamada queda cerrada por uno de estos eventos:

- `call.completed` -> hubo conversacion
- `call.missed` -> inbound no atendida/fallida

Siempre almacenar `call_sid` y reconciliar con `/api/v1/calls` para cierre definitivo.

## 8.2 Campos obligatorios de cierre

Para `call.completed`:
- Obligatorios: `call_sid`, `direction`, `status`, `ended_at`
- Normalmente presentes: `duration`, `wait_time`, `answered_at`

Para `call.missed`:
- Obligatorios: `call_sid`, `direction`, `final_status`
- Opcional: `queue_id`

## 9. Recording Availability Contract

Evento de disponibilidad de grabacion: `recording.ready`.

Campos:
- `recording_id`: UUID interno (puede ser null solo si hubo inconsistencia puntual de persistencia)
- `recording_sid`: SID Twilio
- `call_sid`: SID de llamada
- `call_record_id`: UUID de llamada
- `url`, `duration`

Regla de consumo:
- Usar `recording_id` cuando exista
- Si llega null, usar `recording_sid + call_record_id` como clave temporal y reconciliar via `/api/v1/recordings`

## 10. Errores y codigos

| HTTP | code | Significado |
|---|---|---|
| 200 | - | Exito |
| 201 | - | Creado |
| 204 | - | Sin contenido |
| 400 | `BAD_REQUEST` | Datos invalidos |
| 401 | `UNAUTHORIZED` | Auth invalida |
| 403 | `FORBIDDEN` | Rol insuficiente |
| 404 | `NOT_FOUND` | Recurso no existe |
| 409 | `CONFLICT` | Conflicto de datos |
| 500 | `INTERNAL_ERROR` | Error interno |

Formato error:

```json
{
  "error": {
    "code": "BAD_REQUEST",
    "message": "Datos invalidos",
    "details": {
      "field": ["motivo"]
    }
  }
}
```

Todas las respuestas API incluyen header `X-Request-Id`.

## 11. Seguridad operativa minima

## 11.1 API keys

Recomendado:
- Rotacion periodica (ej. cada 90 dias)
- Revocacion inmediata si sospecha de fuga
- Una key por integracion/entorno

## 11.2 Secret de webhooks

- Guardar `secret` solo en backend RDN
- Rotar secret recreando suscripcion webhook
- Validar siempre `X-Centralita-Signature`

## 11.3 CORS

- Configurable por entorno via `API_CORS_ALLOW_ORIGIN`
- En produccion, no dejar `*` salvo necesidad explicita

## 12. Observabilidad y operacion

Para soporte de integracion:

- Correlacion API: `X-Request-Id`
- Correlacion eventos: `event_id`
- Correlacion delivery/retry: `X-Centralita-Delivery-Id`

Donde mirar:
- `GET /api/v1/webhooks/{id}` -> estado de suscripcion + ultimos deliveries
- `POST /api/v1/webhooks/retry-deliveries` -> reprocesar pendientes
- `GET /api/v1/calls` y `GET /api/v1/recordings` -> reconciliacion

## 13. Checklist para RDN

1. Consumir API con API key backend-only.
2. Implementar endpoint webhook con verificacion HMAC.
3. Deduplicar por `delivery_id` y proteger negocio por `event_id`.
4. No asumir orden total de eventos.
5. Implementar reconciliacion periodica calls/recordings.
6. Usar `call_sid` para comandos y `call_record_id` para historico.
7. Tratar `mute/unmute` como operaciones solo-conferencia.
8. Manejar retries de webhooks (idempotencia total).

## 14. Ejemplos rapidos

### 14.1 Hangup

```bash
curl -X POST "https://centralita.reparacionesdelnorte.es/api/v1/calls/CAxxxx/hangup" \
  -H "Authorization: Bearer ck_xxx" \
  -H "Content-Type: application/json" \
  -d '{"target":"all"}'
```

### 14.2 Retry de pendientes (cron)

```bash
curl -X POST "https://centralita.reparacionesdelnorte.es/api/v1/webhooks/retry-deliveries" \
  -H "Authorization: Bearer ck_xxx" \
  -H "Content-Type: application/json" \
  -d '{"limit":100}'
```

### 14.3 Bulk sync

```bash
curl -X POST "https://centralita.reparacionesdelnorte.es/api/v1/users/bulk-sync" \
  -H "Authorization: Bearer ck_xxx" \
  -H "Content-Type: application/json" \
  -d '{"users":[{"rdn_user_id":"emp-1","name":"Ana","email":"ana@rdn.com","role":"operator","active":true}]}'
```
