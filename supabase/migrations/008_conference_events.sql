-- ============================================
-- Centralita RDN v2.0 — Migración 008
-- Telemetría de conferencias (Fase 0 robustez)
-- ============================================
--
-- Motivación:
-- Los callbacks de conferencia de Twilio (participant-join,
-- participant-leave, conference-end) llegaban a /webhooks/twilio/voice/status
-- y se DESCARTABAN (no traen CallStatus). Eso nos dejaba ciegos ante:
--   a) La leg del agente cayéndose de la sala sin hangup explícito
--      (blip de red, WebView2 suspendido) — hoy mata la sala entera vía
--      endConferenceOnExit y dial-action cuelga al llamante.
--   b) PBXs externas que "aparcan"/re-señalizan la leg del llamante al
--      ponernos en espera (el bug reportado de hold remoto).
--
-- Esta tabla es insert-only desde el webhook de status. La consume:
--   - Diagnóstico manual (¿qué pasó en la sala X durante el incidente?).
--   - La siguiente fase: watchdog de sala (re-ring / teardown ordenado
--     cuando la leg del agente sale sin reincorporarse).

CREATE TABLE conference_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conference_sid text,
  friendly_name text,
  -- participant-join | participant-leave | conference-start | conference-end
  event text NOT NULL,
  -- CallSid del participante (presente en eventos participant-*)
  participant_call_sid text,
  -- twilio_call_sid del call_record inferido del friendly_name
  -- (`call-<sid>` o `resume-<sid>-<ts>`); null para salas ad-hoc.
  parent_call_sid text,
  -- Clasificación del participante en el momento del evento:
  --   true  → coincide con twilio_data.agent_call_sid
  --   false → coincide con el parent (leg del llamante)
  --   null  → desconocido (sala sin record, leg de terceros, etc.)
  is_agent_leg boolean,
  -- Estado del call_record cuando llegó el evento (para detectar
  -- "leave con llamada in_progress" sin reconstruir la línea temporal).
  parent_status_at_event text,
  reason text,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '7 days')
);

CREATE INDEX idx_conference_events_friendly
  ON conference_events (friendly_name, created_at DESC);
CREATE INDEX idx_conference_events_parent
  ON conference_events (parent_call_sid, created_at DESC)
  WHERE parent_call_sid IS NOT NULL;
CREATE INDEX idx_conference_events_expires_at
  ON conference_events (expires_at);

COMMENT ON TABLE conference_events IS
  'Telemetría de callbacks de conferencia Twilio (join/leave/end). Insert-only desde voice/status; TTL 7 días vía expires_at (limpieza por cron externo).';
COMMENT ON COLUMN conference_events.is_agent_leg IS
  'true = leg del agente (twilio_data.agent_call_sid); false = leg del llamante (parent); null = desconocido.';
