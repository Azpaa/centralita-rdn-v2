import { NextRequest } from 'next/server';
import twilio from 'twilio';
import { authenticate, isAuthenticated } from '@/lib/api/auth';
import { apiSuccess, apiBadRequest, apiInternalError } from '@/lib/api/response';
import { getTwilioClient } from '@/lib/twilio/client';
import { emitEvent } from '@/lib/events/emitter';

interface Params {
  params: Promise<{ callSid: string }>;
}

/**
 * POST /api/v1/calls/:callSid/resume
 * Saca una llamada de espera (reconecta con el agente).
 *
 * Implementación: mueve ambas partes a una conferencia efímera.
 * Esto es más fiable que intentar re-dial porque la llamada ya está viva.
 */
export async function POST(req: NextRequest, { params }: Params) {
  const auth = await authenticate(req);
  if (!isAuthenticated(auth)) return auth;

  const { callSid } = await params;
  if (!callSid) return apiBadRequest('callSid es requerido');

  try {
    const client = getTwilioClient();

    // Encontrar la leg remota
    const callInfo = await client.calls(callSid).fetch();
    let remoteSid: string;

    if (callInfo.parentCallSid) {
      remoteSid = callInfo.parentCallSid;
    } else {
      const children = await client.calls.list({
        parentCallSid: callSid,
        status: 'in-progress',
        limit: 1,
      });
      if (children.length === 0) {
        return apiBadRequest('No se encontró la otra parte de la llamada');
      }
      remoteSid = children[0].sid;
    }

    // Crear conferencia efímera para reconectar ambas partes
    const confName = `resume-${callSid}-${Date.now()}`;

    const confTwiml = new twilio.twiml.VoiceResponse();
    const dial = confTwiml.dial();
    dial.conference(
      {
        startConferenceOnEnter: true,
        endConferenceOnExit: false,
        beep: false,
      },
      confName,
    );
    const confTwimlStr = confTwiml.toString();

    // Mover ambas legs a la conferencia en paralelo
    await Promise.all([
      client.calls(remoteSid).update({ twiml: confTwimlStr }),
      client.calls(callSid).update({ twiml: confTwimlStr }),
    ]);

    // Emitir evento
    emitEvent('call.resumed', {
      call_sid: callSid,
      remote_call_sid: remoteSid,
      by_user_id: auth.userId ?? 'api_key',
    });

    return apiSuccess({ resumed: true, callSid, remoteSid, conference: confName });
  } catch (err) {
    console.error(`[RESUME] Error resuming ${callSid}:`, err);
    return apiInternalError('Error al sacar de espera');
  }
}
