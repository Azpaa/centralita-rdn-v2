import { NextRequest } from 'next/server';
import twilio from 'twilio';
import { routeIncomingCall, createCallRecord } from '@/lib/twilio/call-engine';
import { validateAndParseTwilioWebhook, twimlResponse } from '@/lib/api/twilio-auth';
import { emitEvent } from '@/lib/events/emitter';

/**
 * POST /api/webhooks/twilio/voice/incoming
 * Punto de entrada principal para llamadas entrantes.
 * Twilio llama a esta URL cuando un número recibe una llamada.
 *
 * Flujo:
 * 1. Validar firma de Twilio
 * 2. Buscar número en phone_numbers
 * 3. Comprobar horario
 * 4. Si fuera de horario → mensaje + acción OOH
 * 5. Si dentro de horario → bienvenida + enrutar a operadores
 * 6. Crear registro en call_records
 */
export async function POST(req: NextRequest) {
  // Validar firma + parsear body en un solo paso
  const webhook = await validateAndParseTwilioWebhook(req);
  if (!webhook.ok) return webhook.response;
  const params = webhook.params;

  const callSid = params.CallSid || '';
  const fromNumber = params.From || '';
  const toNumber = params.To || '';
  const callStatus = params.CallStatus || 'ringing';

  console.log(`[INCOMING] CallSid=${callSid} From=${fromNumber} To=${toNumber} Status=${callStatus}`);

  const twiml = new twilio.twiml.VoiceResponse();
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';

  try {
    // Enrutar la llamada
    const route = await routeIncomingCall(toNumber);

    if (!route) {
      console.warn(`[INCOMING] Número ${toNumber} no encontrado en DB`);
      twiml.say(
        { language: 'es-ES', voice: 'Polly.Conchita' },
        'El número al que ha llamado no está configurado. Disculpe las molestias.'
      );
      twiml.hangup();
      return twimlResponse(twiml);
    }

    // Registrar la llamada en DB
    await createCallRecord({
      twilioCallSid: callSid,
      direction: 'inbound',
      fromNumber,
      toNumber,
      status: 'ringing',
      queueId: route.queue?.id ?? null,
      phoneNumberId: route.phoneNumber.id,
      twilioData: params,
    });

    // Emitir evento call.incoming para RDN
    const candidateUserIds = (route.operators ?? []).map((op) => op.id);
    const candidateRdnUserIds = (route.operators ?? [])
      .map((op) => op.rdn_user_id)
      .filter((value): value is string => Boolean(value));

    emitEvent('call.incoming', {
      call_sid: callSid,
      direction: 'inbound',
      status: 'ringing',
      from: fromNumber,
      to: toNumber,
      queue_id: route.queue?.id ?? null,
      phone_number_id: route.phoneNumber.id,
      route_type: route.type,
      ring_strategy: route.queue?.strategy ?? null,
      candidate_user_ids: candidateUserIds,
      candidate_rdn_user_ids: candidateRdnUserIds,
    });

    // --- Número inactivo ---
    if (route.type === 'inactive') {
      twiml.say(
        { language: 'es-ES', voice: 'Polly.Conchita' },
        'Este número no está disponible en este momento.'
      );
      twiml.hangup();
      return twimlResponse(twiml);
    }

    // --- Fuera de horario ---
    if (route.type === 'out_of_hours') {
      const oohMsg = route.phoneNumber.ooh_message
        || 'Nuestro horario de atención ha finalizado. Por favor, llame en horario laboral.';

      twiml.say({ language: 'es-ES', voice: 'Polly.Conchita' }, oohMsg);

      switch (route.phoneNumber.ooh_action) {
        case 'forward':
          if (route.phoneNumber.ooh_forward_to) {
            twiml.say(
              { language: 'es-ES', voice: 'Polly.Conchita' },
              'Transfiriendo su llamada.'
            );
            twiml.dial(
              {
                callerId: toNumber,
                timeout: 30,
                action: `${baseUrl}/api/webhooks/twilio/voice/dial-action`,
              },
              route.phoneNumber.ooh_forward_to
            );
          } else {
            twiml.hangup();
          }
          break;
        case 'voicemail':
          twiml.say(
            { language: 'es-ES', voice: 'Polly.Conchita' },
            'Por favor, deje su mensaje después de la señal.'
          );
          twiml.record({
            maxLength: 120,
            action: `${baseUrl}/api/webhooks/twilio/voice/voicemail-action`,
            recordingStatusCallback: `${baseUrl}/api/webhooks/twilio/recording/status`,
            transcribe: false,
          });
          break;
        case 'hangup':
        default:
          twiml.hangup();
          break;
      }

      return twimlResponse(twiml);
    }

    // --- Dentro de horario (in_hours / no_schedule) ---

    // Mensaje de bienvenida
    if (route.phoneNumber.welcome_message) {
      twiml.say(
        { language: 'es-ES', voice: 'Polly.Conchita' },
        route.phoneNumber.welcome_message
      );
    }

    // Si no hay cola ni operadores → reenvío directo si está configurado
    if (!route.queue) {
      if (route.phoneNumber.forward_to) {
        const dial = twiml.dial({
          callerId: toNumber,
          timeout: 30,
          action: `${baseUrl}/api/webhooks/twilio/voice/dial-action`,
        });
        dial.number(
          {
            statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
            statusCallback: `${baseUrl}/api/webhooks/twilio/voice/status`,
          },
          route.phoneNumber.forward_to
        );
      } else {
        twiml.say(
          { language: 'es-ES', voice: 'Polly.Conchita' },
          'No hay operadores disponibles en este momento. Por favor, inténtelo más tarde.'
        );
        twiml.hangup();
      }
      return twimlResponse(twiml);
    }

    // --- Enrutar a cola de operadores ---
    const queue = route.queue;
    const operators = route.operators ?? [];

    // Actualizar estado a "en cola"
    const { createAdminClient } = await import('@/lib/supabase/admin');
    const supabase = createAdminClient();
    await supabase
      .from('call_records')
      .update({ status: 'in_queue' })
      .eq('twilio_call_sid', callSid);

    // Si no hay operadores libres en este momento, enviar al bucle de espera
    if (operators.length === 0) {
      console.log(`[INCOMING] No free operators for queue ${queue.id}, sending to retry loop`);
      twiml.say(
        { language: 'es-ES', voice: 'Polly.Conchita' },
        'Todos nuestros operadores están ocupados. Por favor, espere un momento.'
      );
      twiml.pause({ length: 5 });
      twiml.redirect(
        { method: 'POST' },
        `${baseUrl}/api/webhooks/twilio/voice/queue-retry`
      );
      return twimlResponse(twiml);
    }

    // Actualizar estado a "en cola"
    const { createAdminClient } = await import('@/lib/supabase/admin');
    const supabase = createAdminClient();
    await supabase
      .from('call_records')
      .update({ status: 'in_queue' })
      .eq('twilio_call_sid', callSid);

    const ringTargets = queue.strategy === 'ring_all'
      ? operators
      : (operators[queue.current_index % operators.length]
        ? [operators[queue.current_index % operators.length]]
        : []);

    if (ringTargets.length > 0) {
      console.log(
        `[INCOMING] pre-answer routing call_sid=${callSid} strategy=${queue.strategy} targets=${ringTargets.map((op) => op.id).join(',')}`
      );

      for (const target of ringTargets) {
        emitEvent('call.ringing', {
          call_sid: callSid,
          direction: 'inbound',
          status: 'ringing',
          from: fromNumber,
          to: toNumber,
          queue_id: queue.id,
          phone_number_id: route.phoneNumber.id,
          route_type: route.type,
          ring_strategy: queue.strategy,
          user_id: target.id,
          answered_by_user_id: target.id,
          rdn_user_id: target.rdn_user_id ?? null,
        });
      }
    }

    // Configurar Dial según la estrategia de la cola
    const dial = twiml.dial({
      callerId: fromNumber,
      timeout: queue.ring_timeout,
      action: `${baseUrl}/api/webhooks/twilio/voice/dial-action`,
      record: route.phoneNumber.record_calls ? 'record-from-answer-dual' as const : 'do-not-record' as const,
      recordingStatusCallback: route.phoneNumber.record_calls
        ? `${baseUrl}/api/webhooks/twilio/recording/status`
        : undefined,
    });

    if (queue.strategy === 'ring_all') {
      // Ring All: llamar a todos los operadores simultáneamente
      for (const op of operators) {
        // Llamar al teléfono del operador
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
            url: `${baseUrl}/api/webhooks/twilio/voice/whisper?operator_id=${op.id}&call_sid=${callSid}`,
          },
          op.id // identity = userId
        );
      }
    } else {
      // Round Robin: llamar al siguiente operador según rotación
      const nextOperator = operators[queue.current_index % operators.length];

      if (nextOperator) {
        // Llamar al teléfono del operador
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
        // También llamar al navegador del operador (Twilio Client)
        dial.client(
          {
            statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
            statusCallback: `${baseUrl}/api/webhooks/twilio/voice/status`,
            url: `${baseUrl}/api/webhooks/twilio/voice/whisper?operator_id=${nextOperator.id}&call_sid=${callSid}`,
          },
          nextOperator.id
        );
      }

      // Avanzar el índice de rotación
      await supabase
        .from('queues')
        .update({
          current_index: (queue.current_index + 1) % operators.length,
          last_rotated_at: new Date().toISOString(),
        })
        .eq('id', queue.id);
    }

    return twimlResponse(twiml);
  } catch (err) {
    console.error('[INCOMING] Error processing incoming call:', err);
    twiml.say(
      { language: 'es-ES', voice: 'Polly.Conchita' },
      'Estamos experimentando problemas técnicos. Por favor, inténtelo más tarde.'
    );
    twiml.hangup();
    return twimlResponse(twiml);
  }
}
