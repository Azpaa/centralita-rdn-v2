import crypto from 'crypto';
import { NextRequest } from 'next/server';
import { z } from 'zod';
import { authenticate, isAuthenticated } from '@/lib/api/auth';
import { apiBadRequest, apiSuccess } from '@/lib/api/response';
import { createAdminClient } from '@/lib/supabase/admin';
import { requireCallControlPermission } from '@/lib/calls/ownership';
import {
  pickPreferredExecutorForUser,
  publishCanonicalClientEvent,
} from '@/lib/events/client-stream';
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
    .select('twilio_data, answered_by_user_id, status')
    .eq('twilio_call_sid', callSid)
    .maybeSingle();

  const twilioDataRaw = callRow?.twilio_data;
  const twilioData =
    twilioDataRaw && typeof twilioDataRaw === 'object' && !Array.isArray(twilioDataRaw)
      ? (twilioDataRaw as Record<string, unknown>)
      : {};

  const conferenceName = (() => {
    const value = twilioData.conference_name;
    if (typeof value === 'string' && value.length > 0) return value;
    return `call-${callSid}`;
  })();

  // Server-side accept-idempotency.
  //
  // Original intent: RDN retries POST /accept when it doesn't see a timely
  // confirm. Without any guard, every retry emits a brand-new canonical
  // event with a unique event.id — Tauri's id-dedupe won't catch it, and
  // the softphone could race a second device.connect().
  //
  // Revised policy: short-circuit ONLY when the call has already been
  // confirmed end-to-end (accept_confirmed_at present). In that case the
  // softphone has media open and re-emitting a command would do nothing
  // useful. If no confirm yet, we MUST re-emit on every retry: the first
  // attempt may have reached the server but the canonical event may have
  // died mid-flight (SSE socket churn, worker race), and if we short-
  // circuit the retries, the softphone never gets a second chance. Tauri
  // itself protects against duplicate joinConference via the
  // `alreadyAttached` + `remoteAcceptInFlightRef` guards (see
  // executeRemoteAccept in App.tsx), so re-emission is safe.
  const confirmedAt = typeof twilioData.accept_confirmed_at === 'string'
    ? twilioData.accept_confirmed_at
    : null;

  if (confirmedAt) {
    const lastCommandId = typeof twilioData.accept_last_command_id === 'string'
      ? twilioData.accept_last_command_id
      : null;
    console.log(
      `[ACCEPT] ${callSid}: already confirmed (${confirmedAt}) — idempotent short-circuit last_command_id=${lastCommandId ?? '-'}`
    );
    return apiSuccess({
      requested: true,
      idempotent: true,
      call_sid: callSid,
      target_user_ids: targetUserIds,
      preferred_executor: typeof twilioData.accept_last_preferred_executor === 'string'
        ? twilioData.accept_last_preferred_executor
        : null,
      executor_user_id: typeof twilioData.accept_last_executor_user_id === 'string'
        ? twilioData.accept_last_executor_user_id
        : null,
      command_id: lastCommandId,
      confirmed_at: confirmedAt,
      note: 'Llamada ya confirmada por el softphone.',
    });
  }

  // Track retry count in twilio_data for observability — not to gate.
  const lastRequestedAtRaw = twilioData.accept_last_requested_at;
  const nowMs = Date.now();
  const lastRequestedAtMs = typeof lastRequestedAtRaw === 'string'
    ? Date.parse(lastRequestedAtRaw)
    : NaN;
  const ageSincePreviousMs = Number.isFinite(lastRequestedAtMs) ? nowMs - lastRequestedAtMs : -1;
  if (ageSincePreviousMs >= 0 && ageSincePreviousMs < 10_000) {
    console.log(
      `[ACCEPT] ${callSid}: retry within ${ageSincePreviousMs}ms — re-emitting (not confirmed yet)`,
    );
  }

  // Decide which surface should execute this accept: desktop (Tauri) if it's
  // present locally, otherwise the browser dashboard.
  //
  // IMPORTANT: the subscribers Map lives in `globalThis` on this Node process
  // only. In production (Vercel serverless) the SSE connection is held by one
  // Lambda while this POST may land on a different Lambda — that Lambda's
  // map is empty even when Tauri is actually listening. We must NOT 409 in
  // that case (it turns cross-worker into "no softphone" false negatives).
  //
  // Policy: if we see a subscriber locally, stamp preferred_executor for
  // same-worker accuracy. If we don't, publish with preferred_executor=null
  // and let Tauri fall back to legacy "default-execute" behaviour. Proper
  // fix is cluster-wide presence (tracked as a follow-up).
  let preferredExecutor: 'desktop' | 'browser' | null = null;
  let executorUserId: string | null = null;
  for (const uid of targetUserIds) {
    const pick = pickPreferredExecutorForUser(uid);
    if (!pick) continue;
    executorUserId = uid;
    preferredExecutor = pick;
    if (pick === 'desktop') break; // desktop wins, stop scanning
  }

  if (!preferredExecutor) {
    console.warn(
      `[ACCEPT] ${callSid}: no local SSE subscriber on this worker for ${targetUserIds.join(',')}. Publishing with preferred_executor=null (legacy fallback so Tauri default-executes via whichever worker holds the SSE).`
    );
  }

  const commandId = crypto.randomUUID();
  const requestedAt = new Date().toISOString();

  // Persist the accept-request fingerprint BEFORE emitting the event. If
  // two requests arrive within the dedupe window, the second reads the
  // fingerprint written by the first and short-circuits. We update inside
  // a merge so we don't blow away conference_name or other routing data
  // that the webhook wrote earlier.
  const mergedAcceptTrace: Record<string, unknown> = {
    ...twilioData,
    accept_last_requested_at: requestedAt,
    accept_last_command_id: commandId,
    accept_last_preferred_executor: preferredExecutor ?? null,
    accept_last_executor_user_id: executorUserId ?? null,
    accept_last_requested_by_user_id: auth.userId ?? null,
    accept_last_requested_via: auth.authMethod,
  };

  await supabase
    .from('call_records')
    .update({ twilio_data: mergedAcceptTrace })
    .eq('twilio_call_sid', callSid);

  await publishCanonicalClientEvent({
    id: commandId,
    type: 'call_updated',
    timestamp: requestedAt,
    call_sid: callSid,
    agent_user_id: executorUserId ?? targetUserIds[0] ?? null,
    target_user_ids: targetUserIds,
    payload: {
      command: 'accept',
      command_id: commandId,
      call_sid: callSid,
      conference_name: conferenceName,
      preferred_executor: preferredExecutor,
      executor_user_id: executorUserId,
      target_user_ids: targetUserIds,
      requested_at: requestedAt,
      requested_by_user_id: auth.userId ?? null,
      requested_via: auth.authMethod,
    },
  });

  await auditLog('call.accept_requested', 'call_record', callSid, auth.userId, {
    call_sid: callSid,
    target_user_ids: targetUserIds,
    preferred_executor: preferredExecutor,
    executor_user_id: executorUserId,
    requested_user_id: parsed.data.user_id ?? null,
    requested_rdn_user_id: parsed.data.rdn_user_id ?? null,
    auth_method: auth.authMethod,
  });

  return apiSuccess({
    requested: true,
    call_sid: callSid,
    target_user_ids: targetUserIds,
    preferred_executor: preferredExecutor,
    executor_user_id: executorUserId,
    command_id: commandId,
    note: 'Solicitud enviada al softphone activo del agente.',
  });
}
