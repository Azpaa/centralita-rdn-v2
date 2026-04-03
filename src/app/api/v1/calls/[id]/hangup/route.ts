import { NextRequest } from 'next/server';
import { authenticate, isAuthenticated } from '@/lib/api/auth';
import { apiSuccess, apiBadRequest, apiInternalError } from '@/lib/api/response';
import { getTwilioClient } from '@/lib/twilio/client';

/**
 * POST /api/v1/calls/:id/hangup
 * Cuelga una llamada activa. Funciona para cualquier leg (agente o remoto).
 *
 * Body (opcional): { target?: 'agent' | 'remote' | 'all' }
 * - 'all' (default): Cuelga ambas legs
 * - 'agent': Solo la leg del agente
 * - 'remote': Solo la leg remota
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await authenticate(req);
  if (!isAuthenticated(auth)) return auth;

  const { id: callSid } = await params;
  if (!callSid) return apiBadRequest('callSid es requerido');

  let body: { target?: string } = {};
  try {
    body = await req.json();
  } catch {
    // Body vacío es OK → target = 'all'
  }

  const target = body.target || 'all';

  try {
    const client = getTwilioClient();
    let remoteSid: string | null = null;

    // Resolver primero la otra leg para no perder referencia si colgamos callSid.
    if (target === 'all' || target === 'remote') {
      const callInfo = await client.calls(callSid).fetch().catch(() => null);
      if (callInfo) {
        if (callInfo.parentCallSid) {
          remoteSid = callInfo.parentCallSid;
        } else {
          const children = await client.calls.list({
            parentCallSid: callSid,
            status: 'in-progress',
            limit: 5,
          });
          if (children.length > 0) remoteSid = children[0].sid;
        }
      }
    }

    if (target === 'all' || target === 'agent') {
      await client.calls(callSid).update({ status: 'completed' });
    }

    if (remoteSid && (target === 'all' || target === 'remote')) {
      await client.calls(remoteSid).update({ status: 'completed' });
    }

    return apiSuccess({ hungup: true, callSid, target, remote_call_sid: remoteSid });
  } catch (err) {
    console.error(`[HANGUP] Error hanging up ${callSid}:`, err);
    return apiInternalError('Error al colgar la llamada');
  }
}
