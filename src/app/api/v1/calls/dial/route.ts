import { NextRequest } from 'next/server';
import { authenticate, isAuthenticated } from '@/lib/api/auth';
import { apiSuccess, apiBadRequest, apiInternalError } from '@/lib/api/response';
import { dialSchema } from '@/lib/api/validation';
import { getTwilioClient } from '@/lib/twilio/client';
import { createCallRecord } from '@/lib/twilio/call-engine';
import { createAdminClient } from '@/lib/supabase/admin';
import { auditLog } from '@/lib/api/audit';
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

    // Agent-attached mode: call agent on phone + browser simultaneously,
    // when they pick up → connect to destination via outbound-connect webhook.
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
        `[DIAL] Resolved agent id=${resolvedAgent.id} name=${resolvedAgent.name} phone=${resolvedAgent.phone ?? 'none'} available=${resolvedAgent.available} active=${resolvedAgent.active} rdn_user_id=${resolvedAgent.rdn_user_id ?? '-'}`
      );

      // If agent has no phone and no client can be reached, we still try client
      // (it will fail with SIP 480 if offline, but that's handled by dial-action)
      const hasPhone = Boolean(resolvedAgent.phone);

      if (!hasPhone) {
        console.log(`[DIAL] Agent has no phone number, trying client:${resolvedAgent.id} only`);
      } else {
        console.log(`[DIAL] Calling agent on phone ${resolvedAgent.phone} + client:${resolvedAgent.id} simultaneously`);
      }

      // Use a TwiML-based approach: create the call to a TwiML URL that
      // dials the agent on both channels. When agent picks up, connect to destination.
      // We call the destination number directly, and use a whisper/connect URL.

      // Create the parent call using TwiML that dials both agent endpoints
      const twimlDialUrl = new URL(`${baseUrl}/api/webhooks/twilio/voice/agent-dial`);
      twimlDialUrl.searchParams.set('agent_id', resolvedAgent.id);
      twimlDialUrl.searchParams.set('agent_phone', resolvedAgent.phone || '');
      twimlDialUrl.searchParams.set('destination', destination_number);
      twimlDialUrl.searchParams.set('caller_id', from_number);
      twimlDialUrl.searchParams.set('source', commandSource);

      const call = await twilioClient.calls.create({
        to: resolvedAgent.phone || `client:${resolvedAgent.id}`,
        from: from_number,
        url: `${baseUrl}/api/webhooks/twilio/voice/outbound-connect?caller_id=${encodeURIComponent(from_number)}&destination=${encodeURIComponent(destination_number)}&user_id=${encodeURIComponent(resolvedAgent.id)}&source=${encodeURIComponent(commandSource)}`,
        statusCallback: `${baseUrl}/api/webhooks/twilio/voice/status`,
        statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
        machineDetection: 'Enable',
        timeout: 30,
      });

      const callRecordId = await createCallRecord({
        twilioCallSid: call.sid,
        direction: 'outbound',
        fromNumber: from_number,
        toNumber: destination_number,
        status: 'ringing',
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
          agent_phone: resolvedAgent.phone ?? '',
          metadata_json: metadataJson,
        },
      });

      await auditLog('call.dial', 'call_record', callRecordId, auth.userId, {
        destination: destination_number,
        from: from_number,
        initiator: auth.userId ? initiatorName : resolvedAgent.name,
        source: commandSource,
        requested_user_id: user_id ?? null,
        requested_rdn_user_id: rdn_user_id ?? null,
        resolved_agent_id: resolvedAgent.id,
        attach_mode: hasPhone ? 'phone_primary' : 'twilio_client',
      });

      return apiSuccess({
        call_sid: call.sid,
        call_record_id: callRecordId,
        status: 'initiated',
        from: from_number,
        to: destination_number,
        attach_mode: hasPhone ? 'phone_primary' : 'twilio_client',
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
  } catch (err) {
    console.error('[DIAL] Error creating outbound call:', err);
    return apiInternalError('Error al iniciar la llamada');
  }
}
