import { NextRequest } from 'next/server';
import { z } from 'zod';
import { authenticate, isAuthenticated } from '@/lib/api/auth';
import { apiBadRequest, apiSuccess, apiInternalError } from '@/lib/api/response';
import { createAdminClient } from '@/lib/supabase/admin';

/**
 * POST /api/v1/client-logs
 *
 * Telemetría del softphone (Tauri / navegador). El cliente reporta eventos
 * del SDK de voz (disconnect, error, reconnecting, warnings) y decisiones
 * locales (p. ej. "ignoré un call_ended porque el backend confirma que la
 * llamada sigue viva"). Se persisten en audit_logs para poder reconstruir
 * la línea temporal de un incidente — hoy esos eventos morían en la
 * consola local del agente, que es inaccesible cuando alguien reporta
 * "se me cortó la llamada en espera".
 *
 * Diseño deliberadamente mínimo: best-effort, payloads acotados, sin
 * side-effects sobre llamadas.
 */

const entrySchema = z.object({
  kind: z.string().trim().min(1).max(64),
  call_sid: z.string().trim().max(64).optional(),
  detail: z.string().trim().max(1000).optional(),
  at: z.string().max(40).optional(),
});

const bodySchema = z.object({
  events: z.array(entrySchema).min(1).max(20),
});

export async function POST(req: NextRequest) {
  const auth = await authenticate(req);
  if (!isAuthenticated(auth)) return auth;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return apiBadRequest('Body JSON invalido');
  }

  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return apiBadRequest('Datos invalidos', parsed.error.flatten().fieldErrors);
  }

  try {
    const supabase = createAdminClient();
    const reportedAt = new Date().toISOString();

    const rows = parsed.data.events.map((event) => ({
      action: 'client.voice_event',
      entity: 'voice_client',
      entity_id: event.call_sid ?? null,
      user_id: auth.userId ?? null,
      details: {
        kind: event.kind,
        detail: event.detail ?? null,
        client_at: event.at ?? null,
        reported_at: reportedAt,
        auth_method: auth.authMethod,
      },
    }));

    const { error } = await supabase.from('audit_logs').insert(rows);
    if (error) {
      console.warn('[CLIENT-LOGS] Error insertando eventos:', error.message);
      return apiInternalError('No se pudieron registrar los eventos');
    }

    return apiSuccess({ logged: rows.length });
  } catch (err) {
    console.error('[CLIENT-LOGS] Error:', err);
    return apiInternalError('Error registrando eventos del cliente');
  }
}
