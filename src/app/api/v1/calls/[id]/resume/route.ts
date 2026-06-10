import { NextRequest } from 'next/server';
import twilio from 'twilio';
import { authenticate, isAuthenticated } from '@/lib/api/auth';
import { apiSuccess, apiBadRequest, apiInternalError } from '@/lib/api/response';
import { getTwilioClient } from '@/lib/twilio/client';
import { emitEvent } from '@/lib/events/emitter';
import { requireCallControlPermission } from '@/lib/calls/ownership';
import { auditLog } from '@/lib/api/audit';
import {
  resolveHoldLegs,
  loadCallRecord,
  mergeTwilioData,
  normalizeSid,
} from '@/lib/calls/leg-resolution';

type TwilioClient = ReturnType<typeof getTwilioClient>;

/**
 * POST /api/v1/calls/:id/resume
 * Saca una llamada de espera (reconecta con el agente).
 *
 *  - Hold de conferencia (entrantes): basta con quitar el hold nativo del
 *    participante remoto; el agente nunca abandonó la sala.
 *
 *  - Hold `<Dial>` (salientes): el agente quedó aparcado y el cliente con música.
 *    Re-puenteamos ambas legs en una conferencia efímera usando los SIDs que
 *    guardó `/hold`, con `endConferenceOnExit` correcto para que la sala se
 *    cierre cuando el agente cuelgue (antes quedaba abierta para siempre).
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

  try {
    const client = getTwilioClient();
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
    const holdUrl = `${baseUrl}/api/webhooks/twilio/voice/wait-silence`;

    const { recordSid, twilioData } = await loadCallRecord(callSid);
    const recSid = recordSid ?? callSid;

    const hold =
      twilioData.hold && typeof twilioData.hold === 'object' && !Array.isArray(twilioData.hold)
        ? (twilioData.hold as Record<string, unknown>)
        : null;

    const holdMode = hold ? normalizeSid(hold.mode) : null;
    const storedRemote = hold ? normalizeSid(hold.remote_call_sid) : null;
    const storedAgent = hold ? normalizeSid(hold.agent_call_sid) : null;
    const storedConference = hold ? normalizeSid(hold.conference_name) : null;

    // ── Caso 1: hold nativo de conferencia → quitar el hold (idempotente). ──
    if (holdMode === 'conference' && storedRemote) {
      const unheld = await tryConferenceUnhold(client, storedRemote, [
        storedConference,
        recordSid ? `call-${recordSid}` : null,
        `call-${callSid}`,
      ]);
      if (unheld) {
        return finishResume(auth, recSid, callSid, storedRemote, unheld, 'conference');
      }
      // Si la conferencia desapareció, caemos al puente efímero de abajo.
    }

    // ── Caso 2: hold `<Dial>` con SIDs guardados → re-puentear. ──
    if (holdMode === 'dial' && storedRemote && storedAgent) {
      const confName = await bridgeIntoConference(client, baseUrl, holdUrl, storedAgent, storedRemote, recSid);
      return finishResume(auth, recSid, callSid, storedRemote, confName, 'bridge');
    }

    // ── Fallback: sin estado de hold utilizable. Resolver en vivo. ──
    const ctx = await resolveHoldLegs(callSid);

    // Si está en conferencia, un unhold idempotente nunca rompe una llamada viva.
    if (ctx.isConference && ctx.remoteCallSid) {
      const unheld = await tryConferenceUnhold(client, ctx.remoteCallSid, [
        ctx.conferenceName,
        storedConference,
      ]);
      if (unheld) {
        return finishResume(auth, recSid, callSid, ctx.remoteCallSid, unheld, 'conference');
      }
    }

    const remoteSid = storedRemote || ctx.remoteCallSid;
    const agentSid = storedAgent || ctx.agentCallSid || ctx.primaryCallSid || callSid;
    if (!remoteSid) {
      return apiBadRequest('No se encontró la otra parte de la llamada. Puede que ya haya colgado.');
    }

    const confName = await bridgeIntoConference(client, baseUrl, holdUrl, agentSid, remoteSid, recSid);
    return finishResume(auth, recSid, callSid, remoteSid, confName, 'bridge');
  } catch (err) {
    console.error(`[RESUME] Error resuming ${callSid}:`, err);
    return apiInternalError('Error al sacar de espera');
  }
}

/**
 * Intenta quitar el hold nativo de un participante en la primera conferencia
 * activa que coincida con los nombres candidatos. Devuelve el nombre de la
 * conferencia si lo logró, o null si no encontró conferencia activa.
 */
async function tryConferenceUnhold(
  client: TwilioClient,
  participantSid: string,
  conferenceNameCandidates: Array<string | null | undefined>,
): Promise<string | null> {
  const seen = new Set<string>();
  for (const name of conferenceNameCandidates) {
    const normalized = normalizeSid(name);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);

    const conferences = await client.conferences.list({
      friendlyName: normalized,
      status: 'in-progress',
      limit: 1,
    });
    if (conferences.length === 0) continue;

    try {
      await client
        .conferences(conferences[0].sid)
        .participants(participantSid)
        .update({ hold: false });
      return normalized;
    } catch {
      // El participante puede no estar en esta sala; probar el siguiente nombre.
    }
  }
  return null;
}

/**
 * Re-puentea la leg del agente (aparcada) y la del cliente (en música) en una
 * conferencia efímera. El agente la inicia y la cierra al salir; el cliente
 * espera con música hasta que el agente entra.
 */
async function bridgeIntoConference(
  client: TwilioClient,
  baseUrl: string,
  holdUrl: string,
  agentSid: string,
  remoteSid: string,
  recSid: string,
): Promise<string> {
  const confName = `resume-${recSid}-${Date.now()}`;

  const agentTwiml = new twilio.twiml.VoiceResponse();
  agentTwiml
    .dial({ action: `${baseUrl}/api/webhooks/twilio/voice/dial-action` })
    .conference(
      {
        startConferenceOnEnter: true,
        // NOTA F1.4: aquí se CONSERVA endConferenceOnExit:true a propósito.
        // En salientes el registro está clavado en la leg del agente
        // (twilio_call_sid = leg del agente), así que el room-watchdog —
        // que razona con "parent = llamante" — actuaría sobre la leg
        // equivocada. Sin watchdog aplicable, quitar el flag dejaría al
        // cliente en limbo si el softphone muere. Pendiente para la fase
        // de robustez de salientes.
        endConferenceOnExit: true,
        beep: 'false',
        statusCallbackEvent: ['join', 'leave', 'end'],
        statusCallback: `${baseUrl}/api/webhooks/twilio/voice/status`,
      },
      confName,
    );

  const remoteTwiml = new twilio.twiml.VoiceResponse();
  remoteTwiml.dial().conference(
    {
      startConferenceOnEnter: false,
      endConferenceOnExit: false,
      beep: 'false',
      waitUrl: holdUrl,
      statusCallbackEvent: ['join', 'leave', 'end'],
      statusCallback: `${baseUrl}/api/webhooks/twilio/voice/status`,
    },
    confName,
  );

  // Orden de COMPENSACIÓN: primero el cliente (entra con
  // startConferenceOnEnter:false, así que queda esperando con música — la
  // misma experiencia que el hold), después el agente, que inicia la sala y
  // abre el puente. Si la redirección del agente falla, el cliente sigue en
  // espera y el estado de hold queda INTACTO, de modo que /resume puede
  // reintentarse. (El orden antiguo movía primero al agente: si la segunda
  // redirección fallaba, el agente quedaba solo en una sala vacía y el
  // cliente atrapado en el bucle de música sin ningún estado que permitiera
  // recuperarlo.)
  await client.calls(remoteSid).update({ twiml: remoteTwiml.toString() });
  try {
    await client.calls(agentSid).update({ twiml: agentTwiml.toString() });
  } catch (agentErr) {
    console.error(
      `[RESUME] No se pudo mover la leg del agente ${agentSid} al puente ${confName} — el cliente sigue en espera y el hold queda intacto para reintentar:`,
      agentErr,
    );
    throw agentErr;
  }

  // Guardamos el nombre de la conferencia para que un futuro /hold la encuentre
  // y use el hold nativo. Solo tras puentear AMBAS legs con éxito.
  await mergeTwilioData(recSid, {
    hold: { held: false, at: new Date().toISOString() },
    hold_restructure: null,
    conference_name: confName,
  });

  return confName;
}

async function finishResume(
  auth: { userId: string | null; authMethod: 'session' | 'api_key' },
  recSid: string,
  callSid: string,
  remoteSid: string,
  conference: string,
  mode: 'conference' | 'bridge',
) {
  if (mode === 'conference') {
    // El puente efímero ya limpió el estado; para el unhold nativo lo hacemos aquí.
    await mergeTwilioData(recSid, {
      hold: { held: false, at: new Date().toISOString() },
      hold_restructure: null,
    });
  }

  emitEvent('call.resumed', {
    call_sid: callSid,
    remote_call_sid: remoteSid,
    by_user_id: auth.userId ?? 'api_key',
  });

  await auditLog('call.resume', 'call_record', callSid, auth.userId, {
    call_sid: callSid,
    remote_call_sid: remoteSid,
    conference,
    mode,
    auth_method: auth.authMethod,
  });

  return apiSuccess({ resumed: true, callSid, remoteSid, conference, mode });
}
