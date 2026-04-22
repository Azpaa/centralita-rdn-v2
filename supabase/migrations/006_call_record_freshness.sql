-- ============================================
-- Centralita RDN v2.0 — Migración 006
-- Contract hardening (Fase 4)
-- ============================================
--
-- Motivación:
-- Antes, para decidir si una llamada seguía viva usábamos
-- heurísticas frágiles (antigüedad del `started_at`, presencia en
-- `active_calls`, flags en `twilio_data`). Eso producía dos tipos de
-- error:
--   a) Matar llamadas vivas — `releaseAgentCallsBeforeNewDial` cancelaba
--      llamadas que sólo parecían estancadas porque no habíamos visto
--      un evento reciente.
--   b) Dejar fantasmas — una llamada que Twilio ya terminó pero cuyo
--      webhook se perdió seguía mostrada como activa hasta reinicio.
--
-- Con estos dos timestamps la decisión pasa a ser inequívoca:
--   last_webhook_at    → último callback que Twilio nos envió (webhook
--                        de status). Avanza sólo si Twilio habla.
--   last_verified_at   → última verificación activa que hicimos contra
--                        la API de Twilio (twilioClient.calls(sid).fetch()).
--                        Avanza sólo si nosotros preguntamos.
--
-- Una llamada "viva" es aquella cuyo max(last_webhook_at,
-- last_verified_at) es reciente. Si ambos quedan atrás, la siguiente
-- capa (reconcile) hace un live-check en Twilio antes de matar nada.

ALTER TABLE call_records
  ADD COLUMN last_webhook_at timestamptz,
  ADD COLUMN last_verified_at timestamptz;

-- Índice parcial para la ruta caliente de self-heal: llamadas
-- no-terminales que no han recibido señal reciente. Mantenerlo
-- parcial evita inflar el índice con llamadas cerradas.
CREATE INDEX idx_call_records_active_freshness
  ON call_records (
    COALESCE(last_verified_at, last_webhook_at, started_at) ASC
  )
  WHERE ended_at IS NULL;

COMMENT ON COLUMN call_records.last_webhook_at IS
  'Última vez que recibimos un webhook de Twilio para esta llamada. Solo avanza vía status callbacks.';
COMMENT ON COLUMN call_records.last_verified_at IS
  'Última vez que verificamos contra la API live de Twilio el estado de esta llamada. Solo avanza vía reconcile.';
