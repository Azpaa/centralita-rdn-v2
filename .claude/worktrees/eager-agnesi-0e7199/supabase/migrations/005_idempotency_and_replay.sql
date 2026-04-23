-- ============================================
-- Centralita RDN v2.0 — Migración 005
-- Idempotencia y replay (Fase 3)
-- ============================================
--
-- Objetivo:
-- 1. `domain_events`: log persistente de TODO evento de dominio que
--    emitimos (call.incoming, call.answered, ...). Sirve como:
--      a) Fuente única del `event_id` (mismo id se propaga a webhook
--         RDN, SSE canónico y cualquier consumidor futuro).
--      b) Buffer de replay para reconexiones SSE vía Last-Event-ID.
--
-- 2. `twilio_webhook_events`: tabla de idempotencia para callbacks
--    entrantes de Twilio. Antes procesábamos dos veces el mismo
--    `CallStatus=completed` cuando Twilio reintentaba (por timeout
--    transitorio), lo que duplicaba `call.completed` y corrompía el
--    estado del agente. Ahora el primer intento gana.
--
-- =====================
-- 1. domain_events
-- =====================

CREATE TABLE domain_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  agent_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  target_user_ids uuid[] NOT NULL DEFAULT '{}',
  call_sid text,
  call_record_id uuid REFERENCES call_records(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '24 hours')
);

-- Index for replay by target user ordered by time.
CREATE INDEX idx_domain_events_target_users ON domain_events USING GIN (target_user_ids);
CREATE INDEX idx_domain_events_created_at ON domain_events (created_at DESC);
CREATE INDEX idx_domain_events_expires_at ON domain_events (expires_at);
CREATE INDEX idx_domain_events_call_sid ON domain_events (call_sid) WHERE call_sid IS NOT NULL;

COMMENT ON TABLE domain_events IS
  'Log persistente de eventos de dominio emitidos por emitEvent(). Fuente del event_id canónico; buffer de replay para SSE.';
COMMENT ON COLUMN domain_events.expires_at IS
  'TTL de 24h. Limpieza por cron/trigger externo — no bloqueante.';

-- =====================
-- 2. twilio_webhook_events
-- =====================

CREATE TABLE twilio_webhook_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Idempotency key: same CallSid + CallStatus + AccountSid
  -- combo should be processed exactly once. Twilio retries on 5xx
  -- and occasionally on transient network issues, so a simple
  -- unique constraint here gives us natural dedup.
  call_sid text NOT NULL,
  call_status text NOT NULL,
  account_sid text NOT NULL,
  -- Webhook source path for observability (e.g. "voice/status").
  source text NOT NULL,
  payload jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '24 hours')
);

CREATE UNIQUE INDEX idx_twilio_webhook_events_dedup
  ON twilio_webhook_events (call_sid, call_status, account_sid);
CREATE INDEX idx_twilio_webhook_events_expires_at
  ON twilio_webhook_events (expires_at);

COMMENT ON TABLE twilio_webhook_events IS
  'Idempotencia para callbacks Twilio. UNIQUE(call_sid, call_status, account_sid) descarta reintentos duplicados.';
