import { NextRequest } from 'next/server';
import { authenticate, isAuthenticated } from '@/lib/api/auth';
import { apiSuccess, apiBadRequest, apiInternalError } from '@/lib/api/response';
import { getTwilioClient } from '@/lib/twilio/client';
import { requireCallControlPermission } from '@/lib/calls/ownership';
import { auditLog } from '@/lib/api/audit';
import { createAdminClient } from '@/lib/supabase/admin';

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

  const permissionCheck = await requireCallControlPermission(auth, callSid);
  if (permissionCheck !== true) return permissionCheck;

  let body: { target?: string } = {};
  try {
    body = await req.json();
  } catch {
    // Body vacío es OK → target = 'all'
  }

  const target = body.target || 'all';

  try {
    const client = getTwilioClient();
    const supabase = createAdminClient();
    let remoteSid: string | null = null;

    // Resolver la otra leg para colgar ambas si es necesario
    if (target === 'all' || target === 'remote') {
      // Primero: buscar en DB si este callSid es un agent_call_sid (conferencia)
      const { data: recordByAgent } = await supabase
        .from('call_records')
        .select('twilio_call_sid')
        .filter('twilio_data->>agent_call_sid', 'eq', callSid)
        .eq('status', 'in_progress')
        .maybeSingle();

      if (recordByAgent) {
        // Encontramos el original — acabar la conferencia matando ambas legs
        remoteSid = recordByAgent.twilio_call_sid;
        console.log(`[HANGUP] Conference mode: agent=${callSid} caller=${remoteSid}`);
      } else {
        // Fallback: legacy parent/child
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
    }

    if (target === 'all' || target === 'agent') {
      await client.calls(callSid).update({ status: 'completed' });
    }

    if (remoteSid && (target === 'all' || target === 'remote')) {
      await client.calls(remoteSid).update({ status: 'completed' });
    }

    await auditLog('call.hangup', 'call_record', callSid, auth.userId, {
      call_sid: callSid,
      remote_call_sid: remoteSid,
      target,
      auth_method: auth.authMethod,
    });

    return apiSuccess({ hungup: true, callSid, target, remote_call_sid: remoteSid });
  } catch (err) {
    console.error(`[HANGUP] Error hanging up ${callSid}:`, err);
    return apiInternalError('Error al colgar la llamada');
  }
}
