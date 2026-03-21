import { NextRequest, NextResponse } from 'next/server';
import twilio from 'twilio';
import { getQueueWithOperators } from '@/lib/twilio/call-engine';
import { parseTwilioBody } from '@/lib/api/twilio-auth';
import { createAdminClient } from '@/lib/supabase/admin';
import type { CallRecord, PhoneNumber, Queue } from '@/lib/types/database';

/**
 * POST /api/webhooks/twilio/voice/queue-retry
 * Endpoint de reintento de cola. Se llama cuando dial-action detecta que
 * nadie contestó pero aún hay tiempo de espera en la cola.
 *
 * Flujo:
 * 1. Buscar call_record → obtener queue_id, from_number, phone_number_id
 * 2. Obtener cola y operadores disponibles
 * 3. Reproducir mensaje de espera + pausa breve
 * 4. Re-marcar a operadores con action=dial-action (bucle)
 *
 * El bucle se rompe cuando:
 * - Un operador contesta → dial-action pone completed
 * - Se agota max_wait_time → dial-action da mensaje de despedida y cuelga
 * - El llamante cuelga → Twilio termina la llamada automáticamente
 */
export async function POST(req: NextRequest) {
  const body = await req.text();
  const params = parseTwilioBody(body);

  const callSid = params.CallSid || '';

  console.log(`[QUEUE-RETRY] Retrying for CallSid=${callSid}`);

  const twiml = new twilio.twiml.VoiceResponse();
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';

  try {
    const supabase = createAdminClient();

    // 1. Buscar el call record
    const { data: callRecord } = await supabase
      .from('call_records')
      .select('queue_id, from_number, to_number, phone_number_id, started_at')
      .eq('twilio_call_sid', callSid)
      .single();

    const record = callRecord as CallRecord | null;

    if (!record?.queue_id) {
      console.warn(`[QUEUE-RETRY] No queue_id found for CallSid=${callSid}`);
      twiml.say(
        { language: 'es-ES', voice: 'Polly.Conchita' },
        'No ha sido posible conectar su llamada. Por favor, inténtelo más tarde.'
      );
      twiml.hangup();
      return twimlResponse(twiml);
    }

    // 2. Obtener cola y operadores disponibles
    const queueData = await getQueueWithOperators(record.queue_id);
    const queue = queueData?.queue;

    // Comprobar si se ha superado el tiempo máximo de espera
    const maxWait = queue?.max_wait_time ?? 300;
    const waitingSince = record.started_at ? new Date(record.started_at).getTime() : Date.now();
    const waitedSeconds = Math.round((Date.now() - waitingSince) / 1000);

    if (waitedSeconds >= maxWait) {
      console.log(`[QUEUE-RETRY] Max wait exceeded (${waitedSeconds}s >= ${maxWait}s), giving up`);
      // Actualizar estado final
      const { updateCallStatus } = await import('@/lib/twilio/call-engine');
      await updateCallStatus(callSid, {
        status: 'no_answer',
        endedAt: new Date().toISOString(),
        duration: 0,
      });
      twiml.say(
        { language: 'es-ES', voice: 'Polly.Conchita' },
        'No ha sido posible conectar su llamada. Por favor, inténtelo más tarde.'
      );
      twiml.hangup();
      return twimlResponse(twiml);
    }

    if (!queueData || !queueData.queue || queueData.operators.length === 0) {
      // No hay operadores disponibles → mensaje de espera y reintentar en unos segundos
      console.log(`[QUEUE-RETRY] No operators available, waiting and retrying...`);
      twiml.say(
        { language: 'es-ES', voice: 'Polly.Conchita' },
        'Todos nuestros operadores están ocupados. Por favor, espere un momento.'
      );
      twiml.pause({ length: 5 });
      // Redirigir de vuelta a sí mismo para comprobar de nuevo
      twiml.redirect(
        { method: 'POST' },
        `${baseUrl}/api/webhooks/twilio/voice/queue-retry`
      );
      return twimlResponse(twiml);
    }

    // queueData is guaranteed to have queue and operators at this point
    const activeQueue = queue!;
    const operators = queueData.operators;

    // 3. Mensaje breve de espera
    twiml.say(
      { language: 'es-ES', voice: 'Polly.Conchita' },
      'Un momento por favor, le estamos transfiriendo.'
    );

    // 4. Obtener si hay que grabar
    let shouldRecord = false;
    if (record.phone_number_id) {
      const { data: phoneNum } = await supabase
        .from('phone_numbers')
        .select('record_calls')
        .eq('id', record.phone_number_id)
        .single();
      shouldRecord = (phoneNum as PhoneNumber | null)?.record_calls ?? false;
    }

    // 5. Re-marcar a operadores (mismo patrón que incoming/route.ts)
    const dial = twiml.dial({
      callerId: record.from_number,
      timeout: activeQueue.ring_timeout,
      action: `${baseUrl}/api/webhooks/twilio/voice/dial-action`,
      record: shouldRecord ? 'record-from-answer-dual' as const : 'do-not-record' as const,
      recordingStatusCallback: shouldRecord
        ? `${baseUrl}/api/webhooks/twilio/recording/status`
        : undefined,
    });

    if (activeQueue.strategy === 'ring_all') {
      // Ring All: llamar a todos los operadores simultáneamente
      for (const op of operators) {
        if (op.phone) {
          dial.number(
            {
              statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
              statusCallback: `${baseUrl}/api/webhooks/twilio/voice/status`,
              url: `${baseUrl}/api/webhooks/twilio/voice/whisper?operator_id=${op.id}&call_sid=${callSid}`,
            },
            op.phone
          );
        }
        // También llamar al navegador del operador (Twilio Client)
        dial.client(
          {
            statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
            statusCallback: `${baseUrl}/api/webhooks/twilio/voice/status`,
          },
          op.id
        );
      }
    } else {
      // Round Robin: siguiente operador
      const nextOperator = operators[activeQueue.current_index % operators.length];

      if (nextOperator) {
        if (nextOperator.phone) {
          dial.number(
            {
              statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
              statusCallback: `${baseUrl}/api/webhooks/twilio/voice/status`,
              url: `${baseUrl}/api/webhooks/twilio/voice/whisper?operator_id=${nextOperator.id}&call_sid=${callSid}`,
            },
            nextOperator.phone
          );
        }
        dial.client(
          {
            statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
            statusCallback: `${baseUrl}/api/webhooks/twilio/voice/status`,
          },
          nextOperator.id
        );
      }

      // Avanzar el índice de rotación
      await supabase
        .from('queues')
        .update({
          current_index: (activeQueue.current_index + 1) % operators.length,
          last_rotated_at: new Date().toISOString(),
        })
        .eq('id', activeQueue.id);
    }

    return twimlResponse(twiml);
  } catch (err) {
    console.error('[QUEUE-RETRY] Error:', err);
    twiml.say(
      { language: 'es-ES', voice: 'Polly.Conchita' },
      'Estamos experimentando problemas técnicos. Por favor, inténtelo más tarde.'
    );
    twiml.hangup();
    return twimlResponse(twiml);
  }
}

function twimlResponse(twiml: twilio.twiml.VoiceResponse): NextResponse {
  return new NextResponse(twiml.toString(), {
    headers: { 'Content-Type': 'text/xml' },
  });
}
