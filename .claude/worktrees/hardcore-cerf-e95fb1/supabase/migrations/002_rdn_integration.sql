-- ============================================
-- Centralita RDN v2.0 — Migración 002
-- Integración RDN: fix enum + nuevas tablas
-- Ejecutar en Supabase SQL Editor
-- ============================================

-- =====================
-- 1. FIX: Añadir valores faltantes al enum call_status
-- PostgreSQL permite ALTER TYPE ... ADD VALUE sin downtime.
-- =====================

ALTER TYPE call_status ADD VALUE IF NOT EXISTS 'forwarded';
ALTER TYPE call_status ADD VALUE IF NOT EXISTS 'voicemail';

-- =====================
-- 2. NUEVA TABLA: webhook_subscriptions
-- RDN registra sus endpoints para recibir eventos.
-- =====================

CREATE TABLE webhook_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  url text NOT NULL,
  secret text NOT NULL,
  events text[] NOT NULL DEFAULT '{}',
  active boolean NOT NULL DEFAULT true,
  description text,
  api_key_id uuid REFERENCES api_keys(id) ON DELETE CASCADE,
  failure_count integer NOT NULL DEFAULT 0,
  last_success_at timestamptz,
  last_failure_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- =====================
-- 3. NUEVA TABLA: webhook_delivery_log
-- Log de cada intento de entrega para debugging y retry.
-- =====================

CREATE TABLE webhook_delivery_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id uuid NOT NULL REFERENCES webhook_subscriptions(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  response_status integer,
  response_body text,
  error_message text,
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 3,
  next_retry_at timestamptz,
  delivered boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- =====================
-- 4. ÍNDICES
-- =====================

CREATE INDEX idx_webhook_subs_api_key_id ON webhook_subscriptions(api_key_id);
CREATE INDEX idx_webhook_subs_active ON webhook_subscriptions(active);
CREATE INDEX idx_webhook_delivery_subscription ON webhook_delivery_log(subscription_id);
CREATE INDEX idx_webhook_delivery_pending ON webhook_delivery_log(delivered, next_retry_at)
  WHERE delivered = false;
CREATE INDEX idx_webhook_delivery_created ON webhook_delivery_log(created_at DESC);

-- =====================
-- 5. TRIGGER updated_at para webhook_subscriptions
-- =====================

CREATE TRIGGER update_webhook_subscriptions_updated_at
  BEFORE UPDATE ON webhook_subscriptions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- =====================
-- 6. RLS
-- =====================

ALTER TABLE webhook_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_delivery_log ENABLE ROW LEVEL SECURITY;

-- Service role bypasa RLS por defecto.
-- Panel web puede leer suscripciones (admin panel):
CREATE POLICY "Authenticated users can read webhook_subscriptions"
  ON webhook_subscriptions FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Authenticated users can read webhook_delivery_log"
  ON webhook_delivery_log FOR SELECT
  TO authenticated
  USING (true);
