import { NextRequest } from 'next/server';
import { authenticate, isAuthenticated } from '@/lib/api/auth';
import { apiSuccess, apiBadRequest, apiInternalError } from '@/lib/api/response';
import { getTwilioClient } from '@/lib/twilio/client';
import { requireCallControlPermission } from '@/lib/calls/ownership';
import { auditLog } from '@/lib/api/audit';

/**
 * POST /api/v1/calls/:id/unmute
 * Reactiva el audio de un participante muteado en una conferencia.
 *
 * Body: { conference_name: string }
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

  let body: { conference_name?: string } = {};
  try {
    body = await req.json();
  } catch {
    return apiBadRequest('Body JSON requerido con conference_name');
  }

  if (!body.conference_name) {
    return apiBadRequest('conference_name es requerido para unmute');
  }

  try {
    const client = getTwilioClient();

    const conferences = await client.conferences.list({
      friendlyName: body.conference_name,
      status: 'in-progress',
      limit: 1,
    });

    if (conferences.length === 0) {
      return apiBadRequest('Conferencia no encontrada');
    }

    const participants = await client
      .conferences(conferences[0].sid)
      .participants.list();

    const target = participants.find((p) => p.callSid === callSid);
    if (!target) {
      return apiBadRequest('Participante no encontrado en la conferencia');
    }

    await client
      .conferences(conferences[0].sid)
      .participants(target.callSid)
      .update({ muted: false });

    await auditLog('call.unmute', 'call_record', callSid, auth.userId, {
      call_sid: callSid,
      conference_name: body.conference_name,
      auth_method: auth.authMethod,
    });

    return apiSuccess({ unmuted: true, callSid, conference: body.conference_name });
  } catch (err) {
    console.error(`[UNMUTE] Error unmuting ${callSid}:`, err);
    return apiInternalError('Error al reactivar audio');
  }
}

