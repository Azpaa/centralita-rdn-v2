-- ============================================
-- Centralita RDN v2.0 — Migración 007
-- Idempotencia de dial (Fase 4 — consolidación)
-- ============================================
--
-- Motivación:
-- El endpoint `/api/v1/calls/dial` crea un `call_records` con status
-- `pending_agent` antes de emitir el evento SSE que dispara el
-- `device.connect()` del softphone. Dos dials casi simultáneos contra el
-- mismo agente (doble clic del operador, retry del RDN, ventana entre
-- reconciliación pre-dial y el INSERT) producían dos filas `pending_agent`
-- para el mismo agente, dejando la segunda sin media real y obligando a
-- reconcile a limpiarlas después.
--
-- Este índice único parcial fuerza al máximo 1 row `pending_agent` por
-- agente a la vez. La segunda tentativa recibe 23505 y el código puede
-- devolver la fila existente (idempotente) o rechazar limpiamente según
-- la política de `dial/route.ts`.
--
-- Parcial porque sólo nos importa el constraint mientras la fila está
-- en pending_agent y no cerrada: llamadas históricas del mismo agente
-- no deben bloquearlas.

CREATE UNIQUE INDEX idx_call_records_pending_agent_unique
  ON call_records (answered_by_user_id)
  WHERE status = 'pending_agent'
    AND ended_at IS NULL;

COMMENT ON INDEX idx_call_records_pending_agent_unique IS
  'Fuerza 1 pending_agent por agente a la vez. Dial doble → 23505 → caller reutiliza la fila existente.';
