import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { updateCallStatus } from '@/lib/twilio/call-engine';
import { validateAndParseTwilioWebhook } from '@/lib/api/twilio-auth';
import { createAdminClient } from '@/lib/supabase/admin';
import { emitEvent } from '@/lib/events/emitter';
import type { CallRecord, CallStatus } from '@/lib/types/database';

// Estados terminales — una vez que dial-action pone uno de estos, no lo sobrescribimos
const TERMINAL_STATUSES: CallStatus[] = ['completed', 'no_answer', 'busy', 'failed', 'canceled'];

/**
 * POST /api/webhooks/twilio/voice/status
 * Twilio llama aquí cuando cambia el estado de una llamada.
 *
 * IMPORTANTE: Este webhook NO es la fuente autoritativa del resultado final.
 * El dial-action webhook determina el resultado real (completada vs no contestada).
 * Este webhook solo actualiza estados intermedios (ringing, in_progress) y
 * pone ended_at como respaldo si dial-action no se ejecutó.
 */
export async function POST(req: NextRequest) {
  // Validar firma + parsear body
  const webhook = await validateAndParseTwilioWebhook(req);
  if (!webhook.ok) return webhook.response;
  const params = webhook.params;

  const callSid = params.CallSid || params.ParentCallSid || '';
  const callStatus = params.CallStatus || '';
  const timestamp = params.Timestamp || new Date().toISOString();

  console.log(`[STATUS] CallSid=${callSid} Status=${callStatus}`);

  if (!callSid) {
    return new NextResponse('OK', { status: 200 });
  }

  try {
    // Consultar estado actual de la llamada en DB
    const supabase = createAdminClient();
    const { data: existing } = await supabase
      .from('call_records')
      .select('status, direction, from_number, to_number, queue_id, answered_by_user_id, duration, answered_at, ended_at')
      .eq('twilio_call_sid', callSid)
      .single();

    const currentRecord = existing as CallRecord | null;
    const currentStatus = currentRecord?.status;

    // Si dial-action ya puso un estado terminal, NO sobrescribir
    if (currentStatus && TERMINAL_STATUSES.includes(currentStatus)) {
      // Solo actualizar ended_at si no lo tiene aún (respaldo)
      if (!currentRecord?.ended_at && ['completed', 'busy', 'no-answer', 'failed', 'canceled'].includes(callStatus)) {
        await updateCallStatus(callSid, { endedAt: timestamp });
      }
      console.log(`[STATUS] Skipping — dial-action already set terminal status: ${currentStatus}`);
      return new NextResponse('OK', { status: 200 });
    }

    // Mapear estados de Twilio a nuestros estados
    const statusMap: Record<string, string> = {
      queued: 'ringing',
      ringing: 'ringing',
      'in-progress': 'in_progress',
      completed: 'completed',
      busy: 'busy',
      'no-answer': 'no_answer',
      failed: 'failed',
      canceled: 'canceled',
    };

    const mappedStatus = statusMap[callStatus] || callStatus;
    const updates: Parameters<typeof updateCallStatus>[1] = {};

    updates.status = mappedStatus;

    // ── Emitir call.answered para outbound cuando el destino descuelga ────
    // Twilio reporta 'in-progress' cuando la otra parte contesta.
    // Para inbound esto ya se hace en agent-connect/whisper, pero para
    // outbound NADIE lo emitía → RDN se quedaba en "Intentando".
    if (callStatus === 'in-progress' && currentRecord?.direction === 'outbound') {
      // Marcar answered_at si no lo tiene
      if (!currentRecord.answered_at) {
        updates.answeredAt = timestamp;
      }

      const agentUserId = currentRecord.answered_by_user_id ?? null;

      // Resolver rdn_user_id del agente para que RDN pueda correlacionar
      let rdnUserId: string | null = null;
      if (agentUserId) {
        const { data: agentData } = await supabase
          .from('users')
          .select('rdn_user_id')
          .eq('id', agentUserId)
          .single();
        rdnUserId = (agentData as { rdn_user_id?: string } | null)?.rdn_user_id ?? null;
      }

      console.log(
        `[STATUS] Outbound call answered — emitting call.answered call_sid=${callSid} agent=${agentUserId}`
      );

      emitEvent('call.answered', {
        call_sid: callSid,
        direction: 'outbound',
        status: 'in_progress',
        from: currentRecord.from_number ?? null,
        to: currentRecord.to_number ?? null,
        answered_by_user_id: agentUserId,
        user_id: agentUserId,
        rdn_user_id: rdnUserId,
      });
    }
    if (['completed', 'busy', 'no-answer', 'failed', 'canceled'].includes(callStatus)) {
      if (!currentRecord?.ended_at) {
        updates.endedAt = timestamp;
      }
      // NO sobrescribimos duration — dial-action pone la duración de conversación real
      // Solo ponemos duration si no hay ninguna (respaldo)
      if (currentRecord?.duration === null || currentRecord?.duration === undefined) {
        const callDuration = params.CallDuration ? parseInt(params.CallDuration, 10) : undefined;
        if (callDuration !== undefined) {
          updates.duration = callDuration;
        }
      }
    }

    await updateCallStatus(callSid, updates);

    const isTerminalFromStatus = ['completed', 'busy', 'no-answer', 'failed', 'canceled'].includes(callStatus);
    if (isTerminalFromStatus) {
      const direction = currentRecord?.direction || 'outbound';
      const terminalStatus = mappedStatus;
      const endedAt = updates.endedAt || currentRecord?.ended_at || timestamp;
      const answeredAt = currentRecord?.answered_at || null;
      const duration = updates.duration ?? currentRecord?.duration ?? 0;

      console.log(
        `[STATUS] terminal fallback emit call_sid=${callSid} direction=${direction} status=${terminalStatus}`
      );

      if (direction === 'inbound' && terminalStatus !== 'completed') {
        emitEvent('call.missed', {
          call_sid: callSid,
          direction,
          from: currentRecord?.from_number ?? null,
          to: currentRecord?.to_number ?? null,
          final_status: terminalStatus,
          queue_id: currentRecord?.queue_id ?? null,
          terminal_source: 'status_fallback',
        });
      } else {
        emitEvent('call.completed', {
          call_sid: callSid,
          direction,
          status: terminalStatus,
          from: currentRecord?.from_number ?? null,
          to: currentRecord?.to_number ?? null,
          queue_id: currentRecord?.queue_id ?? null,
          answered_by_user_id: currentRecord?.answered_by_user_id ?? null,
          duration,
          wait_time: null,
          answered_at: answeredAt,
          ended_at: endedAt,
          terminal_source: 'status_fallback',
        });
      }
    }
  } catch (err) {
    console.error('[STATUS] Error updating call status:', err);
  }

  // Twilio espera un 200 (no TwiML aquí)
  return new NextResponse('OK', { status: 200 });
}
