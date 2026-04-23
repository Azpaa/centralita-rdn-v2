import { NextRequest } from 'next/server';
import twilio from 'twilio';
import { authenticate, isAuthenticated } from '@/lib/api/auth';
import { apiSuccess, apiBadRequest, apiInternalError } from '@/lib/api/response';
import { getTwilioClient } from '@/lib/twilio/client';
import { emitEvent } from '@/lib/events/emitter';
import { requireCallControlPermission } from '@/lib/calls/ownership';
import { auditLog } from '@/lib/api/audit';

/**
 * POST /api/v1/calls/:id/resume
 * Saca una llamada de espera (reconecta con el agente).
 *
 * Implementación: mueve ambas partes a una conferencia efímera.
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

    const confName = `resume-${callSid}-${Date.now()}`;

    const confTwiml = new twilio.twiml.VoiceResponse();
    const dial = confTwiml.dial();
    dial.conference(
      {
        startConferenceOnEnter: true,
        endConferenceOnExit: false,
        beep: 'false',
      },
      confName,
    );
    const confTwimlStr = confTwiml.toString();

    await Promise.all([
      client.calls(remoteSid).update({ twiml: confTwimlStr }),
      client.calls(callSid).update({ twiml: confTwimlStr }),
    ]);

    emitEvent('call.resumed', {
      call_sid: callSid,
      remote_call_sid: remoteSid,
      by_user_id: auth.userId ?? 'api_key',
    });

    await auditLog('call.resume', 'call_record', callSid, auth.userId, {
      call_sid: callSid,
      remote_call_sid: remoteSid,
      conference: confName,
      auth_method: auth.authMethod,
    });

    return apiSuccess({ resumed: true, callSid, remoteSid, conference: confName });
  } catch (err) {
    console.error(`[RESUME] Error resuming ${callSid}:`, err);
    return apiInternalError('Error al sacar de espera');
  }
}
