-- ============================================
-- Centralita RDN v2.0 — Migración 009
-- Índices para la reconexión pegajosa (Fase 2)
-- ============================================
--
-- El webhook de entrantes busca, en cada llamada, si el número que llama
-- tuvo una llamada ATENDIDA recientemente (entrante por from_number o
-- saliente por to_number) para devolvérsela al mismo agente. Sin índice,
-- esa búsqueda es un seq-scan de call_records en el camino caliente de
-- cada llamada entrante.
--
-- Parciales a propósito: solo filas atendidas y cerradas participan en el
-- lookup, así el índice no crece con ringing/fallidas.

CREATE INDEX idx_call_records_sticky_inbound
  ON call_records (from_number, ended_at DESC)
  WHERE direction = 'inbound'
    AND answered_by_user_id IS NOT NULL
    AND ended_at IS NOT NULL;

CREATE INDEX idx_call_records_sticky_outbound
  ON call_records (to_number, ended_at DESC)
  WHERE direction = 'outbound'
    AND answered_by_user_id IS NOT NULL
    AND ended_at IS NOT NULL;

COMMENT ON INDEX idx_call_records_sticky_inbound IS
  'Lookup de reconexión pegajosa: última llamada entrante atendida de un número.';
COMMENT ON INDEX idx_call_records_sticky_outbound IS
  'Lookup de reconexión pegajosa: última llamada saliente atendida hacia un número.';
