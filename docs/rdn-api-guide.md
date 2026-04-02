# Guía de Integración — Centralita RDN → Sistema RDN

> **Versión**: 2.0  
> **Base URL**: `https://centralita.reparacionesdelnorte.es`  
> **Formato**: JSON sobre HTTPS  
> **Autenticación**: API Key (Bearer token)

---

## Índice

1. [Autenticación](#1-autenticación)
2. [Gestión de Usuarios](#2-gestión-de-usuarios)
3. [Control de Llamadas](#3-control-de-llamadas)
4. [Historial y Grabaciones](#4-historial-y-grabaciones)
5. [Sistema de Webhooks (Eventos)](#5-sistema-de-webhooks-eventos)
6. [Estadísticas](#6-estadísticas)
7. [Verificación de Firma de Webhooks](#7-verificación-de-firma-de-webhooks)
8. [Errores y Códigos de Respuesta](#8-errores-y-códigos-de-respuesta)
9. [Ejemplos Completos](#9-ejemplos-completos)

---

## 1. Autenticación

Todas las peticiones a la API requieren un **API Key** en la cabecera `Authorization`.

```http
Authorization: Bearer ck_a1b2c3d4e5f6...
```

### Obtener API Key

El administrador de la centralita os proporcionará un API Key. El key tiene formato `ck_<hex>`.

### Ejemplo con cURL

```bash
curl -X GET "https://centralita.reparacionesdelnorte.es/api/v1/users" \
  -H "Authorization: Bearer ck_YOUR_API_KEY_HERE" \
  -H "Content-Type: application/json"
```

### Respuesta cuando el key es inválido

```json
{
  "error": {
    "code": "UNAUTHORIZED",
    "message": "API key inválida o desactivada"
  }
}
```

---

## 2. Gestión de Usuarios

### 2.1 Listar usuarios

```http
GET /api/v1/users?page=1&limit=50&active=true&available=true&rdn_linked=true&search=Juan
```

**Parámetros de query:**

| Parámetro | Tipo | Descripción |
|---|---|---|
| `page` | number | Página (default: 1) |
| `limit` | number | Registros por página (default: 50, max: 100) |
| `active` | boolean | Filtrar por activo/inactivo |
| `available` | boolean | Filtrar por disponible/no disponible |
| `rdn_linked` | boolean | Filtrar por vinculados a RDN |
| `search` | string | Buscar por nombre o email |

**Respuesta:**

```json
{
  "ok": true,
  "data": [
    {
      "id": "uuid",
      "name": "Juan García",
      "email": "juan@rdn.com",
      "phone": "+34612345678",
      "role": "operator",
      "available": true,
      "active": true,
      "rdn_user_id": "rdn-123",
      "rdn_linked": true,
      "created_at": "2025-01-15T10:00:00Z",
      "updated_at": "2025-06-01T12:00:00Z"
    }
  ],
  "meta": {
    "page": 1,
    "limit": 50,
    "total": 15,
    "totalPages": 1
  }
}
```

### 2.2 Crear usuario

```http
POST /api/v1/users
```

```json
{
  "name": "María López",
  "email": "maria@rdn.com",
  "phone": "+34698765432",
  "role": "operator",
  "rdn_user_id": "rdn-456"
}
```

### 2.3 Vincular usuario con RDN

Si el usuario ya existe en la centralita (creado manualmente por admin), se puede vincular con el ID de RDN:

```http
POST /api/v1/users/{id}/link-rdn
```

```json
{
  "rdn_user_id": "rdn-456"
}
```

### 2.4 Buscar usuario por email

Útil para auto-vincular: buscar si el email del empleado RDN ya existe en la centralita.

```http
POST /api/v1/users/match-email
```

```json
{
  "email": "maria@rdn.com"
}
```

**Respuesta:**

```json
{
  "ok": true,
  "data": {
    "id": "uuid",
    "name": "María López",
    "email": "maria@rdn.com",
    "rdn_user_id": null,
    "rdn_linked": false
  }
}
```

### 2.5 Sincronización masiva (Bulk Sync)

Sincroniza hasta 100 usuarios en una sola llamada. **Idempotente**: se puede llamar repetidamente.

```http
POST /api/v1/users/bulk-sync
```

```json
{
  "users": [
    {
      "rdn_user_id": "rdn-001",
      "name": "Juan García",
      "email": "juan@rdn.com",
      "phone": "+34612345678",
      "role": "operator",
      "active": true
    },
    {
      "rdn_user_id": "rdn-002",
      "name": "Ana Martín",
      "email": "ana@rdn.com",
      "role": "operator",
      "active": true
    }
  ]
}
```

**Lógica de resolución:**

| Caso | Acción |
|---|---|
| `rdn_user_id` ya existe | Actualiza nombre, email, phone, role, active |
| `rdn_user_id` no existe pero `email` coincide | Vincula + actualiza |
| Nada coincide | Crea nuevo usuario |

**Respuesta:**

```json
{
  "ok": true,
  "data": {
    "summary": {
      "total": 2,
      "created": 0,
      "updated": 1,
      "linked": 1,
      "errors": 0
    },
    "results": [
      { "rdn_user_id": "rdn-001", "action": "updated", "user_id": "uuid-1" },
      { "rdn_user_id": "rdn-002", "action": "linked", "user_id": "uuid-2" }
    ]
  }
}
```

### 2.6 Cambiar disponibilidad

```http
PATCH /api/v1/users/{id}/availability
```

```json
{
  "available": true
}
```

> ⚡ Este endpoint emite un evento `agent.available` o `agent.unavailable` hacia vuestros webhooks.

---

## 3. Control de Llamadas

### 3.1 Iniciar llamada saliente

```http
POST /api/v1/calls/dial
```

```json
{
  "destination_number": "+34612345678",
  "from_number": "+34848819410"
}
```

> `from_number` debe ser un número Twilio activo en la centralita.

**Respuesta:**

```json
{
  "ok": true,
  "data": {
    "call_sid": "CAxxxxxx",
    "call_record_id": "uuid",
    "status": "initiated",
    "from": "+34848819410",
    "to": "+34612345678"
  }
}
```

### 3.2 Colgar llamada

```http
POST /api/v1/calls/{callSid}/hangup
```

```json
{
  "target": "all"
}
```

| Target | Efecto |
|---|---|
| `all` (default) | Cuelga todas las partes |
| `agent` | Solo desconecta al agente |
| `remote` | Solo desconecta al llamante/destinatario |

### 3.3 Poner en espera

```http
POST /api/v1/calls/{callSid}/hold
```

```json
{
  "music_url": "https://example.com/hold-music.mp3"
}
```

> El campo `music_url` es opcional. Si no se proporciona, usa música clásica por defecto.

### 3.4 Sacar de espera

```http
POST /api/v1/calls/{callSid}/resume
```

(Body vacío)

### 3.5 Transferir llamada

```http
POST /api/v1/calls/transfer
```

```json
{
  "callSid": "CAxxxxxx",
  "destination": "+34698765432",
  "callerId": "+34848819410"
}
```

> Para transferir a un agente del navegador, usar `destination: "client:UUID_DEL_USUARIO"`.

### 3.6 Conferencia a 3 vías

```http
POST /api/v1/calls/conference
```

| Acción | Body |
|---|---|
| Crear conferencia | `{ "action": "create", "conferenceName": "conf-1", "callSid": "CAxx" }` |
| Añadir participante | `{ "action": "add", "conferenceName": "conf-1", "destination": "+34...", "callerId": "+34..." }` |
| Agente sale | `{ "action": "leave", "conferenceName": "conf-1", "participantSid": "CAxx" }` |
| Expulsar participante | `{ "action": "kick", "conferenceName": "conf-1", "participantSid": "CAxx" }` |

---

## 4. Historial y Grabaciones

### 4.1 Listar llamadas

```http
GET /api/v1/calls?direction=inbound&status=completed&date_from=2025-06-01T00:00:00Z&limit=20
```

**Filtros disponibles:**

| Parámetro | Tipo | Descripción |
|---|---|---|
| `direction` | `inbound` / `outbound` | Dirección |
| `status` | `ringing`, `in_queue`, `in_progress`, `completed`, `no_answer`, `busy`, `failed`, `canceled`, `forwarded`, `voicemail` | Estado |
| `queue_id` | uuid | Cola que procesó la llamada |
| `from_number` | string | Buscar por número de origen (parcial) |
| `to_number` | string | Buscar por número de destino (parcial) |
| `date_from` | ISO 8601 | Desde fecha |
| `date_to` | ISO 8601 | Hasta fecha |
| `answered_by_user_id` | uuid | Quién contestó |

### 4.2 Detalle de llamada

```http
GET /api/v1/calls/{id}
```

**Respuesta:**

```json
{
  "ok": true,
  "data": {
    "id": "uuid",
    "twilio_call_sid": "CAxxxxxx",
    "direction": "inbound",
    "from_number": "+34612345678",
    "to_number": "+34848819410",
    "status": "completed",
    "started_at": "2025-06-01T10:00:00Z",
    "answered_at": "2025-06-01T10:00:15Z",
    "ended_at": "2025-06-01T10:05:30Z",
    "duration": 315,
    "wait_time": 15,
    "queue_id": "uuid",
    "answered_by_user_id": "uuid",
    "answered_by_user": {
      "id": "uuid",
      "name": "Juan García",
      "email": "juan@rdn.com"
    },
    "recordings": [
      {
        "id": "uuid",
        "url": "https://api.twilio.com/2010-04-01/Accounts/.../Recordings/RExx",
        "duration": 315,
        "status": "completed"
      }
    ]
  }
}
```

### 4.3 Listar grabaciones

```http
GET /api/v1/recordings?limit=20
```

---

## 5. Sistema de Webhooks (Eventos)

La centralita envía eventos HTTP POST a los endpoints que registréis. Esto permite que RDN reaccione en **tiempo real** a llamadas, cambios de disponibilidad, etc.

### 5.1 Crear suscripción

```http
POST /api/v1/webhooks
```

```json
{
  "url": "https://rdn.example.com/webhooks/centralita",
  "events": ["call.*", "agent.*", "recording.ready"],
  "description": "Webhook principal RDN"
}
```

**Respuesta (⚠️ el `secret` solo se muestra aquí):**

```json
{
  "ok": true,
  "data": {
    "id": "uuid",
    "url": "https://rdn.example.com/webhooks/centralita",
    "secret": "whsec_a1b2c3d4e5f6...",
    "events": ["call.*", "agent.*", "recording.ready"],
    "active": true,
    "description": "Webhook principal RDN",
    "created_at": "2025-06-01T12:00:00Z"
  }
}
```

> ⚠️ **Guardad el `secret`**. Se necesita para verificar la firma de los eventos entrantes. No se puede recuperar después.

### 5.2 Patrones de eventos

| Patrón | Coincide con |
|---|---|
| `*` | Todos los eventos |
| `call.*` | Todos los eventos de llamadas |
| `agent.*` | Todos los eventos de agentes |
| `recording.*` | Todos los eventos de grabaciones |
| `call.answered` | Solo evento específico |

### 5.3 Catálogo de eventos

#### Llamadas

| Evento | Cuándo | Datos |
|---|---|---|
| `call.incoming` | Llamada entrante recibida | `call_sid`, `from`, `to`, `queue_id`, `phone_number_id` |
| `call.answered` | *(futuro — integrar con whisper)* | |
| `call.completed` | Llamada finalizada exitosamente | `call_sid`, `direction`, `duration`, `wait_time`, `answered_at`, `ended_at` |
| `call.missed` | Nadie contestó | `call_sid`, `direction`, `final_status`, `queue_id` |
| `call.transferred` | Transferida a otro destino | `call_sid`, `remote_call_sid`, `destination`, `transferred_by` |
| `call.hold` | Puesta en espera | `call_sid`, `remote_call_sid`, `by_user_id` |
| `call.resumed` | Sacada de espera | `call_sid`, `remote_call_sid`, `by_user_id` |

#### Agentes

| Evento | Cuándo | Datos |
|---|---|---|
| `agent.available` | Agente marcó disponible | `user_id`, `rdn_user_id`, `name` |
| `agent.unavailable` | Agente marcó no disponible | `user_id`, `rdn_user_id`, `name` |

#### Grabaciones

| Evento | Cuándo | Datos |
|---|---|---|
| `recording.ready` | Grabación procesada y disponible | `recording_id`, `call_sid`, `call_record_id`, `url`, `duration` |

### 5.4 Formato del webhook entrante

Cada POST que recibáis tendrá esta estructura:

**Cabeceras:**

```
Content-Type: application/json
X-Centralita-Signature: sha256=a1b2c3d4e5f6...
X-Centralita-Event: call.completed
X-Centralita-Delivery-Id: uuid
X-Centralita-Timestamp: 2025-06-01T10:05:30Z
User-Agent: Centralita-RDN/2.0
```

**Body:**

```json
{
  "event": "call.completed",
  "timestamp": "2025-06-01T10:05:30Z",
  "data": {
    "call_sid": "CAxxxxxx",
    "direction": "inbound",
    "duration": 315,
    "wait_time": 15,
    "answered_at": "2025-06-01T10:00:15Z",
    "ended_at": "2025-06-01T10:05:30Z"
  }
}
```

### 5.5 Probar webhook

```http
POST /api/v1/webhooks/{id}/test
```

Envía un evento `test.ping` al endpoint para verificar que funciona.

### 5.6 Reintentos

Si vuestro endpoint devuelve un error (non-2xx o timeout), la centralita reintenta:

| Intento | Delay |
|---|---|
| 1 (original) | Inmediato |
| 2 | 10 segundos |
| 3 | 60 segundos |
| 4 | 5 minutos |

Tras 50 fallos consecutivos, la suscripción se desactiva automáticamente.

---

## 6. Estadísticas

```http
GET /api/v1/stats/summary
```

```json
{
  "ok": true,
  "data": {
    "calls_today": 42,
    "active_calls": 3,
    "available_users": 5,
    "total_users": 12
  }
}
```

---

## 7. Verificación de Firma de Webhooks

Para verificar que un webhook viene realmente de la centralita:

### Node.js

```javascript
const crypto = require('crypto');

function verifyWebhook(rawBody, secret, signatureHeader) {
  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex');
  
  const receivedSignature = signatureHeader.replace('sha256=', '');
  
  return crypto.timingSafeEqual(
    Buffer.from(expectedSignature),
    Buffer.from(receivedSignature)
  );
}

// En vuestro endpoint:
app.post('/webhooks/centralita', (req, res) => {
  const rawBody = req.rawBody; // body sin parsear
  const signature = req.headers['x-centralita-signature'];
  const secret = 'whsec_xxxxx'; // el secret que os dimos al crear la suscripción
  
  if (!verifyWebhook(rawBody, secret, signature)) {
    return res.status(401).send('Firma inválida');
  }
  
  const event = JSON.parse(rawBody);
  console.log('Evento recibido:', event.event, event.data);
  
  // Procesar el evento...
  
  res.status(200).send('OK');
});
```

### Python

```python
import hmac
import hashlib

def verify_webhook(raw_body: bytes, secret: str, signature_header: str) -> bool:
    expected = hmac.new(
        secret.encode(), raw_body, hashlib.sha256
    ).hexdigest()
    received = signature_header.replace('sha256=', '')
    return hmac.compare_digest(expected, received)
```

### PHP

```php
function verifyWebhook(string $rawBody, string $secret, string $signatureHeader): bool {
    $expected = hash_hmac('sha256', $rawBody, $secret);
    $received = str_replace('sha256=', '', $signatureHeader);
    return hash_equals($expected, $received);
}
```

### C#

```csharp
using System.Security.Cryptography;
using System.Text;

bool VerifyWebhook(string rawBody, string secret, string signatureHeader)
{
    using var hmac = new HMACSHA256(Encoding.UTF8.GetBytes(secret));
    var hash = hmac.ComputeHash(Encoding.UTF8.GetBytes(rawBody));
    var expected = BitConverter.ToString(hash).Replace("-", "").ToLowerInvariant();
    var received = signatureHeader.Replace("sha256=", "");
    return expected == received;
}
```

---

## 8. Errores y Códigos de Respuesta

| HTTP Status | Código | Significado |
|---|---|---|
| 200 | - | Éxito |
| 201 | - | Recurso creado |
| 204 | - | Sin contenido (DELETE exitoso) |
| 400 | `BAD_REQUEST` | Datos inválidos |
| 401 | `UNAUTHORIZED` | API key inválida o no proporcionada |
| 403 | `FORBIDDEN` | No tiene permiso para esta acción |
| 404 | `NOT_FOUND` | Recurso no encontrado |
| 409 | `CONFLICT` | Conflicto (ej: email duplicado) |
| 500 | `INTERNAL_ERROR` | Error interno del servidor |

**Formato de error:**

```json
{
  "error": {
    "code": "BAD_REQUEST",
    "message": "Datos de validación inválidos",
    "details": {
      "email": ["Email no válido"]
    }
  }
}
```

---

## 9. Ejemplos Completos

### Flujo completo: Sincronizar usuarios + suscribir webhooks

```bash
# 1. Sincronizar usuarios de RDN
curl -X POST "https://centralita.reparacionesdelnorte.es/api/v1/users/bulk-sync" \
  -H "Authorization: Bearer ck_YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "users": [
      {"rdn_user_id": "emp-001", "name": "Juan García", "email": "juan@rdn.com", "role": "operator", "active": true},
      {"rdn_user_id": "emp-002", "name": "Ana Martín", "email": "ana@rdn.com", "role": "operator", "active": true}
    ]
  }'

# 2. Crear suscripción de webhooks
curl -X POST "https://centralita.reparacionesdelnorte.es/api/v1/webhooks" \
  -H "Authorization: Bearer ck_YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://rdn.example.com/api/centralita-events",
    "events": ["call.*", "agent.*", "recording.ready"],
    "description": "Webhook principal sistema RDN"
  }'
# → Guardad el "secret" de la respuesta

# 3. Probar que el webhook funciona
curl -X POST "https://centralita.reparacionesdelnorte.es/api/v1/webhooks/{webhook_id}/test" \
  -H "Authorization: Bearer ck_YOUR_KEY"

# 4. Marcar un agente como disponible
curl -X PATCH "https://centralita.reparacionesdelnorte.es/api/v1/users/{user_id}/availability" \
  -H "Authorization: Bearer ck_YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"available": true}'

# 5. Consultar estadísticas
curl -X GET "https://centralita.reparacionesdelnorte.es/api/v1/stats/summary" \
  -H "Authorization: Bearer ck_YOUR_KEY"
```

### Flujo: Control remoto de llamada

```bash
# Colgar una llamada activa
curl -X POST "https://centralita.reparacionesdelnorte.es/api/v1/calls/CAxxxxxx/hangup" \
  -H "Authorization: Bearer ck_YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"target": "all"}'

# Poner en espera
curl -X POST "https://centralita.reparacionesdelnorte.es/api/v1/calls/CAxxxxxx/hold" \
  -H "Authorization: Bearer ck_YOUR_KEY"

# Sacar de espera
curl -X POST "https://centralita.reparacionesdelnorte.es/api/v1/calls/CAxxxxxx/resume" \
  -H "Authorization: Bearer ck_YOUR_KEY"

# Transferir a otro número
curl -X POST "https://centralita.reparacionesdelnorte.es/api/v1/calls/transfer" \
  -H "Authorization: Bearer ck_YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "callSid": "CAxxxxxx",
    "destination": "+34698765432",
    "callerId": "+34848819410"
  }'
```

---

## Contacto

Para dudas técnicas sobre la integración, contactar al equipo de la centralita.
