-- ============================================
-- Centralita RDN v2.0 — Migración 004
-- Añadir 'pending_agent' al enum call_status
-- Necesario para flujo outbound device.connect()
-- ============================================

ALTER TYPE call_status ADD VALUE IF NOT EXISTS 'pending_agent';
