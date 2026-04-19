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
import type { PhoneNumber, User } from '@/lib/types/database';

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
