# Voice Agent Tauri

Cliente desktop de voz/presencia para Centralita.

## Alcance actual

- Bootstrap desde backend: `GET /api/v1/voice-agent/bootstrap`
- Login agente con Supabase (email/password)
- Consumo de estado canonico: `GET /api/v1/agent/me/state`
- Consumo de stream canonico SSE: `GET /api/v1/stream/events?scope=mine`
- Motor de voz Twilio real:
  - token de voz por `GET /api/v1/token`
  - registro y mantenimiento de `Device`
  - renovacion de token (`tokenWillExpire`)
  - reconexion automatica y health-check
  - recepcion de llamadas reales (`incoming`)
  - auto-adopcion de outbound RDN (`rdn/backend_outbound/rdn_adopted`)
  - aceptar/colgar/mutear audio real desde la app
- Controles backend sincronizados:
  - `POST /api/v1/calls/{callSid}/hangup`
  - `POST /api/v1/calls/{callSid}/mute`
  - `POST /api/v1/calls/{callSid}/unmute`

## Estructura

- `src/`: UI React + cliente backend/SSE + motor de voz.
- `src/lib/voice-engine.ts`: capa de softphone Twilio.
- `src-tauri/`: runtime Tauri + updater plugin.
- `releases/latest.json`: manifest de release servido por la web.

## Arranque local

```bash
cd apps/voice-agent-tauri
npm install
npm run tauri:dev
```

En el primer arranque, el runtime pedira permiso de microfono para levantar media WebRTC.

Backend local recomendado:

- Centralita: `http://localhost:3000`
- En la app, configura `Backend URL` a esa base.

## Build

```bash
cd apps/voice-agent-tauri
npm run build
npm run tauri:build
```

Los artefactos quedan en `src-tauri/target/release/bundle`.

## Publicacion de release

Desde `centralita-app`:

```bash
node scripts/voice-agent/publish-release.mjs
```

El script copia artefactos a `public/downloads/voice-agent/v<version>/`
y actualiza manifests en:

- `apps/voice-agent-tauri/releases/latest.json`
- `public/downloads/voice-agent/latest.json`

