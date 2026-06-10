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
 * Body (opcional): { target?: 'agent' | 'remote' | 'all' | 'self' }
 * - 'all' (default): Cuelga ambas legs
 * - 'agent': Solo la leg del agente
 * - 'remote': Solo la leg remota
 * - 'self': RECHAZO LOCAL para el agente autenticado — cancela SUS legs de
 *   ring (softphone y teléfono) y lo retira de los targets de la llamada,
 *   sin tocar la leg del llamante (la cola sigue sonando a otros agentes).
 *   El softphone lo usa para llamadas que no posee; antes este valor no
 *   existía en el endpoint y se no-opeaba en silencio devolviendo
 *   hungup:true.
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

    // ── target 'self': rechazo local del agente autenticado ────────────────
    if (target === 'self') {
      if (!auth.userId) {
        return apiBadRequest("target 'self' requiere sesión de agente");
      }

      // 1. Cancelar las legs de ring dirigidas a este agente (softphone y
      //    teléfono físico). Misma aproximación que la limpieza de
      //    agent-connect: legs recientes en ringing/queued.
      const { data: userRow } = await supabase
        .from('users')
        .select('phone')
        .eq('id', auth.userId)
        .maybeSingle();
      const agentPhone = (userRow?.phone ?? '').trim();
      const recentCutoff = new Date(Date.now() - 5 * 60 * 1000);
      const ringDestinations = [`client:${auth.userId}`, ...(agentPhone ? [agentPhone] : [])];

      for (const destination of ringDestinations) {
        for (const legStatus of ['ringing', 'queued'] as const) {
          try {
            const legs = await client.calls.list({
              to: destination,
              status: legStatus,
              startTimeAfter: recentCutoff,
            });
            for (const leg of legs) {
              await client.calls(leg.sid).update({ status: 'canceled' }).catch(() => {});
            }
          } catch {
            // best-effort
          }
        }
      }

      // 2. Salir de los targets de la llamada para que el snapshot deje de
      //    mostrarla sonando a este agente.
      const { data: recordRow } = await supabase
        .from('call_records')
        .select('twilio_data')
        .eq('twilio_call_sid', callSid)
        .maybeSingle();
      const recordData = (
        recordRow?.twilio_data
        && typeof recordRow.twilio_data === 'object'
        && !Array.isArray(recordRow.twilio_data)
      ) ? (recordRow.twilio_data as Record<string, unknown>) : null;
      if (recordData && Array.isArray(recordData.current_ring_target_user_ids)) {
        const remainingTargets = (recordData.current_ring_target_user_ids as unknown[])
          .filter((id): id is string => typeof id === 'string' && id !== auth.userId);
        const declinedBy = Array.isArray(recordData.declined_by_user_ids)
          ? (recordData.declined_by_user_ids as unknown[]).filter((id): id is string => typeof id === 'string')
          : [];
        await supabase
          .from('call_records')
          .update({
            twilio_data: {
              ...recordData,
              current_ring_target_user_ids: remainingTargets,
              declined_by_user_ids: [...new Set([...declinedBy, auth.userId])],
              last_declined_at: new Date().toISOString(),
            },
          })
          .eq('twilio_call_sid', callSid);
      }

      await auditLog('call.hangup', 'call_record', callSid, auth.userId, {
        call_sid: callSid,
        target: 'self',
        declined_for_user: auth.userId,
        auth_method: auth.authMethod,
      });

      return apiSuccess({
        hungup: false,
        declined: true,
        callSid,
        target: 'self',
        declined_for_user: auth.userId,
      });
    }

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

    // Orden deliberado: PRIMERO la leg remota, después la del agente. Así,
    // cuando el participant-leave de la leg del agente llegue al
    // room-watchdog, el llamante ya no está en la sala y el watchdog no
    // confunde un hangup legítimo con un agente caído (ni reproduce el
    // anuncio de "reconectando" a un llamante al que estamos colgando).
    if (remoteSid && (target === 'all' || target === 'remote')) {
      await client.calls(remoteSid).update({ status: 'completed' });
    }

    if (target === 'all' || target === 'agent') {
      await client.calls(callSid).update({ status: 'completed' });
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
