import { createAdminClient } from '@/lib/supabase/admin';
import { getTwilioClient } from '@/lib/twilio/client';
import { updateCallStatus } from '@/lib/twilio/call-engine';
import { mergeTwilioData } from '@/lib/calls/leg-resolution';
import { emitEvent } from '@/lib/events/emitter';
import twilio from 'twilio';
import type { CallRecord } from '@/lib/types/database';

/**
 * Watchdog de salas de conferencia (Fase 1.4).
 *
 * Contexto: las legs de agente entraban a la conferencia con
 * `endConferenceOnExit: true`, de modo que CUALQUIER caída de esa leg
 * (blip de red, WebView2 suspendido, crash del Tauri) tiraba la sala
 * entera y dial-action colgaba al llamante en mitad de la conversación.
 * Al quitar ese flag, la sala sobrevive a la caída del agente — pero
 * alguien tiene que encargarse del llamante que queda solo. Ese alguien
 * es este watchdog:
 *
 *   1. Cuando la leg del agente sale de la sala con la llamada todavía
 *      in_progress (evento participant-leave, ver voice/status), se
 *      estampa `agent_left_room_at` en twilio_data, se anuncia al
 *      llamante que estamos reconectando, y se programa un re-check.
 *   2. Pasada la ventana de gracia (suficiente para que el Tauri haga
 *      rejoin automático), el re-check mira el estado VIVO de la sala:
 *      - Hay alguien más con el llamante → falso positivo, limpiar.
 *      - Llamante solo + llamada entrante con cola → re-encolar
 *        (redirect a queue-retry: vuelve a sonar a los agentes).
 *      - Llamante solo sin cola (salientes re-puenteadas, etc.) →
 *        despedida + hangup + cierre del registro.
 *
 * El timer vive en el proceso Node (despliegue pm2 de larga vida). Como
 * red de seguridad ante reinicios, `sweepRoomWatchdog()` re-examina los
 * marcadores pendientes; se invoca con debounce desde el webhook de
 * status (cualquier evento de conferencia) y desde /api/v1/calls/reconcile.
 */

const AGENT_LOSS_GRACE_MS = 45_000;
const SWEEP_MIN_INTERVAL_MS = 60_000;
const SWEEP_BATCH_LIMIT = 20;

type RoomWatchdogState = {
  pendingChecks: Set<string>;
  lastSweepAt: number;
};

declare global {
  var __centralitaRoomWatchdog: RoomWatchdogState | undefined;
}

function getState(): RoomWatchdogState {
  if (!globalThis.__centralitaRoomWatchdog) {
    globalThis.__centralitaRoomWatchdog = {
      pendingChecks: new Set<string>(),
      lastSweepAt: 0,
    };
  }
  return globalThis.__centralitaRoomWatchdog;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function getBaseUrl(): string {
  return process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
}

/**
 * Punto de entrada desde voice/status cuando una leg de AGENTE sale de la
 * sala con el registro in_progress. Decide en caliente:
 *  - Leg de teléfono físico → el agente colgó su terminal a propósito (es
 *    su única forma de colgar): teardown explícito, sin gracia.
 *  - Leg client (Tauri/navegador) → posible caída: marcador + announce +
 *    re-check diferido.
 */
export async function handleAgentLegLeftRoom(params: {
  parentCallSid: string;
  agentLegSid: string;
  conferenceSid: string | null;
  friendlyName: string | null;
}): Promise<void> {
  const { parentCallSid, agentLegSid, conferenceSid, friendlyName } = params;
  const client = getTwilioClient();

  // ¿La leg que se fue era client: (softphone) o un teléfono físico?
  let agentLegTo = '';
  try {
    const leg = await client.calls(agentLegSid).fetch();
    agentLegTo = leg.to || '';
  } catch {
    // Si no podemos saberlo, tratamos como client (gracia + rejoin):
    // preferimos 45s de espera a colgar una llamada recuperable.
  }
  const isPhoneLeg = agentLegTo.length > 0 && !agentLegTo.startsWith('client:');

  if (isPhoneLeg) {
    console.warn(
      `[ROOM-WATCHDOG] Leg de teléfono ${agentLegSid} colgó (to=${agentLegTo}) con la llamada ${parentCallSid} in_progress — teardown explícito (equivale al hangup del agente).`
    );
    await teardownAbandonedCall({
      parentCallSid,
      reason: 'agent_phone_hangup',
      farewell: false,
    });
    return;
  }

  // Si queda alguien más con el llamante (3-way, otro agente), no hay
  // abandono: ignorar. También evita anunciar "reconectando" en salas
  // donde la conversación sigue.
  try {
    if (conferenceSid) {
      const participants = await client.conferences(conferenceSid).participants.list();
      const others = participants.filter(
        (p) => p.callSid !== parentCallSid && p.callSid !== agentLegSid,
      );
      if (others.length > 0) {
        console.log(
          `[ROOM-WATCHDOG] Leg de agente ${agentLegSid} salió pero quedan ${others.length} participante(s) además del llamante — sin acción.`
        );
        return;
      }
      const callerStillThere = participants.some((p) => p.callSid === parentCallSid);
      if (!callerStillThere) {
        // El llamante tampoco está: teardown normal en curso (status
        // callbacks del llamante lo cierran). Nada que vigilar.
        return;
      }
    }
  } catch (err) {
    console.warn('[ROOM-WATCHDOG] No se pudo inspeccionar la sala al salir el agente:', err);
  }

  const nowIso = new Date().toISOString();
  await mergeTwilioData(parentCallSid, {
    agent_left_room_at: nowIso,
    agent_left_room_leg: agentLegSid,
    agent_left_room_conference: friendlyName ?? null,
  });

  console.warn(
    `[ROOM-WATCHDOG] Leg client ${agentLegSid} salió de ${friendlyName ?? conferenceSid ?? '-'} con ${parentCallSid} in_progress — gracia de ${AGENT_LOSS_GRACE_MS / 1000}s para rejoin.`
  );

  // Tranquilizar al llamante mientras dura la gracia (best-effort).
  if (conferenceSid) {
    try {
      await client.conferences(conferenceSid).update({
        announceUrl: `${getBaseUrl()}/api/webhooks/twilio/voice/conference-announce`,
        announceMethod: 'POST',
      });
    } catch {
      // Sin announce no pasa nada; la gracia sigue su curso.
    }
  }

  scheduleAgentLossCheck(parentCallSid);
}

/** Programa el re-check diferido (idempotente por llamada). */
export function scheduleAgentLossCheck(parentCallSid: string): void {
  const state = getState();
  if (state.pendingChecks.has(parentCallSid)) return;
  state.pendingChecks.add(parentCallSid);

  setTimeout(() => {
    state.pendingChecks.delete(parentCallSid);
    void runAgentLossCheck(parentCallSid, 'timer').catch((err) => {
      console.error(`[ROOM-WATCHDOG] runAgentLossCheck(${parentCallSid}) falló:`, err);
    });
  }, AGENT_LOSS_GRACE_MS + 2_000);
}

/** Limpia el marcador (el agente volvió a entrar a la sala). */
export async function clearAgentLossMarker(parentCallSid: string, reason: string): Promise<void> {
  await mergeTwilioData(parentCallSid, {
    agent_left_room_at: null,
    agent_left_room_leg: null,
    agent_left_room_conference: null,
    agent_loss_cleared_at: new Date().toISOString(),
    agent_loss_cleared_reason: reason,
  });
}

/**
 * Re-check tras la gracia. Solo actúa si el registro sigue in_progress,
 * el marcador sigue puesto y el estado vivo de Twilio confirma que el
 * llamante está solo en la sala.
 */
export async function runAgentLossCheck(
  parentCallSid: string,
  source: 'timer' | 'sweep',
): Promise<void> {
  const supabase = createAdminClient();
  const client = getTwilioClient();

  const { data } = await supabase
    .from('call_records')
    .select('status, ended_at, direction, queue_id, from_number, to_number, answered_by_user_id, twilio_data')
    .eq('twilio_call_sid', parentCallSid)
    .maybeSingle();

  if (!data) return;
  const record = data as Pick<
    CallRecord,
    'status' | 'ended_at' | 'direction' | 'queue_id' | 'from_number' | 'to_number' | 'answered_by_user_id' | 'twilio_data'
  >;

  if (record.status !== 'in_progress' || record.ended_at) {
    // La llamada se cerró por su cauce normal durante la gracia.
    return;
  }

  const twilioData = asRecord(record.twilio_data);
  const markerAtRaw = twilioData.agent_left_room_at;
  if (typeof markerAtRaw !== 'string' || markerAtRaw.length === 0) {
    // El agente se reincorporó (participant-join limpió el marcador).
    return;
  }
  const markerAgeMs = Date.now() - Date.parse(markerAtRaw);
  if (!Number.isFinite(markerAgeMs)) return;
  if (markerAgeMs < AGENT_LOSS_GRACE_MS) {
    // Re-check temprano (sweep): dejar que el timer haga su trabajo.
    if (source === 'sweep') scheduleAgentLossCheck(parentCallSid);
    return;
  }

  const conferenceName =
    (typeof twilioData.agent_left_room_conference === 'string' && twilioData.agent_left_room_conference)
    || (typeof twilioData.conference_name === 'string' && twilioData.conference_name)
    || `call-${parentCallSid}`;

  // Estado vivo de la sala.
  let conferenceSid: string | null = null;
  try {
    const conferences = await client.conferences.list({
      friendlyName: conferenceName,
      status: 'in-progress',
      limit: 1,
    });
    conferenceSid = conferences[0]?.sid ?? null;
  } catch (err) {
    console.warn(`[ROOM-WATCHDOG] No se pudo listar la sala ${conferenceName}:`, err);
    return; // Twilio inaccesible: mejor reintentar en el próximo sweep.
  }

  if (!conferenceSid) {
    // La sala ya no existe. Si la leg del llamante murió y el webhook se
    // perdió, cerramos aquí; si sigue viva (p. ej. en pleno redirect de
    // queue-retry) no tocamos nada.
    try {
      const liveCaller = await client.calls(parentCallSid).fetch();
      const liveStatus = (liveCaller.status || '').toLowerCase();
      const terminal = ['completed', 'busy', 'no-answer', 'failed', 'canceled'].includes(liveStatus);
      if (terminal) {
        await clearAgentLossMarker(parentCallSid, 'room_gone_caller_terminal');
        await updateCallStatus(parentCallSid, {
          status: liveStatus === 'no-answer' ? 'no_answer' : liveStatus,
          endedAt: liveCaller.endTime ? new Date(liveCaller.endTime).toISOString() : new Date().toISOString(),
          duration: parseInt(String(liveCaller.duration ?? '0'), 10) || 0,
          terminalSource: 'room_watchdog_room_gone',
        });
        emitEvent('call.completed', {
          call_sid: parentCallSid,
          direction: record.direction,
          status: 'completed',
          from: record.from_number ?? null,
          to: record.to_number ?? null,
          queue_id: record.queue_id ?? null,
          answered_by_user_id: record.answered_by_user_id ?? null,
          duration: parseInt(String(liveCaller.duration ?? '0'), 10) || 0,
          wait_time: null,
          answered_at: null,
          ended_at: new Date().toISOString(),
          terminal_source: 'room_watchdog_room_gone',
        });
      } else {
        await clearAgentLossMarker(parentCallSid, 'room_gone_caller_alive');
      }
    } catch {
      // 404 y similares: que lo resuelvan los reconciliadores normales.
    }
    return;
  }

  let participants: Array<{ callSid: string }> = [];
  try {
    participants = await client.conferences(conferenceSid).participants.list();
  } catch (err) {
    console.warn(`[ROOM-WATCHDOG] No se pudieron listar participantes de ${conferenceName}:`, err);
    return;
  }

  const othersWithCaller = participants.filter((p) => p.callSid !== parentCallSid);
  const callerPresent = participants.some((p) => p.callSid === parentCallSid);

  if (othersWithCaller.length > 0) {
    // Alguien (el agente que volvió, otro agente, un tercero) está con el
    // llamante: falso positivo, limpiar y salir.
    await clearAgentLossMarker(parentCallSid, `recheck_others_present_${source}`);
    return;
  }

  if (!callerPresent) {
    // Sala viva pero sin el llamante (carrera con un redirect). No actuar.
    await clearAgentLossMarker(parentCallSid, `recheck_caller_not_in_room_${source}`);
    return;
  }

  // ── Llamante solo, agente no volvió: actuar. ──────────────────────────
  console.warn(
    `[ROOM-WATCHDOG] Llamante ${parentCallSid} solo en ${conferenceName} tras ${Math.round(markerAgeMs / 1000)}s sin agente (source=${source}).`
  );

  const lostAgentId = record.answered_by_user_id ?? null;
  const canRequeue = record.direction === 'inbound' && Boolean(record.queue_id);

  if (canRequeue) {
    // Re-encolar: liberar al agente perdido y mandar al llamante a
    // queue-retry, que vuelve a sonar agentes y lo re-mete en la sala.
    const requeuedAt = new Date().toISOString();
    await supabase
      .from('call_records')
      .update({
        status: 'in_queue',
        answered_by_user_id: null,
        twilio_data: {
          ...twilioData,
          agent_left_room_at: null,
          agent_left_room_leg: null,
          agent_left_room_conference: null,
          hold: null,
          room_watchdog_requeued_at: requeuedAt,
          room_watchdog_lost_agent_id: lostAgentId,
          room_watchdog_source: source,
        },
      })
      .eq('twilio_call_sid', parentCallSid)
      .eq('status', 'in_progress')
      .is('ended_at', null);

    try {
      await client.calls(parentCallSid).update({
        url: `${getBaseUrl()}/api/webhooks/twilio/voice/queue-retry`,
        method: 'POST',
      });
      console.warn(
        `[ROOM-WATCHDOG] ${parentCallSid} re-encolado (agente perdido=${lostAgentId ?? '-'}).`
      );
      emitEvent('call.ringing', {
        call_sid: parentCallSid,
        direction: 'inbound',
        status: 'in_queue',
        from: record.from_number ?? null,
        to: record.to_number ?? null,
        queue_id: record.queue_id ?? null,
        requeued_by_room_watchdog: true,
        lost_agent_id: lostAgentId,
      });
    } catch (redirectErr) {
      console.error(
        `[ROOM-WATCHDOG] Falló el redirect a queue-retry de ${parentCallSid}:`,
        redirectErr,
      );
      // Restaurar in_progress para que el próximo sweep lo reintente o el
      // reconcile lo cierre si la leg murió.
      await supabase
        .from('call_records')
        .update({ status: 'in_progress', answered_by_user_id: lostAgentId })
        .eq('twilio_call_sid', parentCallSid)
        .is('ended_at', null);
    }
    return;
  }

  // Sin cola a la que volver: despedida + cierre ordenado.
  await teardownAbandonedCall({
    parentCallSid,
    reason: 'room_watchdog_agent_lost',
    farewell: true,
  });
}

/**
 * Cierre explícito de una llamada cuyo agente desapareció: cuelga la leg
 * del llamante (con o sin mensaje) y deja el registro terminal coherente.
 */
async function teardownAbandonedCall(params: {
  parentCallSid: string;
  reason: string;
  farewell: boolean;
}): Promise<void> {
  const { parentCallSid, reason, farewell } = params;
  const supabase = createAdminClient();
  const client = getTwilioClient();

  const { data } = await supabase
    .from('call_records')
    .select('direction, queue_id, from_number, to_number, answered_by_user_id, answered_at, started_at')
    .eq('twilio_call_sid', parentCallSid)
    .maybeSingle();

  try {
    if (farewell) {
      const farewellTwiml = new twilio.twiml.VoiceResponse();
      farewellTwiml.say(
        { language: 'es-ES', voice: 'Polly.Conchita' },
        'No ha sido posible recuperar la conexión con su agente. Disculpe las molestias.'
      );
      farewellTwiml.hangup();
      await client.calls(parentCallSid).update({ twiml: farewellTwiml.toString() });
    } else {
      await client.calls(parentCallSid).update({ status: 'completed' });
    }
  } catch (hangupErr) {
    console.warn(`[ROOM-WATCHDOG] No se pudo colgar ${parentCallSid} (${reason}):`, hangupErr);
  }

  const endedAt = new Date().toISOString();
  await clearAgentLossMarker(parentCallSid, reason);
  await updateCallStatus(parentCallSid, {
    status: 'completed',
    endedAt,
    terminalSource: reason,
  });

  const rec = (data ?? {}) as Partial<CallRecord>;
  emitEvent('call.completed', {
    call_sid: parentCallSid,
    direction: rec.direction ?? 'inbound',
    status: 'completed',
    from: rec.from_number ?? null,
    to: rec.to_number ?? null,
    queue_id: rec.queue_id ?? null,
    answered_by_user_id: rec.answered_by_user_id ?? null,
    duration: rec.answered_at ? Math.max(0, Math.round((Date.now() - Date.parse(rec.answered_at)) / 1000)) : 0,
    wait_time: null,
    answered_at: rec.answered_at ?? null,
    ended_at: endedAt,
    terminal_source: reason,
  });
}

/**
 * Barrido de marcadores pendientes. Red de seguridad para timers perdidos
 * en un reinicio del proceso. Con debounce para poder invocarlo desde el
 * webhook de status sin coste.
 */
export async function sweepRoomWatchdog(options?: { force?: boolean }): Promise<number> {
  const state = getState();
  const now = Date.now();
  if (!options?.force && now - state.lastSweepAt < SWEEP_MIN_INTERVAL_MS) return 0;
  state.lastSweepAt = now;

  const supabase = createAdminClient();
  const { data } = await supabase
    .from('call_records')
    .select('twilio_call_sid')
    .eq('status', 'in_progress')
    .is('ended_at', null)
    .not('twilio_data->>agent_left_room_at', 'is', null)
    .limit(SWEEP_BATCH_LIMIT);

  const rows = (data ?? []) as Array<{ twilio_call_sid: string | null }>;
  let checked = 0;
  for (const row of rows) {
    if (!row.twilio_call_sid) continue;
    checked += 1;
    await runAgentLossCheck(row.twilio_call_sid, 'sweep').catch((err) => {
      console.error(`[ROOM-WATCHDOG] sweep check ${row.twilio_call_sid} falló:`, err);
    });
  }
  if (checked > 0) {
    console.log(`[ROOM-WATCHDOG] sweep: ${checked} marcador(es) re-examinados.`);
  }
  return checked;
}
