import crypto from 'crypto';
import { NextRequest } from 'next/server';
import { z } from 'zod';
import { authenticate, isAuthenticated } from '@/lib/api/auth';
import { apiBadRequest, apiSuccess } from '@/lib/api/response';
import { createAdminClient } from '@/lib/supabase/admin';
import { requireCallControlPermission } from '@/lib/calls/ownership';
import { publishCanonicalClientEvent } from '@/lib/events/client-stream';
import { auditLog } from '@/lib/api/audit';

const acceptSchema = z.object({
  user_id: z.string().uuid().optional(),
  rdn_user_id: z.string().trim().min(1).optional(),
});

function isUuid(value: unknown): value is string {
  return (
    typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}

async function resolveTargetUserIds(params: {
  callSid: string;
  requestedUserId?: string;
  requestedRdnUserId?: string;
  sessionUserId: string | null;
}): Promise<string[]> {
  const { callSid, requestedUserId, requestedRdnUserId, sessionUserId } = params;
  const supabase = createAdminClient();
  const candidates = new Set<string>();

  if (requestedUserId) candidates.add(requestedUserId);

  if (requestedRdnUserId) {
    const { data: userByRdn } = await supabase
      .from('users')
      .select('id')
      .eq('rdn_user_id', requestedRdnUserId)
      .is('deleted_at', null)
      .maybeSingle();

    if (userByRdn?.id) candidates.add(userByRdn.id);
  }

  if (sessionUserId) candidates.add(sessionUserId);

  if (candidates.size === 0) {
    const { data: call } = await supabase
      .from('call_records')
      .select('answered_by_user_id, twilio_data')
      .eq('twilio_call_sid', callSid)
      .maybeSingle();

    if (isUuid(call?.answered_by_user_id)) {
      candidates.add(call.answered_by_user_id);
    }

    const twilioData =
      call?.twilio_data && typeof call.twilio_data === 'object' && !Array.isArray(call.twilio_data)
        ? (call.twilio_data as Record<string, unknown>)
        : {};

    const directKeys = ['resolved_agent_id', 'requested_user_id', 'user_id', 'initiated_by'];
    for (const key of directKeys) {
      if (isUuid(twilioData[key])) {
        candidates.add(twilioData[key]);
      }
    }
  }

  if (candidates.size === 0) return [];

  const candidateIds = [...candidates];
  const { data: users } = await supabase
    .from('users')
    .select('id')
    .in('id', candidateIds)
    .is('deleted_at', null);

  return (users || []).map((row) => row.id).filter(isUuid);
}

/**
 * POST /api/v1/calls/:id/accept
 * Solicita que un cliente agente conectado (p. ej. Tauri) acepte la llamada por softphone.
 *
 * Nota: la aceptacion real depende de que exista cliente conectado para el agente
 * destino y que tenga media local disponible.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
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

  const parsed = acceptSchema.safeParse(body);
  if (!parsed.success) {
    return apiBadRequest('Datos invalidos', parsed.error.flatten().fieldErrors);
  }

  const targetUserIds = await resolveTargetUserIds({
    callSid,
    requestedUserId: parsed.data.user_id,
    requestedRdnUserId: parsed.data.rdn_user_id,
    sessionUserId: auth.authMethod === 'session' ? auth.userId : null,
  });

  if (targetUserIds.length === 0) {
    return apiBadRequest(
      'No se pudo resolver el agente destino para aceptar la llamada. Envia user_id o rdn_user_id.'
    );
  }

  // Pull the conference name written by the incoming webhook so the
  // softphone doesn't have to rely on its `call-<sid>` fallback. If the
  // fallback ever drifts from what the webhook wrote, joinConference
  // silently lands in an empty room and media never bridges.
  const supabase = createAdminClient();
  const { data: callRow } = await supabase
    .from('call_records')
    .select('twilio_data')
    .eq('twilio_call_sid', callSid)
    .maybeSingle();

  const conferenceName = (() => {
    const data = callRow?.twilio_data;
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      const value = (data as Record<string, unknown>).conference_name;
      if (typeof value === 'string' && value.length > 0) return value;
    }
    return `call-${callSid}`;
  })();

  const commandId = crypto.randomUUID();
  const requestedAt = new Date().toISOString();

  publishCanonicalClientEvent({
    id: commandId,
    type: 'call_updated',
    timestamp: requestedAt,
    call_sid: callSid,
    agent_user_id: targetUserIds[0] ?? null,
    target_user_ids: targetUserIds,
    payload: {
      command: 'accept',
      command_id: commandId,
      call_sid: callSid,
      conference_name: conferenceName,
      target_user_ids: targetUserIds,
      requested_at: requestedAt,
      requested_by_user_id: auth.userId ?? null,
      requested_via: auth.authMethod,
    },
  });

  await auditLog('call.accept_requested', 'call_record', callSid, auth.userId, {
    call_sid: callSid,
    target_user_ids: targetUserIds,
    requested_user_id: parsed.data.user_id ?? null,
    requested_rdn_user_id: parsed.data.rdn_user_id ?? null,
    auth_method: auth.authMethod,
  });

  return apiSuccess({
    requested: true,
    call_sid: callSid,
    target_user_ids: targetUserIds,
    command_id: commandId,
    note: 'Solicitud enviada al cliente agente. La aceptacion final depende de softphone activo.',
  });
}
