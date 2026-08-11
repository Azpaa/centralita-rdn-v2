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

  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';

  // Estado mínimo accesible desde el catch de emergencia: si una operación
  // transitoria (Supabase/emitEvent) falla con el proceso VIVO, sin este
  // guard el handler lanzaría un 500 y Twilio colgaría la llamada con su
  // "application error". Preservamos al llamante entrante en cola; el resto
  // cierra de forma elegante.
  let directionForCatch = 'outbound';
  let queueIdForCatch: string | null | undefined = null;

  try {
  const twiml = new twilio.twiml.VoiceResponse();

  // Buscar el call record para conocer la dirección, cola y tiempos
  const supabase = createAdminClient();
  const { data: callRecord } = await supabase
    .from('call_records')
    .select('direction, started_at, answered_at, queue_id, phone_number_id, from_number, to_number, answered_by_user_id, twilio_data')
    .eq('twilio_call_sid', callSid)
    .single();

  const record = callRecord as CallRecord | null;
  const direction = record?.direction || 'outbound';
  const startedAt = record?.started_at;
  const queueId = record?.queue_id;
  directionForCatch = direction;
  queueIdForCatch = queueId;
  const fromNumber = record?.from_number ?? null;
  const toNumber = record?.to_number ?? null;
  const answeredByUserId = record?.answered_by_user_id ?? null;

  // ── Guard de hold en curso ────────────────────────────────────────────────
  // Cuando /hold pone en espera una llamada SALIENTE (`<Dial>`), redirige al
  // cliente a la música de espera; eso termina el `<Dial>` del agente, que llega
  // aquí. Sin este guard, la lógica de abajo daría la llamada por terminada y
  // colgaría al agente (el bug "se cuelga al poner en espera"). En su lugar
  // aparcamos la leg del agente viva con un `<Pause>`; /resume la re-puentea.
  const twilioData =
    record?.twilio_data && typeof record.twilio_data === 'object' && !Array.isArray(record.twilio_data)
      ? (record.twilio_data as Record<string, unknown>)
      : {};
  const holdRestructure =
    twilioData.hold_restructure
    && typeof twilioData.hold_restructure === 'object'
    && !Array.isArray(twilioData.hold_restructure)
      ? (twilioData.hold_restructure as Record<string, unknown>)
      : null;
  if (holdRestructure && holdRestructure.held === true) {
    const restructuredAt =
      typeof holdRestructure.at === 'string' ? Date.parse(holdRestructure.at) : NaN;
    const isFresh = Number.isFinite(restructuredAt) && Date.now() - restructuredAt < 60_000;
    if (isFresh) {
      console.log(
        `[DIAL-ACTION] Hold en curso para ${callSid} — aparcando la leg del agente en vez de colgar`
      );
      // Aparcamiento renovable (antes: un único Pause de 3600s que al
      // agotarse colgaba al agente y dejaba al cliente en bucle de música).
      // hold-park re-verifica el estado del hold en cada vuelta y aplica el
      // tope máximo de espera.
      twiml.pause({ length: 240 });
      twiml.redirect({ method: 'POST' }, `${baseUrl}/api/webhooks/twilio/voice/hold-park`);
      return twimlResponse(twiml);
    }
  }

  // Si la llamada fue contestada y completada → hubo conversación real
  // Para conferencias, el DialCallStatus puede no ser exactamente 'completed'
  // pero si el record ya tiene answered_by_user_id, la llamada SÍ fue contestada.
  const wasAnswered = !!answeredByUserId;
  if (dialStatus === 'completed' || (wasAnswered && dialStatus !== 'no-answer' && dialStatus !== 'busy')) {
    const endedAt = new Date();

    // Cálculo de answered_at/duration robusto por tipo de `<Dial>`:
    //  - SALIENTES (`<Dial><Number>`): DialCallDuration ES la conversación real
    //    → backdate answered_at desde ella (comportamiento histórico intacto).
    //  - ENTRANTES (`<Dial><Conference>`): Twilio reporta DialCallDuration=0,
    //    así que el cálculo antiguo machacaba answered_at=ended_at y guardaba
    //    duration=0 en TODAS las entrantes (bug del "tiempo se reinicia").
    //    Conservamos el answered_at real (fijado al entrar el agente en la
    //    sala) y derivamos la duración de answered_at → ended_at.
    const existingAnsweredAt = record?.answered_at ? new Date(record.answered_at) : null;
    let answeredAt: Date;
    let duration: number;
    if (dialDuration > 0) {
      answeredAt = new Date(endedAt.getTime() - dialDuration * 1000);
      duration = dialDuration;
    } else if (existingAnsweredAt && !Number.isNaN(existingAnsweredAt.getTime())) {
      answeredAt = existingAnsweredAt;
      duration = Math.max(0, Math.round((endedAt.getTime() - existingAnsweredAt.getTime()) / 1000));
    } else {
      answeredAt = endedAt;
      duration = 0;
    }

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
      duration, // salientes: DialCallDuration; entrantes: answered_at→ended_at
      waitTime,
      terminalSource: 'dial_action_completed',
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
      duration,
      wait_time: waitTime ?? null,
      answered_at: answeredAt.toISOString(),
      ended_at: endedAt.toISOString(),
      terminal_source: 'dial_action_completed',
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
    terminalSource: `dial_action_${dialStatus || 'unanswered'}`,
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
      terminal_source: `dial_action_${dialStatus || 'unanswered'}`,
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
  } catch (err) {
    console.error(
      `[DIAL-ACTION] Error no controlado para CallSid=${callSid} — devolviendo TwiML seguro en vez de 500:`,
      err,
    );
    // Un 500 aquí hace que Twilio reproduzca "an application error has
    // occurred" y cuelgue. En su lugar: al llamante ENTRANTE en cola lo
    // devolvemos a queue-retry (no perderlo por un fallo transitorio); el
    // resto cierra limpio.
    const safe = new twilio.twiml.VoiceResponse();
    if (directionForCatch === 'inbound' && queueIdForCatch) {
      safe.redirect({ method: 'POST' }, `${baseUrl}/api/webhooks/twilio/voice/queue-retry`);
    } else {
      safe.hangup();
    }
    return twimlResponse(safe);
  }
}
