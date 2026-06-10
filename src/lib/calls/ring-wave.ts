import { randomUUID } from 'crypto';
import { createAdminClient } from '@/lib/supabase/admin';
import { getTwilioClient } from '@/lib/twilio/client';
import { getQueueWithOperators } from '@/lib/twilio/call-engine';
import { mergeTwilioData } from '@/lib/calls/leg-resolution';
import { emitEvent } from '@/lib/events/emitter';
import type { CallRecord, Queue } from '@/lib/types/database';

/**
 * Olas de ring EN SITIO para colas ring_all (hotfix del rebote de PRO).
 *
 * El primer avance de ring_all redirigía al llamante a queue-retry cuando
 * todas las legs del intento morían. En producción las legs REST a
 * `client:<uid>` FALLAN EN ~2s (el Tauri no registra Device; el accept real
 * va por SSE + device.connect), así que el "avance" expulsaba al llamante
 * de la sala cada ~5 segundos: oía "le estamos transfiriendo" en bucle, los
 * accepts aterrizaban en salas vacías y RDN veía la llamada aparecer y
 * morir sin parar.
 *
 * Este módulo re-suena a los agentes SIN tocar la leg del llamante (que se
 * queda en la conferencia con su música), con una cadencia mínima de
 * ring_timeout entre olas aunque las legs mueran al instante. Solo se
 * redirige al llamante a queue-retry en UN caso legítimo: superado
 * max_wait_time con timeout_action distinto de keep_waiting (para que
 * aplique forward/voicemail/hangup).
 *
 * Los timers viven en el proceso pm2 (mismo patrón que room-watchdog). Si
 * el proceso se reinicia con una ola programada, el llamante queda en
 * espera con música hasta colgar — equivalente al comportamiento histórico
 * de ring_all, no un estado nuevo.
 */

const MIN_WAVE_INTERVAL_MS = 15_000;
const NO_OPERATORS_RETRY_MS = 20_000;

type RingWaveState = {
  pending: Set<string>;
};

declare global {
  var __centralitaRingWave: RingWaveState | undefined;
}

function getState(): RingWaveState {
  if (!globalThis.__centralitaRingWave) {
    globalThis.__centralitaRingWave = { pending: new Set<string>() };
  }
  return globalThis.__centralitaRingWave;
}

function getBaseUrl(): string {
  return process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Programa la siguiente ola de ring para una llamada cuyo intento acaba de
 * morir sin respuesta. `attemptStartedAtIso` es el inicio del intento que
 * acaba de consumirse: la ola nueva no sale antes de ring_timeout desde ese
 * instante (si las legs murieron al instante, esperamos la diferencia).
 */
export function scheduleRingWave(
  parentCallSid: string,
  attemptStartedAtIso: string | null,
  ringTimeoutSeconds: number,
): void {
  const state = getState();
  if (state.pending.has(parentCallSid)) return;
  state.pending.add(parentCallSid);

  const attemptStartedMs = attemptStartedAtIso ? Date.parse(attemptStartedAtIso) : NaN;
  const sinceAttemptMs = Number.isFinite(attemptStartedMs) ? Date.now() - attemptStartedMs : Number.POSITIVE_INFINITY;
  const targetIntervalMs = Math.max(MIN_WAVE_INTERVAL_MS, ringTimeoutSeconds * 1000);
  const delayMs = Math.max(0, targetIntervalMs - sinceAttemptMs);

  console.log(
    `[RING-WAVE] Próxima ola para ${parentCallSid} en ${Math.round(delayMs / 1000)}s (intento anterior duró ${Number.isFinite(sinceAttemptMs) ? Math.round(sinceAttemptMs / 1000) : '?'}s).`
  );

  setTimeout(() => {
    state.pending.delete(parentCallSid);
    void fireRingWave(parentCallSid).catch((err) => {
      console.error(`[RING-WAVE] fireRingWave(${parentCallSid}) falló:`, err);
    });
  }, delayMs);
}

async function fireRingWave(parentCallSid: string): Promise<void> {
  const supabase = createAdminClient();
  const client = getTwilioClient();
  const baseUrl = getBaseUrl();

  const { data } = await supabase
    .from('call_records')
    .select('status, ended_at, started_at, queue_id, from_number, to_number, phone_number_id, answered_by_user_id, twilio_data')
    .eq('twilio_call_sid', parentCallSid)
    .maybeSingle();

  if (!data) return;
  const record = data as Pick<
    CallRecord,
    'status' | 'ended_at' | 'started_at' | 'queue_id' | 'from_number' | 'to_number' | 'phone_number_id' | 'answered_by_user_id' | 'twilio_data'
  >;

  // La llamada ya se contestó / terminó / cambió de fase: nada que hacer.
  if (record.ended_at || record.answered_by_user_id) return;
  if (record.status !== 'in_queue' && record.status !== 'ringing') return;
  if (!record.queue_id) return;

  // ¿El llamante sigue al teléfono? (Si colgó, los callbacks normales
  // cierran el registro; no montamos olas para nadie.)
  try {
    const liveCaller = await client.calls(parentCallSid).fetch();
    const liveStatus = (liveCaller.status || '').toLowerCase();
    if (liveStatus !== 'in-progress') {
      console.log(`[RING-WAVE] ${parentCallSid} ya no está in-progress (${liveStatus}); ola cancelada.`);
      return;
    }
  } catch {
    return;
  }

  const queueData = await getQueueWithOperators(record.queue_id);
  const queue = queueData?.queue as (Queue & { timeout_action?: string }) | undefined;
  if (!queue) return;

  const maxWaitSeconds = queue.max_wait_time ?? 300;
  const timeoutAction = queue.timeout_action ?? 'hangup';
  const waitedSeconds = Math.round((Date.now() - Date.parse(record.started_at)) / 1000);

  // Tiempo máximo superado con acción terminal: ÚNICA situación en la que
  // movemos al llamante — queue-retry aplica forward/voicemail/hangup.
  if (waitedSeconds >= maxWaitSeconds && timeoutAction !== 'keep_waiting') {
    console.log(
      `[RING-WAVE] ${parentCallSid} superó max_wait (${waitedSeconds}s >= ${maxWaitSeconds}s, action=${timeoutAction}) — redirigiendo a queue-retry para la acción de timeout.`
    );
    try {
      await client.calls(parentCallSid).update({
        url: `${baseUrl}/api/webhooks/twilio/voice/queue-retry`,
        method: 'POST',
      });
    } catch (err) {
      console.warn(`[RING-WAVE] Redirect de timeout falló para ${parentCallSid}:`, err);
    }
    return;
  }

  const operators = queueData?.operators ?? [];
  if (operators.length === 0) {
    // Nadie disponible: reintentar en un rato sin molestar al llamante.
    console.log(`[RING-WAVE] Sin operadores libres para ${parentCallSid}; reintento en ${NO_OPERATORS_RETRY_MS / 1000}s.`);
    scheduleRingWave(parentCallSid, new Date().toISOString(), Math.ceil(NO_OPERATORS_RETRY_MS / 1000));
    return;
  }

  const ringTargets = queue.strategy === 'ring_all'
    ? operators
    : (operators[queue.current_index % operators.length]
      ? [operators[queue.current_index % operators.length]]
      : operators.slice(0, 1));
  const ringAttemptId = randomUUID();
  const conferenceName = (() => {
    const stored = asRecord(record.twilio_data).conference_name;
    return typeof stored === 'string' && stored.length > 0 ? stored : `call-${parentCallSid}`;
  })();

  await mergeTwilioData(parentCallSid, {
    candidate_user_ids: operators.map((op) => op.id),
    current_ring_target_user_ids: ringTargets.map((t) => t.id),
    conference_name: conferenceName,
    incoming_conference_request: true,
    routing_source: 'ring_wave',
    current_round_robin_attempt_id: ringAttemptId,
    current_round_robin_attempt_started_at: new Date().toISOString(),
    last_routing_at: new Date().toISOString(),
  });

  for (const target of ringTargets) {
    emitEvent('call.ringing', {
      call_sid: parentCallSid,
      direction: 'inbound',
      status: 'ringing',
      from: record.from_number ?? null,
      to: record.to_number ?? null,
      queue_id: queue.id,
      phone_number_id: record.phone_number_id ?? null,
      ring_strategy: queue.strategy,
      user_id: target.id,
      answered_by_user_id: target.id,
      rdn_user_id: target.rdn_user_id ?? null,
      conference_name: conferenceName,
      incoming_conference_request: true,
      ring_wave: true,
    });
  }

  const ringCallerId = record.to_number || record.from_number;
  const agentConnectBase = `${baseUrl}/api/webhooks/twilio/voice/agent-connect`;
  const created: string[] = [];

  for (const target of ringTargets) {
    const agentConnectUrl = new URL(agentConnectBase);
    agentConnectUrl.searchParams.set('conference', conferenceName);
    agentConnectUrl.searchParams.set('call_sid', parentCallSid);
    agentConnectUrl.searchParams.set('operator_id', target.id);
    const statusUrl = new URL(`${baseUrl}/api/webhooks/twilio/voice/status`);
    statusUrl.searchParams.set('parent_call_sid', parentCallSid);
    statusUrl.searchParams.set('queue_strategy', queue.strategy);
    statusUrl.searchParams.set('target_user_id', target.id);
    statusUrl.searchParams.set('attempt_id', ringAttemptId);

    const destinations = [`client:${target.id}`, ...(target.phone ? [target.phone] : [])];
    for (const destination of destinations) {
      try {
        const call = await client.calls.create({
          to: destination,
          from: ringCallerId,
          url: agentConnectUrl.toString(),
          statusCallback: statusUrl.toString(),
          statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
          timeout: queue.ring_timeout,
        });
        created.push(call.sid);
      } catch (err) {
        console.warn(`[RING-WAVE] No se pudo sonar ${destination}:`, err instanceof Error ? err.message : err);
      }
    }
  }

  if (created.length > 0) {
    await mergeTwilioData(parentCallSid, { current_ring_attempt_leg_sids: created });
  }

  console.log(
    `[RING-WAVE] Ola lanzada para ${parentCallSid}: ${created.length} leg(s), targets=${ringTargets.map((t) => t.id).join(',')}, waited=${waitedSeconds}s.`
  );
}
