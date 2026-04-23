import crypto from 'crypto';
import { NextRequest } from 'next/server';
import { z } from 'zod';
import { authenticate, isAuthenticated } from '@/lib/api/auth';
import { apiBadRequest, apiNotFound, apiSuccess } from '@/lib/api/response';
import { createAdminClient } from '@/lib/supabase/admin';
import { requireCallControlPermission } from '@/lib/calls/ownership';
import { publishCanonicalClientEvent } from '@/lib/events/client-stream';
import { auditLog } from '@/lib/api/audit';

const confirmSchema = z.object({
  command_id: z.string().trim().min(1).optional(),
  engine_accepted_at: z.string().datetime().optional(),
});

type CallRow = {
  id: string;
  twilio_call_sid: string | null;
  answered_by_user_id: string | null;
  twilio_data: Record<string, unknown> | null;
};

/**
 * POST /api/v1/calls/:id/accept/confirm
 *
 * Callback que el softphone (Tauri / web) invoca cuando el engine Twilio
 * dispara el evento `accept` y tiene audio local activo. Este endpoint es
 * la contraparte asincrona de /accept: /accept solicita, /accept/confirm
 * confirma que el agente realmente tiene media. Hasta que llegue esta
 * confirmacion, el backend solo sabe que Twilio cree que esta conectado —
 * no que el agente oiga al interlocutor.
 *
 * Idempotente: multiples POST no producen efectos colaterales.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await authenticate(req);
  if (!isAuthenticated(auth)) return auth;

  const { id: callSid } = await params;
  if (!callSid) return apiBadRequest('callSid es requerido');

  const permissionCheck = await requireCallControlPermission(auth, callSid);
  if (permissionCheck !== true) return permissionCheck;

  let body: unknown = {};
  try {
    body = await req.json();
  } catch {
    // body vacio permitido
  }

  const parsed = confirmSchema.safeParse(body);
  if (!parsed.success) {
    return apiBadRequest('Datos invalidos', parsed.error.flatten().fieldErrors);
  }

  const supabase = createAdminClient();

  let { data: directMatch } = await supabase
    .from('call_records')
    .select('id, twilio_call_sid, answered_by_user_id, twilio_data')
    .eq('twilio_call_sid', callSid)
    .maybeSingle();

  if (!directMatch) {
    const { data: legMatch } = await supabase
      .from('call_records')
      .select('id, twilio_call_sid, answered_by_user_id, twilio_data')
      .filter('twilio_data->>agent_call_sid', 'eq', callSid)
      .maybeSingle();
    directMatch = legMatch;
  }

  if (!directMatch) return apiNotFound('Llamada');

  const callRow = directMatch as CallRow;
  const confirmedAt = new Date().toISOString();
  const previousData = (callRow.twilio_data && typeof callRow.twilio_data === 'object' && !Array.isArray(callRow.twilio_data)
    ? callRow.twilio_data
    : {}) as Record<string, unknown>;

  const previouslyConfirmedAt = typeof previousData.accept_confirmed_at === 'string'
    ? previousData.accept_confirmed_at
    : null;

  if (previouslyConfirmedAt) {
    // Idempotencia: ya confirmado. No reescribimos timestamps para no falsear
    // metricas de latencia accept->confirm.
    return apiSuccess({
      confirmed: true,
      call_sid: callSid,
      already_confirmed: true,
      confirmed_at: previouslyConfirmedAt,
    });
  }

  const mergedTwilioData: Record<string, unknown> = {
    ...previousData,
    accept_confirmed_at: confirmedAt,
    accept_confirmed_by_user_id: auth.userId ?? null,
    accept_confirmed_via: auth.authMethod,
  };
  if (parsed.data.command_id) {
    mergedTwilioData.accept_confirmed_command_id = parsed.data.command_id;
  }
  if (parsed.data.engine_accepted_at) {
    mergedTwilioData.accept_engine_accepted_at = parsed.data.engine_accepted_at;
  }

  await supabase
    .from('call_records')
    .update({
      twilio_data: mergedTwilioData,
      last_verified_at: confirmedAt,
    })
    .eq('id', callRow.id);

  const eventId = crypto.randomUUID();
  const targetUserIds = callRow.answered_by_user_id ? [callRow.answered_by_user_id] : [];

  publishCanonicalClientEvent({
    id: eventId,
    type: 'call_updated',
    timestamp: confirmedAt,
    call_sid: callSid,
    agent_user_id: callRow.answered_by_user_id ?? null,
    target_user_ids: targetUserIds,
    payload: {
      command: 'accept_confirmed',
      call_sid: callSid,
      command_id: parsed.data.command_id ?? null,
      confirmed_at: confirmedAt,
      engine_accepted_at: parsed.data.engine_accepted_at ?? null,
      confirmed_by_user_id: auth.userId ?? null,
    },
  });

  await auditLog('call.accept_confirmed', 'call_record', callRow.id, auth.userId, {
    call_sid: callSid,
    command_id: parsed.data.command_id ?? null,
    engine_accepted_at: parsed.data.engine_accepted_at ?? null,
    auth_method: auth.authMethod,
  });

  return apiSuccess({
    confirmed: true,
    call_sid: callSid,
    confirmed_at: confirmedAt,
    already_confirmed: false,
  });
}
