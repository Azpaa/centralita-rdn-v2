-- ============================================
-- Centralita RDN v2.0 — Migración 011
-- RLS en las tablas de eventos (fuga confirmada)
-- ============================================
--
-- Motivación:
-- `domain_events` (005), `twilio_webhook_events` (005) y `conference_events`
-- (008) se crearon SIN `ENABLE ROW LEVEL SECURITY`. Todas las tablas de 001
-- sí lo tienen. Como el esquema `public` está expuesto por PostgREST y la
-- anon key viaja en el bundle web y en el /bootstrap del softphone, esas tres
-- tablas quedaron abiertas a cualquiera. Comprobado contra producción el
-- 2026-08-11 usando solo la anon key:
--
--   SELECT  -> devuelve filas en las tres (call_records, users, queues,
--              audit_logs y reconcile_* sí bloquean correctamente)
--   INSERT  -> permitido (POST de 0 filas responde 201; no se escribió nada)
--
-- Impacto real, por orden de gravedad:
--
--   1. INYECCIÓN DE EVENTOS EN LOS SOFTPHONES. El replay de SSE
--      (`loadReplayEvents`) lee `domain_events` filtrando por
--      target_user_ids/agent_user_id y reconstruye el evento canónico con el
--      payload TAL CUAL. Una fila insertada a mano se le entrega al Tauri de
--      la víctima en su siguiente reconexión: un `call.completed` forjado le
--      tira la llamada, y un `call_updated` con command=accept le dispara un
--      device.connect.
--   2. SABOTAJE DEL FLUJO DE LLAMADAS. `twilio_webhook_events` es la tabla de
--      idempotencia de los callbacks: insertando los event_id adecuados, los
--      webhooks reales de Twilio se descartan como duplicados.
--   3. FUGA DE DATOS PERSONALES. Los payloads llevan los teléfonos de los
--      clientes (from/to), CallSids e ids de usuario.
--
-- Por qué esto NO rompe nada:
-- Las tres tablas solo se tocan desde el servidor con la service role
-- (`createAdminClient`, y la edge function `reconcile-calls`), que bypasea
-- RLS por definición. Verificado que ni el dashboard, ni Tauri, ni RDN las
-- consultan con anon key o sesión de usuario. Por eso no hacen falta
-- políticas: RLS activo y sin políticas = denegar a todo el mundo salvo
-- service_role, que es exactamente el modelo de acceso que ya tenían.

ALTER TABLE public.domain_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.twilio_webhook_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conference_events ENABLE ROW LEVEL SECURITY;

-- Defensa en profundidad: además de RLS, retirar los GRANT por defecto que
-- Supabase da a anon/authenticated en el esquema public. Así, si algún día
-- alguien añade una política permisiva por error, sigue sin haber privilegio
-- de tabla detrás.
REVOKE ALL ON public.domain_events FROM anon, authenticated;
REVOKE ALL ON public.twilio_webhook_events FROM anon, authenticated;
REVOKE ALL ON public.conference_events FROM anon, authenticated;
