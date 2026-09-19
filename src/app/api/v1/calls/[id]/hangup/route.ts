import { NextRequest } from 'next/server';
import { authenticate, isAuthenticated } from '@/lib/api/auth';
import { apiSuccess, apiBadRequest, apiInternalError } from '@/lib/api/response';
import { getTwilioClient } from '@/lib/twilio/client';
import { requireCallControlPermission } from '@/lib/calls/ownership';
import { auditLog } from '@/lib/api/audit';
import { updateCallStatus } from '@/lib/twilio/call-engine';
import { createAdminClient } from '@/lib/supabase/admin';
import {
  leaveTransferAsSource,
  rejectTransferByTarget,
  shouldIgnoreHangupAfterTransfer,
} from '@/lib/calls/transfer';
import type { AuthResult } from '@/lib/api/auth';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Usuario de la centralita que cuelga. Con sesión, el autenticado (el body no
 * puede suplantarlo). Con API key (RDN), el `user_id` o `rdn_user_id` que
 * mande en el body — la misma confianza que ya da /accept a esa integración.
 */
async function resolveRequesterUserId(
  auth: AuthResult,
  body: { user_id?: unknown; rdn_user_id?: unknown },
): Promise<string | null> {
  if (auth.authMethod !== 'api_key') return auth.userId ?? null;

  const userId = typeof body.user_id === 'string' ? body.user_id.trim() : '';
  if (UUID_RE.test(userId)) return userId;

  const rdnUserId = typeof body.rdn_user_id === 'string' ? body.rdn_user_id.trim() : '';
  if (!rdnUserId) return null;
  const { data } = await createAdminClient()
    .from('users')
    .select('id')
    .eq('rdn_user_id', rdnUserId)
    .is('deleted_at', null)
    .maybeSingle();
  return (data as { id: string } | null)?.id ?? null;
}

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

  let body: { target?: unknown; user_id?: unknown; rdn_user_id?: unknown } = {};
  try {
    const parsed: unknown = await req.json();
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) body = parsed as typeof body;
  } catch {
    // Body vacío es OK → target = 'all'
  }

  const target = typeof body.target === 'string' && body.target ? body.target : 'all';

  // Quién cuelga. Con sesión, el agente autenticado. Con API key (RDN), la
  // identidad que mande en el body, igual que en /accept: sin ella, durante
  // una transferencia no se puede distinguir al agente que transfirió del
  // compañero que la recibió.
  const requesterUserId = await resolveRequesterUserId(auth, body);

  // Transferencia entre agentes (lib/calls/transfer.ts). Durante una
  // transferencia ningún colgado debe cortar al cliente por error:
  //
  // 1. El compañero destino cuelga antes de completarse = RECHAZO. El cliente
  //    vuelve con el agente original y la llamada no se corta. Va antes del
  //    control de permisos porque el destino todavía no es dueño de la
  //    llamada; la autorización queda acotada a rechazar SU transferencia.
  if (requesterUserId) {
    try {
      if (await rejectTransferByTarget(callSid, requesterUserId)) {
        void auditLog('call.hangup', 'call_record', callSid, auth.userId, {
          call_sid: callSid,
          requester_user_id: requesterUserId,
          transfer_rejected: true,
          auth_method: auth.authMethod,
        });
        return apiSuccess({ hungup: false, transfer_rejected: true, callSid });
      }
    } catch (err) {
      console.error(`[HANGUP] Rechazo de transferencia falló para ${callSid}:`, err);
    }
  }

  const permissionCheck = await requireCallControlPermission(auth, callSid);
  if (permissionCheck !== true) return permissionCheck;

  if (target === 'all' || target === 'agent' || target === 'remote') {
    // 2. Transferencia pendiente y cuelga el lado del agente que transfiere
    //    (su Tauri o RDN mandan 'all'): sale SOLO ese agente y la
    //    transferencia sigue — es lo que hace quien transfiere y cuelga por
    //    costumbre. 'remote' es una orden explícita de colgar al cliente y
    //    no entra aquí.
    if (target !== 'remote') {
      try {
        if (await leaveTransferAsSource(callSid, requesterUserId)) {
          void auditLog('call.hangup', 'call_record', callSid, auth.userId, {
            call_sid: callSid,
            requester_user_id: requesterUserId,
            target,
            transfer_continues: true,
            auth_method: auth.authMethod,
          });
          return apiSuccess({ hungup: true, transfer_continues: true, callSid });
        }
      } catch (err) {
        console.error(`[HANGUP] Salida del agente de una transferencia falló para ${callSid}:`, err);
      }
    }

    // 3. Transferencia RECIÉN completada: el aviso del agente que transfirió
    //    tarda unos segundos en desaparecer de RDN, y su Tauri puede cruzarse
    //    con la finalización. Solo el nuevo dueño puede colgar en esa
    //    ventana; cualquier otro colgado colgaría al cliente, que ya habla
    //    con el compañero.
    try {
      if (await shouldIgnoreHangupAfterTransfer(callSid, requesterUserId)) {
        void auditLog('call.hangup', 'call_record', callSid, auth.userId, {
          call_sid: callSid,
          requester_user_id: requesterUserId,
          target,
          ignored: 'transfer_just_completed',
          auth_method: auth.authMethod,
        });
        return apiSuccess({ hungup: false, ignored: 'transfer_completed', callSid });
      }
    } catch (err) {
      console.error(`[HANGUP] Comprobación post-transferencia falló para ${callSid}:`, err);
    }
  }

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

      void auditLog('call.hangup', 'call_record', callSid, auth.userId, {
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

    // Cierre terminal en BD SIN depender del webhook de status de Twilio.
    // Antes, `hangup` solo colgaba en Twilio y confiaba en que el status
    // callback cerrase el call_record; si ese webhook se perdía, la fila
    // quedaba "activa" → el agente aparecía ocupado → entraban mal las
    // siguientes llamadas. `reject` ya cierra así; replicamos el patrón.
    // Solo para 'all' (el colgar normal del operador); los cierres parciales
    // 'agent'/'remote' se dejan al webhook para no marcar terminal una
    // llamada que puede seguir viva. updateCallStatus es idempotente y tiene
    // guarda anti-resurrección, así que convive con el webhook sin conflicto.
    // Fire-and-forget: no bloquea la respuesta (Twilio ya cerró la media),
    // pero garantiza el cierre independiente del callback.
    if (target === 'all') {
      void updateCallStatus(callSid, {
        status: 'completed',
        endedAt: new Date().toISOString(),
        terminalSource: 'hangup_endpoint',
      }).catch((err) => {
        console.error(`[HANGUP] updateCallStatus falló para ${callSid}:`, err);
      });
    }

    void auditLog('call.hangup', 'call_record', callSid, auth.userId, {
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
