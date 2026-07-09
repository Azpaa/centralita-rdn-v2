import { NextRequest } from 'next/server';
import twilio from 'twilio';
import { authenticate, isAuthenticated } from '@/lib/api/auth';
import { apiSuccess, apiBadRequest, apiInternalError } from '@/lib/api/response';
import { getTwilioClient } from '@/lib/twilio/client';
import { emitEvent } from '@/lib/events/emitter';
import { requireCallControlPermission } from '@/lib/calls/ownership';
import { auditLog } from '@/lib/api/audit';
import { resolveHoldLegs, mergeTwilioData } from '@/lib/calls/leg-resolution';

/**
 * POST /api/v1/calls/:id/hold
 * Pone una llamada en espera.
 *
 * Dos topologías posibles (ver leg-resolution.ts):
 *
 *  - Conferencia (llamadas entrantes): usamos el HOLD NATIVO de Twilio sobre el
 *    participante remoto. El agente NO se mueve de la sala → cero riesgo de
 *    cuelgue. El cliente escucha música de espera (`holdUrl`).
 *
 *  - `<Dial>` (llamadas salientes): redirigimos al cliente a la música de espera
 *    y APARCAMOS la leg del agente. Al sacar al cliente del `<Dial>`, la leg del
 *    agente termina su Dial y sigue su `action` (dial-action); el guard de
 *    dial-action detecta el hold en curso y la mantiene viva con un `<Pause>` en
 *    vez de colgarla. `/resume` re-puentea ambas legs con los SIDs guardados.
 *
 * Body (opcional): { music_url?: string }
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

  let body: { music_url?: string } = {};
  try {
    body = await req.json();
  } catch {
    // Body vacío es OK
  }

  try {
    const client = getTwilioClient();
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
    const holdUrl = body.music_url?.trim()
      || `${baseUrl}/api/webhooks/twilio/voice/wait-silence`;
    const nowIso = new Date().toISOString();

    const ctx = await resolveHoldLegs(callSid);
    if (!ctx.remoteCallSid) {
      return apiBadRequest('No se encontró la otra parte de la llamada. Puede que ya haya colgado.');
    }

    const recordSid = ctx.primaryCallSid ?? callSid;
    const agentSid = ctx.agentCallSid ?? ctx.primaryCallSid ?? callSid;
    const mode: 'conference' | 'dial' = ctx.isConference && ctx.conferenceSid ? 'conference' : 'dial';

    if (mode === 'conference' && ctx.conferenceSid) {
      // Hold nativo de Twilio: el agente permanece en la sala, el cliente queda
      // aparcado con música. No se rompe ningún bridge → no hay cuelgue.
      await client
        .conferences(ctx.conferenceSid)
        .participants(ctx.remoteCallSid)
        .update({ hold: true, holdUrl, holdMethod: 'POST' });

      await mergeTwilioData(recordSid, {
        hold: {
          held: true,
          mode,
          conference_name: ctx.conferenceName,
          remote_call_sid: ctx.remoteCallSid,
          agent_call_sid: agentSid,
          at: nowIso,
        },
      });
    } else {
      // Saliente `<Dial>`: guardamos el estado de hold ANTES de redirigir (para
      // que el guard de dial-action lo vea cuando termine el Dial del agente).
      await mergeTwilioData(recordSid, {
        hold: {
          held: true,
          mode,
          remote_call_sid: ctx.remoteCallSid,
          agent_call_sid: agentSid,
          at: nowIso,
        },
        hold_restructure: { held: true, at: nowIso },
      });

      const holdTwiml = new twilio.twiml.VoiceResponse();
      holdTwiml.say(
        { language: 'es-ES', voice: 'Polly.Conchita' },
        'Un momento por favor, le ponemos en espera.'
      );
      holdTwiml.redirect({ method: 'POST' }, holdUrl);

      await client.calls(ctx.remoteCallSid).update({ twiml: holdTwiml.toString() });
    }

    emitEvent('call.hold', {
      call_sid: callSid,
      remote_call_sid: ctx.remoteCallSid,
      by_user_id: auth.userId ?? 'api_key',
    });

    void auditLog('call.hold', 'call_record', callSid, auth.userId, {
      call_sid: callSid,
      remote_call_sid: ctx.remoteCallSid,
      mode,
      music_url: body.music_url ?? null,
      auth_method: auth.authMethod,
    });

    return apiSuccess({ held: true, callSid, remoteSid: ctx.remoteCallSid, mode });
  } catch (err) {
    console.error(`[HOLD] Error holding ${callSid}:`, err);
    return apiInternalError('Error al poner en espera');
  }
}
