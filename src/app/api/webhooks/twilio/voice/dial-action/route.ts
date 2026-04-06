import type { NextRequest } from 'next/server';
import twilio from 'twilio';
import { updateCallStatus } from '@/lib/twilio/call-engine';
import { validateAndParseTwilioWebhook, twimlResponse } from '@/lib/api/twilio-auth';
import { createAdminClient } from '@/lib/supabase/admin';
import { emitEvent } from '@/lib/events/emitter';
import type { CallRecord, Queue } from '@/lib/types/database';

/**
 * POST /api/webhooks/twilio/voice/dial-action
 * Twilio llama aquí cuando un <Dial> termina (el operador cuelga o no contesta).
 * FUENTE AUTORITATIVA del resultado real de la llamada.
 */
export async function POST(req: NextRequest) {
  // Validar firma + parsear body
  const webhook = await validateAndParseTwilioWebhook(req);
  if (!webhook.ok) return webhook.response;
  const params = webhook.params;

  const callSid = params.CallSid || '';
  const dialStatus = params.DialCallStatus || '';
  // DialCallDuration = duración REAL de la conversación (NO incluye tiempo de tono)
  const dialDuration = params.DialCallDuration ? parseInt(params.DialCallDuration, 10) : 0;

  console.log(`[DIAL-ACTION] CallSid=${callSid} DialStatus=${dialStatus} Duration=${dialDuration}s`);

  const twiml = new twilio.twiml.VoiceResponse();
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';

  // Buscar el call record para conocer la dirección, cola y tiempos
  const supabase = createAdminClient();
  const { data: callRecord } = await supabase
    .from('call_records')
    .select('direction, started_at, queue_id, phone_number_id, from_number, to_number, answered_by_user_id')
    .eq('twilio_call_sid', callSid)
    .single();

  const record = callRecord as CallRecord | null;
  const direction = record?.direction || 'outbound';
  const startedAt = record?.started_at;
  const queueId = record?.queue_id;
  const fromNumber = record?.from_number ?? null;
  const toNumber = record?.to_number ?? null;
  const answeredByUserId = record?.answered_by_user_id ?? null;

  // Si la llamada fue contestada y completada → hubo conversación real
  if (dialStatus === 'completed') {
    const endedAt = new Date();
    // answered_at = momento en que empezó la conversación (backdated)
    const answeredAt = new Date(endedAt.getTime() - dialDuration * 1000);

    // wait_time = tiempo desde que empezó la llamada hasta que se contestó
    let waitTime: number | undefined;
    if (startedAt) {
      waitTime = Math.round((answeredAt.getTime() - new Date(startedAt).getTime()) / 1000);
      if (waitTime < 0) waitTime = 0;
    }

    await updateCallStatus(callSid, {
      status: 'completed',
      answeredAt: answeredAt.toISOString(),
      endedAt: endedAt.toISOString(),
      duration: dialDuration, // Duración REAL de conversación
      waitTime,
    });

    // Emitir evento call.completed para RDN
    emitEvent('call.completed', {
      call_sid: callSid,
      direction,
      status: 'completed',
      from: fromNumber,
      to: toNumber,
      queue_id: queueId ?? null,
      answered_by_user_id: answeredByUserId,
      duration: dialDuration,
      wait_time: waitTime ?? null,
      answered_at: answeredAt.toISOString(),
      ended_at: endedAt.toISOString(),
    });

    twiml.hangup();
    return twimlResponse(twiml);
  }

  // --- No contestaron / ocupado / falló ---

  // Para llamadas ENTRANTES con cola: comprobar si debemos reintentar
  if (direction === 'inbound' && queueId && (dialStatus === 'no-answer' || dialStatus === 'busy')) {
    // Obtener max_wait_time y timeout_action de la cola
    const { data: queueData } = await supabase
      .from('queues')
      .select('max_wait_time, timeout_action, timeout_forward_to')
      .eq('id', queueId)
      .single();

    const queue = queueData as (Queue & { timeout_action?: string; timeout_forward_to?: string }) | null;
    const maxWait = queue?.max_wait_time ?? 300; // default 5 min
    const timeoutAction = queue?.timeout_action ?? 'hangup';
    const timeoutForwardTo = queue?.timeout_forward_to ?? '';

    // Calcular cuánto tiempo lleva esperando el llamante
    const waitingSince = startedAt ? new Date(startedAt).getTime() : Date.now();
    const waitedSeconds = Math.round((Date.now() - waitingSince) / 1000);

    console.log(`[DIAL-ACTION] Queue retry check: waited=${waitedSeconds}s maxWait=${maxWait}s timeoutAction=${timeoutAction}`);

    if (waitedSeconds < maxWait) {
      // Aún hay tiempo → mantener en cola y reintentar
      await updateCallStatus(callSid, { status: 'in_queue' });

      // Redirigir al endpoint de reintento de cola
      twiml.redirect(
        { method: 'POST' },
        `${baseUrl}/api/webhooks/twilio/voice/queue-retry`
      );
      return twimlResponse(twiml);
    }

    // Se acabó el tiempo de espera → aplicar timeout_action
    console.log(`[DIAL-ACTION] Queue max wait exceeded (${waitedSeconds}s >= ${maxWait}s) → action: ${timeoutAction}`);

    switch (timeoutAction) {
      case 'forward': {
        if (timeoutForwardTo) {
          console.log(`[DIAL-ACTION] Forwarding to ${timeoutForwardTo}`);
          await updateCallStatus(callSid, { status: 'forwarded' });
          twiml.say(
            { language: 'es-ES', voice: 'Polly.Conchita' },
            'Le estamos transfiriendo. Un momento por favor.'
          );
          const forwardDial = twiml.dial({
            timeout: 30,
            action: `${baseUrl}/api/webhooks/twilio/voice/dial-action`,
          });
          if (timeoutForwardTo.startsWith('client:')) {
            forwardDial.client(timeoutForwardTo.replace('client:', ''));
          } else {
            forwardDial.number(timeoutForwardTo);
          }
          return twimlResponse(twiml);
        }
        // Si no hay número de reenvío, caer a hangup
        break;
      }
      case 'voicemail': {
        console.log(`[DIAL-ACTION] Sending to voicemail`);
        await updateCallStatus(callSid, { status: 'voicemail' });
        twiml.say(
          { language: 'es-ES', voice: 'Polly.Conchita' },
          'No hemos podido atender su llamada. Por favor, deje su mensaje después de la señal.'
        );
        twiml.record({
          maxLength: 120,
          transcribe: false,
          playBeep: true,
          action: `${baseUrl}/api/webhooks/twilio/voice/dial-action`,
          recordingStatusCallback: `${baseUrl}/api/webhooks/twilio/recording/status`,
        });
        return twimlResponse(twiml);
      }
      case 'keep_waiting': {
        console.log(`[DIAL-ACTION] Keep waiting — redirecting back to queue-retry`);
        await updateCallStatus(callSid, { status: 'in_queue' });
        twiml.say(
          { language: 'es-ES', voice: 'Polly.Conchita' },
          'Seguimos intentando conectarle. Por favor, espere.'
        );
        twiml.redirect(
          { method: 'POST' },
          `${baseUrl}/api/webhooks/twilio/voice/queue-retry`
        );
        return twimlResponse(twiml);
      }
      // 'hangup' y default: caer al flujo normal de despedida
    }
  }

  // Estado final: no hubo conversación
  const statusMap: Record<string, string> = {
    busy: 'busy',
    'no-answer': 'no_answer',
    failed: 'failed',
    canceled: 'canceled',
  };

  await updateCallStatus(callSid, {
    status: statusMap[dialStatus] || 'no_answer',
    endedAt: new Date().toISOString(),
    duration: 0,
  });

  // Emitir evento call.missed para RDN (llamada no contestada)
  if (direction === 'inbound') {
    emitEvent('call.missed', {
      call_sid: callSid,
      direction,
      from: fromNumber,
      to: toNumber,
      final_status: statusMap[dialStatus] || 'no_answer',
      queue_id: queueId ?? null,
    });
  }

  // Mensaje de despedida (solo para llamadas entrantes)
  if (direction === 'inbound') {
    if (dialStatus === 'busy') {
      twiml.say(
        { language: 'es-ES', voice: 'Polly.Conchita' },
        'La línea está ocupada. Por favor, inténtelo más tarde.'
      );
    } else if (dialStatus === 'no-answer') {
      twiml.say(
        { language: 'es-ES', voice: 'Polly.Conchita' },
        'No ha sido posible conectar su llamada. Por favor, inténtelo más tarde.'
      );
    } else {
      twiml.say(
        { language: 'es-ES', voice: 'Polly.Conchita' },
        'No ha sido posible completar su llamada.'
      );
    }
  }

  twiml.hangup();
  return twimlResponse(twiml);
}
