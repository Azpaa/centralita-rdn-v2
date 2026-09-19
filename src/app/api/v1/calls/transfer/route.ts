import { NextRequest } from 'next/server';
import twilio from 'twilio';
import { authenticate, isAuthenticated } from '@/lib/api/auth';
import { apiSuccess, apiBadRequest, apiError, apiInternalError } from '@/lib/api/response';
import { getTwilioClient } from '@/lib/twilio/client';
import { emitEvent } from '@/lib/events/emitter';
import { requireCallControlPermission } from '@/lib/calls/ownership';
import { auditLog } from '@/lib/api/audit';
import { createAdminClient } from '@/lib/supabase/admin';
import {
  TRANSFER_RING_TIMEOUT_MS,
  isAgentTransferEnabled,
  startAgentTransfer,
} from '@/lib/calls/transfer';

type TransferCallRecordRow = {
  twilio_call_sid: string | null;
  twilio_data: Record<string, unknown> | null;
  answered_by_user_id?: string | null;
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Destino de tipo COMPAÑERO: `destination: "client:<user_id>"` (contrato
 * actual de RDN) o, más directo, `target_user_id` / `target_rdn_user_id` —
 * con este último RDN no necesita su tabla centralita_user_links.
 */
function resolveAgentTarget(body: Record<string, unknown>): { userId?: string; rdnUserId?: string } | null {
  // El body viene del cliente: nada de .trim() sobre algo que no sea texto
  // (daba un 500), y un id que no es UUID se trata como destino inválido en
  // vez de acabar en un 404 engañoso contra la columna uuid.
  const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');

  const userId = text(body.target_user_id);
  if (userId) return UUID_RE.test(userId) ? { userId } : { userId: '' };

  const rdnUserId = text(body.target_rdn_user_id);
  if (rdnUserId) return { rdnUserId };

  const destination = text(body.destination);
  if (destination.startsWith('client:')) {
    const identity = destination.slice('client:'.length);
    return UUID_RE.test(identity) ? { userId: identity } : { userId: '' };
  }
  return null;
}

/**
 * POST /api/v1/calls/transfer
 *
 * - A un NÚMERO externo: transferencia en frío — el llamante sale de la sala
 *   hacia un `<Dial><Number>`.
 * - A un COMPAÑERO: transferencia dentro de la sala (lib/calls/transfer.ts).
 *   El cliente espera con música, al compañero le suena su Tauri y, si no
 *   contesta, el cliente vuelve con quien transfería. Responde 200 con
 *   `pending: true` en cuanto empieza a sonar; el resultado llega por eventos
 *   (`call.answered` + `call.transferred` si se completa).
 *
 * Body: { callSid: string, destination?: string, callerId?: string,
 *         target_user_id?: string, target_rdn_user_id?: string }
 */
export async function POST(req: NextRequest) {
  const auth = await authenticate(req);
  if (!isAuthenticated(auth)) return auth;

  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await req.json();
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return apiBadRequest('Body JSON invalido');
    }
    body = parsed as Record<string, unknown>;
  } catch {
    return apiBadRequest('Body JSON invalido');
  }

  const callSid = typeof body.callSid === 'string' ? body.callSid.trim() : '';
  const destination = typeof body.destination === 'string' ? body.destination.trim() : '';
  const callerId = typeof body.callerId === 'string' ? body.callerId : undefined;
  const agentTarget = resolveAgentTarget(body);
  if (!callSid || (!destination && !agentTarget)) {
    return apiBadRequest('callSid y destination son requeridos');
  }

  const permissionCheck = await requireCallControlPermission(auth, callSid);
  if (permissionCheck !== true) return permissionCheck;

  // ── Transferencia a un compañero: siempre dentro de la sala. ────────────
  // El camino antiguo (`<Dial><Client>`) no puede llegar a un Tauri, que no
  // registra Device en Twilio: colgaba al cliente. No se vuelve a él ni con
  // el flag apagado.
  if (agentTarget) {
    if (!isAgentTransferEnabled()) {
      return apiError(
        409,
        'agent_transfer_disabled',
        'La transferencia entre compañeros está desactivada temporalmente.',
      );
    }
    try {
      const result = await startAgentTransfer({
        callSid,
        target: agentTarget,
        requestedByUserId: auth.userId ?? null,
        authMethod: auth.authMethod,
      });
      if (!result.ok) {
        return apiError(result.status, result.code, result.message);
      }
      return apiSuccess({
        transferred: false,
        pending: true,
        mode: 'in_room',
        transfer_id: result.transfer.id,
        state: result.transfer.state,
        callSid: result.transfer.caller_call_sid,
        destination: `client:${result.target.id}`,
        target_user_id: result.target.id,
        target_name: result.target.name,
        ring_timeout_seconds: Math.round(TRANSFER_RING_TIMEOUT_MS / 1000),
      });
    } catch (err) {
      console.error('[TRANSFER] Error iniciando transferencia a compañero:', err);
      return apiInternalError('Error al transferir la llamada');
    }
  }

  if (!destination) {
    return apiBadRequest('callSid y destination son requeridos');
  }

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

    // Los destinos `client:` (compañeros) ya salieron arriba por el flujo en
    // sala; aquí solo llegan números externos.
    dial.number(destination);

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

    // 9) Liberar ownership del agente para que pueda recibir nuevas llamadas
    // sin esperar a que finalice la llamada transferida.
    const transferRecordSid = originalCallSid || effectiveCallSid;
    if (transferRecordSid) {
      const { data: transferRecord } = await supabase
        .from('call_records')
        .select('answered_by_user_id, twilio_data')
        .eq('twilio_call_sid', transferRecordSid)
        .maybeSingle();

      if (transferRecord) {
        const transferAt = new Date().toISOString();
        const transferRecordRow = transferRecord as TransferCallRecordRow;
        const currentTwilioData = (transferRecordRow.twilio_data && typeof transferRecordRow.twilio_data === 'object')
          ? transferRecordRow.twilio_data
          : {};
        const transferredByUser = auth.userId ?? null;

        await supabase
          .from('call_records')
          .update({
            status: 'forwarded',
            answered_by_user_id: null,
            twilio_data: {
              ...currentTwilioData,
              transfer_destination: destination,
              transferred_at: transferAt,
              transferred_by_user_id: transferredByUser,
              transfer_previous_answered_by_user_id: transferRecordRow.answered_by_user_id ?? null,
              transfer_agent_call_sid: legToComplete ?? agentCallSid ?? null,
              transfer_agent_released: true,
              transfer_agent_released_at: transferAt,
            },
          })
          .eq('twilio_call_sid', transferRecordSid);

        console.log(`[TRANSFER] Agent released for new queue calls: ${transferRecordSid}`);
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
