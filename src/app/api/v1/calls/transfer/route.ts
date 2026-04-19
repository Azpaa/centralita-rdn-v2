import { NextRequest } from 'next/server';
import twilio from 'twilio';
import { authenticate, isAuthenticated } from '@/lib/api/auth';
import { apiSuccess, apiBadRequest, apiInternalError } from '@/lib/api/response';
import { getTwilioClient } from '@/lib/twilio/client';
import { emitEvent } from '@/lib/events/emitter';
import { requireCallControlPermission } from '@/lib/calls/ownership';
import { auditLog } from '@/lib/api/audit';
import { createAdminClient } from '@/lib/supabase/admin';

type TransferCallRecordRow = {
  twilio_call_sid: string | null;
  twilio_data: Record<string, unknown> | null;
};

function normalizeSid(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const sid = value.trim();
  return sid.length > 0 ? sid : null;
}

function extractAgentCallSid(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return normalizeSid((value as Record<string, unknown>).agent_call_sid);
}

/**
 * POST /api/v1/calls/transfer
 * Transferencia en frio (blind transfer).
 *
 * Body: { callSid: string, destination: string, callerId?: string }
 */
export async function POST(req: NextRequest) {
  const auth = await authenticate(req);
  if (!isAuthenticated(auth)) return auth;

  let body: { callSid?: string; destination?: string; callerId?: string };
  try {
    body = await req.json();
  } catch {
    return apiBadRequest('Body JSON invalido');
  }

  const { callSid, destination, callerId } = body;
  if (!callSid || !destination) {
    return apiBadRequest('callSid y destination son requeridos');
  }

  const permissionCheck = await requireCallControlPermission(auth, callSid);
  if (permissionCheck !== true) return permissionCheck;

  try {
    const client = getTwilioClient();
    const supabase = createAdminClient();

    // 1) Resolver caller leg (a transferir) y agent leg (a cerrar).
    let remoteCallSid: string | null = null;
    let originalCallSid: string | null = null;
    let agentCallSid: string | null = null;

    // A. SID recibido corresponde a la leg del agente.
    const { data: recordByAgent } = await supabase
      .from('call_records')
      .select('twilio_call_sid, twilio_data')
      .filter('twilio_data->>agent_call_sid', 'eq', callSid)
      .eq('status', 'in_progress')
      .maybeSingle();

    if (recordByAgent) {
      const row = recordByAgent as TransferCallRecordRow;
      originalCallSid = normalizeSid(row.twilio_call_sid);
      agentCallSid = normalizeSid(callSid) || extractAgentCallSid(row.twilio_data);
      console.log(
        `[TRANSFER] Resolved via agent_call_sid: caller=${originalCallSid ?? '-'} agent=${agentCallSid ?? '-'}`
      );
    }

    // B. SID recibido ya es el caller original.
    if (!originalCallSid) {
      const { data: recordByOriginalSid } = await supabase
        .from('call_records')
        .select('twilio_call_sid, twilio_data')
        .eq('twilio_call_sid', callSid)
        .eq('status', 'in_progress')
        .maybeSingle();

      if (recordByOriginalSid) {
        const row = recordByOriginalSid as TransferCallRecordRow;
        originalCallSid = normalizeSid(row.twilio_call_sid);
        agentCallSid = extractAgentCallSid(row.twilio_data);
        console.log(
          `[TRANSFER] Resolved via twilio_call_sid: caller=${originalCallSid ?? '-'} agent=${agentCallSid ?? '-'}`
        );
      }
    }

    // C. Fallback por agente autenticado.
    if (!originalCallSid && auth.userId) {
      const { data: recordByUser } = await supabase
        .from('call_records')
        .select('twilio_call_sid, twilio_data')
        .eq('answered_by_user_id', auth.userId)
        .eq('status', 'in_progress')
        .order('started_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (recordByUser) {
        const row = recordByUser as TransferCallRecordRow;
        originalCallSid = normalizeSid(row.twilio_call_sid);
        agentCallSid = agentCallSid || extractAgentCallSid(row.twilio_data);
        console.log(
          `[TRANSFER] Resolved via answered_by_user_id: caller=${originalCallSid ?? '-'} agent=${agentCallSid ?? '-'}`
        );
      }
    }

    // Si no tenemos mapping explicito, usar el callSid recibido como referencia principal.
    const effectiveCallSid = originalCallSid || callSid;

    // 2) Intentar resolver en conferencia call-{effectiveCallSid}.
    const conferenceName = `call-${effectiveCallSid}`;
    try {
      const conferences = await client.conferences.list({
        friendlyName: conferenceName,
        status: 'in-progress',
        limit: 1,
      });

      if (conferences.length > 0) {
        const participants = await client
          .conferences(conferences[0].sid)
          .participants.list();

        const participantSids = new Set(participants.map((p) => p.callSid));

        // Regla principal: transferir el caller original si esta en sala.
        if (participantSids.has(effectiveCallSid)) {
          remoteCallSid = effectiveCallSid;
        }

        // Si no, elegir participante que no parezca leg de agente.
        if (!remoteCallSid) {
          const agentSidCandidates = new Set<string>();
          const requestSid = normalizeSid(callSid);
          if (requestSid) agentSidCandidates.add(requestSid);
          if (agentCallSid) agentSidCandidates.add(agentCallSid);

          const callerCandidate = participants.find((p) => !agentSidCandidates.has(p.callSid));
          if (callerCandidate) {
            remoteCallSid = callerCandidate.callSid;
          } else if (participants.length === 1) {
            remoteCallSid = participants[0].callSid;
          }
        }

        // Derivar leg del agente si aun no esta resuelta.
        if (!agentCallSid) {
          const agentParticipant = participants.find((p) => p.callSid !== remoteCallSid);
          if (agentParticipant) agentCallSid = agentParticipant.callSid;
        }

        console.log(
          `[TRANSFER] Conference mode: conf=${conferenceName} participants=${participants.length} callerToTransfer=${remoteCallSid ?? '-'} agentLeg=${agentCallSid ?? '-'}`
        );
      }
    } catch {
      console.log(`[TRANSFER] No conference found for ${conferenceName}, trying fallback resolution`);
    }

    // 3) Fallback: el caller original ya es la leg a transferir.
    if (!remoteCallSid && effectiveCallSid !== callSid) {
      remoteCallSid = effectiveCallSid;
      console.log(`[TRANSFER] Using effective caller SID as transfer target: ${remoteCallSid}`);
    }

    // 4) Validar si effectiveCallSid existe como inbound en conference nombrada.
    if (!remoteCallSid) {
      const { data: record } = await supabase
        .from('call_records')
        .select('twilio_call_sid, direction')
        .eq('twilio_call_sid', effectiveCallSid)
        .maybeSingle();

      if (record?.direction === 'inbound') {
        try {
          const confs = await client.conferences.list({
            friendlyName: `call-${effectiveCallSid}`,
            status: 'in-progress',
            limit: 1,
          });
          if (confs.length > 0) {
            remoteCallSid = effectiveCallSid;
            console.log(`[TRANSFER] Caller SID confirmed in inbound record: ${remoteCallSid}`);
          }
        } catch {
          // ignore
        }
      }
    }

    // 5) Fallback legacy parent/child.
    if (!remoteCallSid) {
      const sidToInspect = agentCallSid || callSid;
      const callInfo = await client.calls(sidToInspect).fetch();

      if (callInfo.parentCallSid) {
        remoteCallSid = callInfo.parentCallSid;
        agentCallSid = sidToInspect;
      } else {
        const children = await client.calls.list({
          parentCallSid: sidToInspect,
          status: 'in-progress',
          limit: 5,
        });

        if (children.length > 0) {
          remoteCallSid = children[0].sid;
          agentCallSid = sidToInspect;
        }
      }
    }

    if (!remoteCallSid) {
      return apiBadRequest('No se encontro la otra parte de la llamada. Puede que ya haya colgado.');
    }

    console.log(
      `[TRANSFER] requestedSid=${callSid} callerToTransfer=${remoteCallSid} agentLeg=${agentCallSid ?? '-'} destination=${destination}`
    );

    // 6) TwiML de transferencia: mover caller actual al nuevo destino.
    const twimlBuilder = new twilio.twiml.VoiceResponse();

    twimlBuilder.say(
      { language: 'es-ES', voice: 'Polly.Conchita' },
      'Transfiriendo su llamada. Un momento por favor.'
    );

    const dial = twimlBuilder.dial({
      callerId: callerId || undefined,
      timeout: 30,
    });

    if (destination.startsWith('client:')) {
      dial.client(destination.replace('client:', ''));
    } else {
      dial.number(destination);
    }

    twimlBuilder.say(
      { language: 'es-ES', voice: 'Polly.Conchita' },
      'La transferencia ha finalizado. Gracias por llamar.'
    );
    twimlBuilder.hangup();

    const twimlString = twimlBuilder.toString();

    // 7) Aplicar TwiML al caller que debe transferirse.
    await client.calls(remoteCallSid).update({ twiml: twimlString });

    // 8) Cerrar la leg del agente (nunca cerrar la leg transferida).
    const legToComplete = (agentCallSid && agentCallSid !== remoteCallSid)
      ? agentCallSid
      : (callSid !== remoteCallSid ? callSid : null);

    if (legToComplete) {
      try {
        await client.calls(legToComplete).update({ status: 'completed' });
      } catch {
        // Ya estaba desconectada.
      }
    }

    emitEvent('call.transferred', {
      call_sid: callSid,
      remote_call_sid: remoteCallSid,
      destination,
      transferred_by: auth.userId ?? 'api_key',
    });

    await auditLog('call.transfer', 'call_record', callSid, auth.userId, {
      call_sid: callSid,
      remote_call_sid: remoteCallSid,
      destination,
      caller_id: callerId ?? null,
      agent_call_sid: agentCallSid,
      auth_method: auth.authMethod,
    });

    return apiSuccess({ transferred: true, callSid: remoteCallSid, destination });
  } catch (err) {
    console.error('[TRANSFER] Error:', err);
    return apiInternalError('Error al transferir la llamada');
  }
}
