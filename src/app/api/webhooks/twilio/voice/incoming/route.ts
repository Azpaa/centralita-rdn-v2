import { NextRequest } from 'next/server';
import { randomUUID } from 'crypto';
import twilio from 'twilio';
import { routeIncomingCall, createCallRecord } from '@/lib/twilio/call-engine';
import { validateAndParseTwilioWebhook, twimlResponse } from '@/lib/api/twilio-auth';
import { emitEvent } from '@/lib/events/emitter';
import { hasActiveDesktopStreamForUser } from '@/lib/events/client-stream';
import { getTwilioClient } from '@/lib/twilio/client';
import { createAdminClient } from '@/lib/supabase/admin';

function resolveQueueWaitUrl(): string {
  const fromEnv = process.env.TWILIO_QUEUE_WAIT_URL?.trim();
  if (fromEnv) return fromEnv;
  return 'https://twimlets.com/holdmusic?Bucket=com.twilio.music.guitars';
}

// Reconexión pegajosa (F2): si este número tuvo una llamada ATENDIDA hace
// menos de esta ventana (entrante o saliente), intentamos devolverle al
// mismo agente. Cubre el caso "la espera remota acabó cortando la llamada
// y el cliente vuelve a llamar": antes pasaba por bienvenida + cola como
// un desconocido y podía caer en otro agente.
const STICKY_RECONNECT_WINDOW_MS = 10 * 60 * 1000;

type StickyMatch = {
  previousCallSid: string | null;
  agentId: string;
  endedAt: string | null;
};

async function findRecentAnsweredCallForNumber(callerNumber: string, excludeCallSid: string): Promise<StickyMatch | null> {
  if (!callerNumber.startsWith('+')) return null; // anónimos/ocultos: no aplicable

  const supabase = createAdminClient();
  const cutoffIso = new Date(Date.now() - STICKY_RECONNECT_WINDOW_MS).toISOString();

  const baseSelect = 'twilio_call_sid, answered_by_user_id, ended_at';
  const [inboundPrev, outboundPrev] = await Promise.all([
    supabase
      .from('call_records')
      .select(baseSelect)
      .eq('direction', 'inbound')
      .eq('from_number', callerNumber)
      .not('answered_by_user_id', 'is', null)
      .not('answered_at', 'is', null)
      .gte('ended_at', cutoffIso)
      .neq('twilio_call_sid', excludeCallSid)
      .order('ended_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from('call_records')
      .select(baseSelect)
      .eq('direction', 'outbound')
      .eq('to_number', callerNumber)
      .not('answered_by_user_id', 'is', null)
      .not('answered_at', 'is', null)
      .gte('ended_at', cutoffIso)
      .order('ended_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  const candidates = [inboundPrev.data, outboundPrev.data]
    .filter((row): row is { twilio_call_sid: string | null; answered_by_user_id: string | null; ended_at: string | null } => Boolean(row))
    .filter((row) => typeof row.answered_by_user_id === 'string' && row.answered_by_user_id.length > 0)
    .sort((a, b) => Date.parse(b.ended_at ?? '') - Date.parse(a.ended_at ?? ''));

  const best = candidates[0];
  if (!best?.answered_by_user_id) return null;

  return {
    previousCallSid: best.twilio_call_sid,
    agentId: best.answered_by_user_id,
    endedAt: best.ended_at,
  };
}

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

    // Registrar la llamada en DB — CRITICAL: sin registro, la llamada se pierde silenciosamente
    const callRecordId = await createCallRecord({
      twilioCallSid: callSid,
      direction: 'inbound',
      fromNumber,
      toNumber,
      status: 'ringing',
      queueId: route.queue?.id ?? null,
      phoneNumberId: route.phoneNumber.id,
      twilioData: params,
    });

    if (!callRecordId) {
      console.error(`[INCOMING] CRITICAL: createCallRecord failed for CallSid=${callSid} — cannot track call`);
      // Emitir evento de alerta aunque no haya registro en DB
      emitEvent('call.incoming', {
        call_sid: callSid,
        direction: 'inbound',
        status: 'ringing',
        from: fromNumber,
        to: toNumber,
        error: 'db_insert_failed',
      });
      twiml.say(
        { language: 'es-ES', voice: 'Polly.Conchita' },
        'Estamos experimentando problemas técnicos. Por favor, inténtelo de nuevo en unos segundos.'
      );
      twiml.hangup();
      return twimlResponse(twiml);
    }

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

    // ── Reconexión pegajosa ──────────────────────────────────────────────
    // ¿Este número tuvo una llamada atendida hace un momento? Si el agente
    // de aquella llamada está disponible en esta cola, le devolvemos la
    // llamada a él directamente y sin bienvenida (es una continuación, no
    // una llamada nueva). Si no está disponible, la llamada sigue el flujo
    // normal pero queda enlazada vía reconnect_of para trazabilidad.
    let stickyMatch: StickyMatch | null = null;
    try {
      stickyMatch = await findRecentAnsweredCallForNumber(fromNumber, callSid);
    } catch (stickyErr) {
      console.warn(`[INCOMING] Sticky lookup falló para ${fromNumber}:`, stickyErr);
    }
    const stickyOperator = stickyMatch
      ? (route.operators ?? []).find((op) => op.id === stickyMatch!.agentId) ?? null
      : null;

    if (stickyMatch) {
      console.log(
        `[INCOMING] Reconexión detectada from=${fromNumber} previous=${stickyMatch.previousCallSid ?? '-'} agent=${stickyMatch.agentId} eligible=${Boolean(stickyOperator)}`
      );
    }

    // Mensaje de bienvenida (sustituido por uno breve si es una reconexión
    // que de verdad va a sonar al mismo agente)
    if (stickyOperator) {
      twiml.say(
        { language: 'es-ES', voice: 'Polly.Conchita' },
        'Le estamos reconectando con su agente. Un momento, por favor.'
      );
    } else if (route.phoneNumber.welcome_message) {
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
    const supabase = createAdminClient();
    const { error: queueStatusErr } = await supabase
      .from('call_records')
      .update({ status: 'in_queue' })
      .eq('twilio_call_sid', callSid);
    if (queueStatusErr) console.error(`[INCOMING] Failed to update status to in_queue for ${callSid}:`, queueStatusErr);

    const mergeRoutingMetadata = async (payload: Record<string, unknown>) => {
      const { data: existingRow } = await supabase
        .from('call_records')
        .select('twilio_data')
        .eq('twilio_call_sid', callSid)
        .maybeSingle();

      const existingData = (
        existingRow
        && typeof existingRow === 'object'
        && 'twilio_data' in existingRow
        && existingRow.twilio_data
        && typeof existingRow.twilio_data === 'object'
        && !Array.isArray(existingRow.twilio_data)
      )
        ? (existingRow.twilio_data as Record<string, unknown>)
        : {};

      const { error: mergeErr } = await supabase
        .from('call_records')
        .update({
          twilio_data: {
            ...existingData,
            ...payload,
            last_routing_at: new Date().toISOString(),
          },
        })
        .eq('twilio_call_sid', callSid);
      if (mergeErr) console.error(`[INCOMING] Failed to merge routing metadata for ${callSid}:`, mergeErr);
    };

    // Si no hay operadores libres en este momento, enviar al bucle de espera
    if (operators.length === 0) {
      await mergeRoutingMetadata({
        candidate_user_ids: [],
        current_ring_target_user_ids: [],
        incoming_conference_request: true,
        routing_source: 'incoming_waiting_no_targets',
      });

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

    const defaultRingTargets = queue.strategy === 'ring_all'
      ? operators
      : (operators[queue.current_index % operators.length]
        ? [operators[queue.current_index % operators.length]]
        : []);
    // Reconexión pegajosa: el primer intento suena SOLO al agente de la
    // llamada anterior. Si no contesta, el avance de intento (abajo) pasa
    // por queue-retry y la llamada sigue el reparto normal de la cola.
    const ringTargets = stickyOperator ? [stickyOperator] : defaultRingTargets;
    // attempt id para AMBAS estrategias. round_robin avanza cuando su única
    // leg falla (mecanismo existente). ring_all ahora también avanza cuando
    // TODAS las legs del intento terminan sin respuesta — antes no tenía
    // ningún avance: si nadie contestaba la primera oleada, el llamante se
    // quedaba en la conferencia escuchando música indefinidamente.
    const ringAttemptId = randomUUID();

    // Conference name for this call — used by SSE events, REST rings, and caller dial
    const conferenceName = `call-${callSid}`;
    const conferenceWaitUrl = resolveQueueWaitUrl();
    await mergeRoutingMetadata({
      candidate_user_ids: operators.map((operator) => operator.id),
      current_ring_target_user_ids: ringTargets.map((target) => target.id),
      conference_name: conferenceName,
      incoming_conference_request: true,
      routing_source: stickyOperator ? 'incoming_sticky_reconnect' : 'incoming_initial',
      current_round_robin_attempt_id: ringAttemptId,
      current_round_robin_attempt_started_at: new Date().toISOString(),
      reconnect_of: stickyMatch?.previousCallSid ?? null,
      sticky_agent_id: stickyOperator?.id ?? null,
    });

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
          conference_name: conferenceName,
          incoming_conference_request: true,
          sticky_reconnect: Boolean(stickyOperator),
          reconnect_of: stickyMatch?.previousCallSid ?? null,
        });
      }
    }

    // --- Conference-based approach ---
    // Put the caller into a named conference. Agents join via:
    //  a) REST API call to client:<agent_id> (rings browser Device)
    //  b) SSE event → device.connect() from Tauri desktop app
    // First agent to join connects with the caller.

    // Ring agents via REST API (async, fire-and-forget)
    // IMPORTANT: use our Twilio DID as callerId/from. Using the external caller's
    // number here can make Twilio reject the outbound leg (especially PSTN fallback).
    const ringCallerId = route.phoneNumber.phone_number || toNumber;
    const twilioClient = getTwilioClient();
    const agentConnectBase = `${baseUrl}/api/webhooks/twilio/voice/agent-connect`;

    const ringPromises: Promise<{ ok: boolean; target: string; sid?: string }>[] = [];
    for (const target of ringTargets) {
      const agentConnectUrl = new URL(agentConnectBase);
      agentConnectUrl.searchParams.set('conference', conferenceName);
      agentConnectUrl.searchParams.set('call_sid', callSid);
      agentConnectUrl.searchParams.set('operator_id', target.id);
      const agentStatusCallbackUrl = new URL(`${baseUrl}/api/webhooks/twilio/voice/status`);
      agentStatusCallbackUrl.searchParams.set('parent_call_sid', callSid);
      agentStatusCallbackUrl.searchParams.set('queue_strategy', queue.strategy);
      agentStatusCallbackUrl.searchParams.set('target_user_id', target.id);
      agentStatusCallbackUrl.searchParams.set('attempt_id', ringAttemptId);

      // Ring agent's browser Device (Twilio Client)
      ringPromises.push(
        twilioClient.calls.create({
          to: `client:${target.id}`,
          from: ringCallerId,
          url: agentConnectUrl.toString(),
          statusCallback: agentStatusCallbackUrl.toString(),
          statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
          timeout: queue.ring_timeout,
        }).then((created) => ({ ok: true, target: `client:${target.id}`, sid: created.sid }))
          .catch((err) => {
            console.warn(`[INCOMING] Failed to ring client:${target.id}: ${err.message}`);
            return { ok: false, target: `client:${target.id}` };
          })
      );

      // Sonar al MÓVIL del agente SOLO si NO tiene un softphone de escritorio
      // (Tauri) vivo. Un móvil cuyo buzón de voz auto-contesta "responde" la
      // leg y crea una llamada fantasma (agente conectado en línea muerta,
      // llamante atrapado sin nadie que hable). "Todo por Tauri": el softphone
      // es la vía de audio; el móvil queda solo como último recurso para
      // agentes sin stream de escritorio.
      const agentHasDesktopSoftphone = hasActiveDesktopStreamForUser(target.id);
      if (target.phone && agentHasDesktopSoftphone) {
        console.log(`[INCOMING] Móvil omitido para operator=${target.id}: softphone de escritorio activo.`);
      }
      if (target.phone && !agentHasDesktopSoftphone) {
        ringPromises.push(
          twilioClient.calls.create({
            to: target.phone,
            from: ringCallerId,
            url: agentConnectUrl.toString(),
            statusCallback: agentStatusCallbackUrl.toString(),
            statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
            timeout: queue.ring_timeout,
          }).then((created) => ({ ok: true, target: target.phone!, sid: created.sid }))
            .catch((err) => {
              console.warn(`[INCOMING] Failed to ring phone ${target.phone}: ${err.message}`);
              return { ok: false, target: target.phone! };
            })
        );
      }
    }

    // Wait for all ring attempts and check at least one succeeded
    const ringResults = await Promise.all(ringPromises);
    const anyRingOk = ringResults.some(r => r.ok);
    if (!anyRingOk && ringResults.length > 0) {
      console.error(`[INCOMING] ALL ring attempts failed for CallSid=${callSid} — redirecting to retry`);
      twiml.pause({ length: 3 });
      twiml.redirect({ method: 'POST' }, `${baseUrl}/api/webhooks/twilio/voice/queue-retry`);
      return twimlResponse(twiml);
    }

    // Guardar las legs del intento: el avance de ring_all (voice/status)
    // necesita saber cuándo TODAS han terminado sin respuesta. Solo se
    // mergea este campo para no pisar la limpieza de ring targets que
    // agent-connect pudiera haber hecho si alguien contesta muy rápido.
    const createdLegSids = ringResults
      .filter((result): result is { ok: true; target: string; sid: string } => result.ok && typeof result.sid === 'string')
      .map((result) => result.sid);
    if (createdLegSids.length > 0) {
      await mergeRoutingMetadata({ current_ring_attempt_leg_sids: createdLegSids });
    }

    // Advance round-robin index with an optimistic guard: only write if the
    // index is still what we read. Two calls arriving together both read the
    // same index; without the guard both write the same "next" value, losing
    // an increment and skipping agents. (Note: this prevents index skew but
    // not the rarer case where both already selected the same target above —
    // fully eliminating that needs an atomic select-and-advance DB function.)
    // No avanzar cuando el intento fue una reconexión pegajosa: el agente
    // del turno normal no llegó a sonar y no debe perder su posición.
    if (queue.strategy !== 'ring_all' && !stickyOperator) {
      const { error: rotateErr } = await supabase
        .from('queues')
        .update({
          current_index: (queue.current_index + 1) % operators.length,
          last_rotated_at: new Date().toISOString(),
        })
        .eq('id', queue.id)
        .eq('current_index', queue.current_index);
      if (rotateErr) {
        console.warn(`[INCOMING] Round-robin index advance failed for queue ${queue.id}: ${rotateErr.message}`);
      }
    }

    // Put the caller into the conference (they hear hold music until agent joins)
    const dial = twiml.dial({
      action: `${baseUrl}/api/webhooks/twilio/voice/dial-action`,
      timeout: 120,
      record: route.phoneNumber.record_calls ? 'record-from-answer-dual' as const : 'do-not-record' as const,
      recordingStatusCallback: route.phoneNumber.record_calls
        ? `${baseUrl}/api/webhooks/twilio/recording/status`
        : undefined,
    });
    dial.conference(
      {
        startConferenceOnEnter: true,
        // Do not tear down the whole conference if caller leg leaves transiently
        // (some external PBXs "hold" by temporarily re-signaling/parking the leg).
        endConferenceOnExit: false,
        beep: 'false' as const,
        waitUrl: conferenceWaitUrl,
        maxParticipants: 10,
        statusCallbackEvent: ['join', 'leave', 'end'],
        statusCallback: `${baseUrl}/api/webhooks/twilio/voice/status`,
      },
      conferenceName,
    );

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
