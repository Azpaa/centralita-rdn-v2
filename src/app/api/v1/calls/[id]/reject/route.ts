import { NextRequest } from 'next/server';
import { authenticate, isAuthenticated } from '@/lib/api/auth';
import { apiBadRequest, apiInternalError, apiSuccess } from '@/lib/api/response';
import { createAdminClient } from '@/lib/supabase/admin';
import { getTwilioClient } from '@/lib/twilio/client';
import { requireCallControlPermission } from '@/lib/calls/ownership';
import { emitEvent } from '@/lib/events/emitter';
import { updateCallStatus } from '@/lib/twilio/call-engine';
import { auditLog } from '@/lib/api/audit';

/**
 * POST /api/v1/calls/:id/reject
 *
 * Rechaza una llamada entrante (o cancela un intento pendiente). Cierra el
 * `call_record`, intenta colgar la llamada en Twilio, y emite `call.ended`
 * por SSE para que el softphone pare el ringtone y libere la UI.
 *
 * Motivación: hasta ahora "rechazar desde RDN" no existía como operación de
 * primera clase. El softphone se quedaba con el ringtone sonando para siempre
 * porque ningún evento de cancelación le llegaba.
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

  const supabase = createAdminClient();

  try {
    const { data: callRow } = await supabase
      .from('call_records')
      .select('id, direction, from_number, to_number, queue_id, answered_by_user_id, ended_at, status')
      .eq('twilio_call_sid', callSid)
      .maybeSingle();

    if (!callRow) {
      // No DB row yet — still try to kill the Twilio leg and emit the event.
      // Better to be loud than silent.
      console.warn(`[REJECT] No call_record for ${callSid}; emitting call_ended anyway.`);
    }

    const alreadyClosed = Boolean(callRow?.ended_at);
    const endedAt = new Date().toISOString();

    if (!alreadyClosed && callRow?.id) {
      // Go through updateCallStatus (rather than a raw supabase.update) so
      // the terminal path also wipes `current_ring_target_user_ids` —
      // otherwise any agent that was in the ring pool at the moment of
      // reject stays pinned in resolveAgentRuntimeSnapshot until a real
      // webhook lands, which may never happen for a rejected call.
      await updateCallStatus(callSid, {
        status: 'canceled',
        endedAt,
      });
    }

    // Kill the leg in Twilio — best-effort, never block the event emission on
    // this. If the SID is a placeholder (`pending-*`) there is nothing to kill.
    if (!callSid.startsWith('pending-')) {
      try {
        const client = getTwilioClient();
        await client.calls(callSid).update({ status: 'completed' });
      } catch (twilioErr) {
        const message =
          twilioErr instanceof Error ? twilioErr.message : String(twilioErr);
        // 20404 = not found, already gone. Treat as success.
        if (!message.includes('20404') && !message.toLowerCase().includes('not found')) {
          console.warn(`[REJECT] Twilio hangup for ${callSid} failed: ${message}`);
        }
      }
    }

    // NOTE: EventType doesn't carry a dedicated 'call.rejected' — we lean on
    // 'call.completed' with status='canceled' + reason='rejected_by_operator'.
    // The canonical SSE mapping turns both call.completed and call.missed
    // into client event type 'call_ended', which is what the softphone needs
    // to tear down the ringtone.
    await emitEvent('call.completed', {
      call_sid: callSid,
      direction: callRow?.direction ?? null,
      status: 'canceled',
      final_status: 'canceled',
      from: callRow?.from_number ?? null,
      to: callRow?.to_number ?? null,
      queue_id: callRow?.queue_id ?? null,
      answered_by_user_id: callRow?.answered_by_user_id ?? null,
      ended_at: endedAt,
      reason: 'rejected_by_operator',
      rejected_by_user_id: auth.userId ?? null,
      rejected_via: auth.authMethod,
    });

    await auditLog('call.rejected', 'call_record', callSid, auth.userId, {
      call_sid: callSid,
      already_closed: alreadyClosed,
      auth_method: auth.authMethod,
    });

    return apiSuccess({
      rejected: true,
      call_sid: callSid,
      already_closed: alreadyClosed,
    });
  } catch (err) {
    console.error(`[REJECT] Error rejecting ${callSid}:`, err);
    return apiInternalError('Error al rechazar la llamada');
  }
}
