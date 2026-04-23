import crypto from 'crypto';
import { NextRequest } from 'next/server';
import { authenticate, isAuthenticated } from '@/lib/api/auth';
import { apiSuccess, apiBadRequest, apiInternalError } from '@/lib/api/response';
import { dialSchema } from '@/lib/api/validation';
import { getTwilioClient } from '@/lib/twilio/client';
import { createCallRecord } from '@/lib/twilio/call-engine';
import { createAdminClient } from '@/lib/supabase/admin';
import { auditLog } from '@/lib/api/audit';
import { emitEvent } from '@/lib/events/emitter';
import type { CallStatus, PhoneNumber, User } from '@/lib/types/database';

const PRE_DIAL_RELEASE_STATUSES: CallStatus[] = ['in_progress', 'ringing', 'in_queue', 'pending_agent'];
const DIAL_FRESHNESS_WINDOW_MS = 30 * 1000;
const DIAL_TERMINAL_TWILIO_STATUSES = new Set(['completed', 'busy', 'no-answer', 'failed', 'canceled']);

type AgentDialCleanupRow = {
  id: string;
  twilio_call_sid: string | null;
  status: string;
  direction: 'inbound' | 'outbound';
  from_number: string;
  to_number: string;
  started_at: string;
  queue_id: string | null;
  answered_by_user_id: string | null;
  last_webhook_at: string | null;
  last_verified_at: string | null;
  twilio_data: Record<string, unknown> | null;
};

function mapDialTerminalStatus(status: string): CallStatus {
  if (status === 'no-answer') return 'no_answer';
  return status as CallStatus;
}

async function closePreDialRow(
  supabase: ReturnType<typeof createAdminClient>,
  row: AgentDialCleanupRow,
  destination: string,
  options: {
    reason: string;
    status: CallStatus;
    endedAt?: string;
    duration?: number;
    lastVerifiedAt?: string;
  },
): Promise<boolean> {
  const endedAt = options.endedAt ?? new Date().toISOString();
  const mergedTwilioData = {
    ...(row.twilio_data || {}),
    superseded_by_new_dial: true,
    superseded_by_new_dial_at: endedAt,
    superseded_by_new_dial_destination: destination,
    pre_dial_reconcile_reason: options.reason,
  };

  type UpdatePayload = {
    status: CallStatus;
    ended_at: string;
    twilio_data: Record<string, unknown>;
    duration?: number;
    last_verified_at?: string;
  };

  const update: UpdatePayload = {
    status: options.status,
    ended_at: endedAt,
    twilio_data: mergedTwilioData,
  };
  if (options.duration !== undefined) update.duration = options.duration;
  if (options.lastVerifiedAt) update.last_verified_at = options.lastVerifiedAt;

  const { data } = await supabase
    .from('call_records')
    .update(update)
    .eq('id', row.id)
    .is('ended_at', null)
    .select('id')
    .maybeSingle();

  if (!data) return false;

  const callSid = row.twilio_call_sid || '';
  if (row.direction === 'inbound' && options.status !== 'completed') {
    await emitEvent('call.missed', {
      call_sid: callSid,
      direction: row.direction,
      from: row.from_number ?? null,
      to: row.to_number ?? null,
      final_status: options.status,
      queue_id: row.queue_id ?? null,
      terminal_source: options.reason,
    });
  } else {
    await emitEvent('call.completed', {
      call_sid: callSid,
      direction: row.direction,
      status: options.status,
      from: row.from_number ?? null,
      to: row.to_number ?? null,
      queue_id: row.queue_id ?? null,
      answered_by_user_id: row.answered_by_user_id ?? null,
      duration: options.duration ?? 0,
      wait_time: null,
      answered_at: null,
      ended_at: endedAt,
      terminal_source: options.reason,
    });
  }

  return true;
}

async function reconcileAgentCallsBeforeNewDial(params: {
  supabase: ReturnType<typeof createAdminClient>;
  twilioClient: ReturnType<typeof getTwilioClient>;
  agentId: string;
  destination: string;
}): Promise<{ released: number; preserved: number }> {
  const { data } = await params.supabase
    .from('call_records')
    .select('id, twilio_call_sid, status, direction, from_number, to_number, started_at, queue_id, answered_by_user_id, last_webhook_at, last_verified_at, twilio_data')
    .eq('answered_by_user_id', params.agentId)
    .in('status', PRE_DIAL_RELEASE_STATUSES)
    .is('ended_at', null)
    .order('started_at', { ascending: true })
    .limit(10);

  const rows = (data || []) as AgentDialCleanupRow[];
  if (rows.length === 0) return { released: 0, preserved: 0 };

  const nowMs = Date.now();
  let released = 0;
  let preserved = 0;

  for (const row of rows) {
    const sid = (row.twilio_call_sid || '').trim();
    const isPending = !sid || sid.startsWith('pending-');

    // Placeholders without a real Twilio SID have no live carrier counterpart.
    // They are leftover pending_agent records from earlier failed dials.
    if (isPending) {
      const closed = await closePreDialRow(params.supabase, row, params.destination, {
        reason: 'stale_pending_before_new_dial',
        status: 'canceled',
      });
      if (closed) released += 1;
      continue;
    }

    // Freshness gate: if we've seen signal (webhook or live verification)
    // recently, treat the call as alive and leave it alone. That's the
    // core of Phase 4 — no more heuristic nuking of real live calls.
    const lastWebhookMs = row.last_webhook_at ? Date.parse(row.last_webhook_at) : 0;
    const lastVerifiedMs = row.last_verified_at ? Date.parse(row.last_verified_at) : 0;
    const latestSignalMs = Math.max(lastWebhookMs, lastVerifiedMs);
    const ageMs = latestSignalMs ? nowMs - latestSignalMs : Infinity;
    if (ageMs < DIAL_FRESHNESS_WINDOW_MS) {
      preserved += 1;
      continue;
    }

    const verifiedAt = new Date().toISOString();

    try {
      const liveCall = await params.twilioClient.calls(sid).fetch();
      const liveStatus = (liveCall.status || '').toLowerCase();

      if (!DIAL_TERMINAL_TWILIO_STATUSES.has(liveStatus)) {
        // Genuinely alive per Twilio API. Stamp verification, skip close.
        await params.supabase
          .from('call_records')
          .update({ last_verified_at: verifiedAt })
          .eq('id', row.id);
        preserved += 1;
        continue;
      }

      const endedAt = liveCall.endTime
        ? new Date(liveCall.endTime).toISOString()
        : new Date().toISOString();
      const parsedDuration = parseInt(String(liveCall.duration ?? '0'), 10);
      const safeDuration = Number.isFinite(parsedDuration) ? parsedDuration : 0;
      const terminalStatus = mapDialTerminalStatus(liveStatus);

      const closed = await closePreDialRow(params.supabase, row, params.destination, {
        reason: 'stale_before_new_dial_twilio_terminal',
        status: terminalStatus,
        endedAt,
        duration: safeDuration,
        lastVerifiedAt: verifiedAt,
      });
      if (closed) released += 1;
    } catch (err) {
      const code = (err as { code?: number; status?: number })?.code;
      const status = (err as { code?: number; status?: number })?.status;
      const isNotFound = code === 20404 || status === 404;
      if (!isNotFound) {
        console.warn(
          `[DIAL] Pre-dial reconcile could not verify agent=${params.agentId} sid=${sid}: ${
            err instanceof Error ? err.message : 'unknown_error'
          }`,
        );
        preserved += 1;
        continue;
      }

      const closed = await closePreDialRow(params.supabase, row, params.destination, {
        reason: 'stale_before_new_dial_twilio_404',
        status: 'canceled',
        lastVerifiedAt: verifiedAt,
      });
      if (closed) released += 1;
    }
  }

  return { released, preserved };
}

/**
 * POST /api/v1/calls/dial
 * Outbound dial endpoint.
 *
 * Two modes:
 * 1) Legacy direct PSTN: only destination_number + from_number
 * 2) Agent-attached (RDN): with user_id and/or rdn_user_id
 */
export async function POST(req: NextRequest) {
  const auth = await authenticate(req);
  if (!isAuthenticated(auth)) return auth;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return apiBadRequest('Body JSON invalido');
  }

  const parsed = dialSchema.safeParse(body);
  if (!parsed.success) {
    return apiBadRequest('Datos invalidos', parsed.error.flatten().fieldErrors);
  }

  const {
    destination_number,
    from_number,
    user_id,
    rdn_user_id,
    metadata,
  } = parsed.data;

  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';

  try {
    const supabase = createAdminClient();
    const commandSource = auth.authMethod === 'api_key' ? 'rdn' : 'backend_outbound';

    console.log(
      `[DIAL] Received auth=${auth.authMethod} destination=${destination_number} from=${from_number} user_id=${user_id ?? '-'} rdn_user_id=${rdn_user_id ?? '-'}`
    );

    // Validate caller number exists and is active in this account.
    const { data: phoneNum } = await supabase
      .from('phone_numbers')
      .select('*')
      .eq('phone_number', from_number)
      .eq('active', true)
      .single();

    if (!phoneNum) {
      return apiBadRequest('El numero de origen no es un numero Twilio activo.');
    }

    const activeNumber = phoneNum as PhoneNumber;

    let initiatorName = 'Sistema';
    if (auth.userId) {
      const { data: user } = await supabase
        .from('users')
        .select('id, name')
        .eq('id', auth.userId)
        .single();

      if (user) {
        const appUser = user as Pick<User, 'id' | 'name'>;
        initiatorName = appUser.name;
      }
    }

    // Resolve target agent if operational identity arrives from RDN.
    let resolvedAgent: User | null = null;

    if (user_id) {
      const { data: byId } = await supabase
        .from('users')
        .select('*')
        .eq('id', user_id)
        .eq('active', true)
        .is('deleted_at', null)
        .single();

      if (byId) resolvedAgent = byId as User;
    }

    if (!resolvedAgent && rdn_user_id) {
      const { data: byRdnId } = await supabase
        .from('users')
        .select('*')
        .eq('rdn_user_id', rdn_user_id)
        .eq('active', true)
        .is('deleted_at', null)
        .single();

      if (byRdnId) resolvedAgent = byRdnId as User;
    }

    const wantsAgentAttach = Boolean(user_id || rdn_user_id);

    if (wantsAgentAttach && !resolvedAgent) {
      return apiBadRequest(
        'No se pudo resolver el agente para la llamada (user_id/rdn_user_id invalido o sin vinculo).'
      );
    }

    if (auth.authMethod === 'api_key' && !resolvedAgent) {
      return apiBadRequest(
        'Para llamadas M2M se requiere user_id o rdn_user_id valido para enlazar la sesion del agente.'
      );
    }

    const twilioClient = getTwilioClient();

    // Agent-attached mode: emit SSE event so the agent's Tauri desktop app
    // (or browser) can initiate the call via device.connect().
    // The agent's device.connect() triggers the TwiML App voice URL (/client)
    // which generates <Dial><Number>destination</Number></Dial>.
    if (resolvedAgent) {
      const { released, preserved } = await reconcileAgentCallsBeforeNewDial({
        supabase,
        twilioClient,
        agentId: resolvedAgent.id,
        destination: destination_number,
      });

      if (released > 0 || preserved > 0) {
        console.log(
          `[DIAL] Pre-dial reconcile agent=${resolvedAgent.id} released=${released} preserved=${preserved}`
        );
      }

      let metadataJson = '';
      if (metadata) {
        try {
          metadataJson = JSON.stringify(metadata);
        } catch {
          metadataJson = '[invalid_metadata]';
        }
      }

      console.log(
        `[DIAL] Resolved agent id=${resolvedAgent.id} name=${resolvedAgent.name} rdn_user_id=${resolvedAgent.rdn_user_id ?? '-'}`
      );
      console.log(
        `[DIAL] Emitting outbound_connect_request to agent ${resolvedAgent.id} for destination ${destination_number}`
      );

      const callRecordId = await createCallRecord({
        twilioCallSid: `pending-${crypto.randomUUID().slice(0, 8)}`,
        direction: 'outbound',
        fromNumber: from_number,
        toNumber: destination_number,
        status: 'pending_agent',
        phoneNumberId: activeNumber.id,
        answeredByUserId: resolvedAgent.id,
        twilioData: {
          initiated_by: auth.userId || resolvedAgent.id,
          initiator_name: auth.userId ? initiatorName : resolvedAgent.name,
          source: commandSource,
          requested_user_id: user_id ?? '',
          requested_rdn_user_id: rdn_user_id ?? '',
          resolved_agent_id: resolvedAgent.id,
          resolved_agent_name: resolvedAgent.name,
          resolved_agent_available: resolvedAgent.available,
          metadata_json: metadataJson,
        },
      });

      // Emit SSE event for the agent's desktop app / browser to pick up
      emitEvent('call.ringing', {
        call_sid: `pending-dial-${(callRecordId ?? '').slice(0, 8)}`,
        call_record_id: callRecordId,
        direction: 'outbound',
        status: 'pending_agent',
        from: from_number,
        to: destination_number,
        user_id: resolvedAgent.id,
        answered_by_user_id: resolvedAgent.id,
        rdn_user_id: resolvedAgent.rdn_user_id ?? null,
        source: commandSource,
        outbound_connect_request: true,
        destination_number,
        caller_id: from_number,
        metadata_json: metadataJson,
      });

      await auditLog('call.dial', 'call_record', callRecordId, auth.userId, {
        destination: destination_number,
        from: from_number,
        initiator: auth.userId ? initiatorName : resolvedAgent.name,
        source: commandSource,
        requested_user_id: user_id ?? null,
        requested_rdn_user_id: rdn_user_id ?? null,
        resolved_agent_id: resolvedAgent.id,
        attach_mode: 'device_connect',
      });

      return apiSuccess({
        call_record_id: callRecordId,
        status: 'pending_agent',
        from: from_number,
        to: destination_number,
        attach_mode: 'device_connect',
        source: commandSource,
        agent: {
          id: resolvedAgent.id,
          rdn_user_id: resolvedAgent.rdn_user_id,
          available: resolvedAgent.available,
        },
      });
    }

    // Legacy direct flow: no explicit agent attachment.
    console.log('[DIAL] Using legacy direct PSTN flow (no explicit agent attach).');

    const call = await twilioClient.calls.create({
      to: destination_number,
      from: from_number,
      url: `${baseUrl}/api/webhooks/twilio/voice/outbound-connect?caller_id=${encodeURIComponent(from_number)}`,
      statusCallback: `${baseUrl}/api/webhooks/twilio/voice/status`,
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
    });

    const callRecordId = await createCallRecord({
      twilioCallSid: call.sid,
      direction: 'outbound',
      fromNumber: from_number,
      toNumber: destination_number,
      status: 'ringing',
      phoneNumberId: activeNumber.id,
      twilioData: {
        initiated_by: auth.userId || 'unknown',
        initiator_name: initiatorName,
        source: 'legacy_direct',
      },
    });

    await auditLog('call.dial', 'call_record', callRecordId, auth.userId, {
      destination: destination_number,
      from: from_number,
      initiator: initiatorName,
      source: 'legacy_direct',
    });

    return apiSuccess({
      call_sid: call.sid,
      call_record_id: callRecordId,
      status: 'initiated',
      from: from_number,
      to: destination_number,
      attach_mode: 'legacy_direct',
    });
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    const errCode = (err as Record<string, unknown>)?.code ?? '';
    const errStatus = (err as Record<string, unknown>)?.status ?? '';
    console.error(`[DIAL] Error creating outbound call: ${errMsg} code=${errCode} status=${errStatus}`, err);
    return apiInternalError(`Error al iniciar la llamada: ${errMsg}`);
  }
}
