/**
 * Transferencia de llamadas ENTRE AGENTES, dentro de la sala.
 *
 * Por qué existe: la transferencia antigua sacaba al llamante de la
 * conferencia y le hacía `<Dial><Client>` al compañero. El softphone Tauri no
 * registra su Device en Twilio (recibe por SSE y entra con device.connect),
 * así que ese `<Dial>` no tenía dónde sonar: acababa `no-answer` en 0 s y el
 * TwiML colgaba al cliente. Verificado en las dos únicas transferencias a
 * agente de 90 días en producción (21-jul y 05-ago de 2026).
 *
 * Flujo — el llamante NUNCA sale de la sala:
 *   1. ringing   — llamante en espera nativa con música; al compañero le llega
 *                  un `incoming_call` por SSE (su Tauri suena y puede
 *                  aceptar). El agente que transfiere sigue en la sala.
 *   2. joining   — el webhook `client` deja entrar al compañero (el guard de
 *                  duplicados le rechazaría) SIN cambiar la propiedad aún.
 *   3. completed — la sala confirma que el compañero está dentro
 *                  (participant-join, o el vigilante lo ve en la lista de
 *                  participantes): se quita la espera al llamante, pasa la
 *                  propiedad y se termina la leg del agente que transfería.
 *   4. cancelled — el compañero no contesta, rechaza, no llega a entrar o el
 *                  llamante cuelga. Si el agente original sigue en la sala,
 *                  el llamante vuelve con él; si ya no está (colgó, cerró
 *                  Tauri, se le cayó la red), vuelve a la cola.
 *
 * Durante una transferencia pendiente NINGÚN colgado corta al cliente: si el
 * agente que transfiere cuelga (lo natural tras una transferencia "de toda la
 * vida"), sale solo él y la transferencia sigue — ver leaveTransferAsSource.
 *
 * Por qué la propiedad solo cambia en `completed`: si pasara antes, el
 * snapshot del agente original dejaría de listar la llamada y su Tauri
 * cerraría el audio mientras el cliente espera; y si el compañero fallara al
 * entrar, el cliente se quedaría sin nadie.
 *
 * Por qué el aviso al compañero va SOLO por SSE: RDN convierte cualquier
 * `call.ringing` en estado "sonando" (lib/centralita/ingestion.ts), así que
 * emitirlo por el bus de dominio haría que la llamada en curso volviera a
 * aparecer como entrante en RDN. RDN se entera al completar, con
 * `call.answered` (reasigna accepted_by) + `call.transferred`.
 *
 * Solo llamadas ENTRANTES: las salientes van por `<Dial>` directo, sin sala a
 * la que invitar a nadie.
 *
 * Kill switch: `TRANSFER_IN_ROOM=0` desactiva la transferencia entre agentes
 * (el endpoint responde con error claro; nunca vuelve al camino que colgaba).
 */

import crypto from 'crypto';
import { createAdminClient } from '@/lib/supabase/admin';
import { getTwilioClient } from '@/lib/twilio/client';
import { getBusyAgentIds } from '@/lib/twilio/call-engine';
import { emitEvent } from '@/lib/events/emitter';
import {
  hasActiveDesktopStreamForUser,
  publishCanonicalClientEvent,
} from '@/lib/events/client-stream';
import { auditLog } from '@/lib/api/audit';

/** Cuánto suena el compañero antes de devolver al cliente. */
export const TRANSFER_RING_TIMEOUT_MS = 25_000;
/** Margen desde que el compañero acepta hasta que su audio entra en la sala. */
export const TRANSFER_JOIN_GRACE_MS = 15_000;
/**
 * Tras completarse, el aviso del agente que transfirió (en RDN, que sondea
 * cada 3 s) tarda unos segundos en desaparecer. Un "Colgar" suyo en esa
 * ventana colgaría al cliente, que ya habla con el compañero.
 */
export const TRANSFER_HANGUP_GRACE_MS = 15_000;
const WATCH_INTERVAL_MS = 3_000;
const SWEEP_MIN_INTERVAL_MS = 20_000;
const SWEEP_BATCH_LIMIT = 20;
const UNHOLD_ATTEMPTS = 3;
/** Comprobación de que el cliente no se ha quedado solo tras cancelar. */
const ALONE_CHECK_DELAYS_MS = [8_000, 20_000];

export type TransferState = 'ringing' | 'joining' | 'completed' | 'cancelled';

export type AgentTransfer = {
  id: string;
  state: TransferState;
  from_user_id: string;
  from_agent_call_sid: string;
  to_user_id: string;
  to_agent_call_sid: string | null;
  caller_call_sid: string;
  conference_sid: string;
  conference_name: string;
  started_at: string;
  joining_at: string | null;
  finished_at: string | null;
  outcome: string | null;
  /** El agente que transfería ya salió de la sala (colgó a mitad). */
  from_left_at: string | null;
};

type CallRow = {
  id: string;
  twilio_call_sid: string;
  direction: string | null;
  status: string | null;
  ended_at: string | null;
  from_number: string | null;
  to_number: string | null;
  queue_id: string | null;
  answered_by_user_id: string | null;
  twilio_data: Record<string, unknown> | null;
};

const CALL_COLUMNS =
  'id, twilio_call_sid, direction, status, ended_at, from_number, to_number, queue_id, answered_by_user_id, twilio_data';

type TransferWatchState = {
  timers: Map<string, ReturnType<typeof setInterval>>;
  checking: Set<string>;
  starting: Set<string>;
  lastSweepAt: number;
};

declare global {
  var __centralitaTransferWatch: TransferWatchState | undefined;
}

function getWatchState(): TransferWatchState {
  if (!globalThis.__centralitaTransferWatch) {
    globalThis.__centralitaTransferWatch = {
      timers: new Map(),
      checking: new Set(),
      starting: new Set(),
      lastSweepAt: 0,
    };
  }
  return globalThis.__centralitaTransferWatch;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asSid(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function getBaseUrl(): string {
  return process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
}

export function isAgentTransferEnabled(): boolean {
  const raw = process.env.TRANSFER_IN_ROOM?.trim().toLowerCase();
  return raw !== '0' && raw !== 'false';
}

export function readTransfer(twilioData: unknown): AgentTransfer | null {
  const raw = asRecord(asRecord(twilioData).transfer);
  if (typeof raw.id !== 'string' || typeof raw.state !== 'string') return null;
  return raw as unknown as AgentTransfer;
}

export function isTransferActive(transfer: AgentTransfer | null): transfer is AgentTransfer {
  return transfer?.state === 'ringing' || transfer?.state === 'joining';
}

function isLive(row: CallRow): boolean {
  return row.status === 'in_progress' && !row.ended_at;
}

async function loadCall(parentCallSid: string): Promise<CallRow | null> {
  const { data } = await createAdminClient()
    .from('call_records')
    .select(CALL_COLUMNS)
    .eq('twilio_call_sid', parentCallSid)
    .maybeSingle();
  return (data as CallRow | null) ?? null;
}

/**
 * Transición atómica: solo escribe si la transferencia sigue siendo la misma
 * (id) y en el estado esperado — y, con `requireLive`, si la llamada sigue
 * viva. Es lo que resuelve las carreras entre el vigilante (timeout), el
 * participant-join, un reintento de entrada y los colgados. Devuelve la fila
 * escrita, o null si otro camino llegó antes o la escritura falló (el
 * vigilante reintenta en el siguiente tick).
 */
async function transitionTransfer(params: {
  row: CallRow;
  from: TransferState;
  patchTransfer: Partial<AgentTransfer>;
  patchTwilioData?: Record<string, unknown>;
  patchColumns?: Record<string, unknown>;
  requireLive?: boolean;
}): Promise<CallRow | null> {
  const transfer = readTransfer(params.row.twilio_data);
  if (!transfer || transfer.state !== params.from) return null;

  const twilioData = {
    ...asRecord(params.row.twilio_data),
    ...(params.patchTwilioData ?? {}),
    transfer: { ...transfer, ...params.patchTransfer },
  };

  let query = createAdminClient()
    .from('call_records')
    .update({ ...(params.patchColumns ?? {}), twilio_data: twilioData })
    .eq('twilio_call_sid', params.row.twilio_call_sid)
    .filter('twilio_data->transfer->>id', 'eq', transfer.id)
    .filter('twilio_data->transfer->>state', 'eq', params.from);
  if (params.requireLive) {
    query = query.eq('status', 'in_progress').is('ended_at', null);
  }

  const { data, error } = await query.select(CALL_COLUMNS).maybeSingle();
  if (error) {
    console.error(`[TRANSFER] Escritura de estado fallida (${params.row.twilio_call_sid}):`, error.message);
    return null;
  }
  return (data as CallRow | null) ?? null;
}

// ─── Operaciones sobre la sala ───────────────────────────────────────────

/**
 * Quitar la espera al llamante, con reintentos: si falla, el cliente se
 * quedaría con música indefinidamente sin que nadie lo notase. Devuelve false
 * solo si no se pudo; un 404 significa que el llamante ya no está en la sala
 * (colgó) y cuenta como hecho.
 */
async function unholdCaller(transfer: AgentTransfer, context: string): Promise<boolean> {
  for (let attempt = 1; attempt <= UNHOLD_ATTEMPTS; attempt += 1) {
    try {
      await getTwilioClient()
        .conferences(transfer.conference_sid)
        .participants(transfer.caller_call_sid)
        .update({ hold: false });
      return true;
    } catch (err) {
      if ((err as { status?: number }).status === 404) return true;
      if (attempt === UNHOLD_ATTEMPTS) {
        console.error(`[TRANSFER] ${transfer.caller_call_sid} (${context}): no se pudo quitar la espera:`, err);
        return false;
      }
      await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
    }
  }
  return false;
}

/**
 * Terminar una leg de agente. Se termina la LLAMADA, no se saca al
 * participante: con participants.remove() su `<Dial>` seguiría y dial-action
 * emitiría un call.completed espurio. Terminar la leg equivale a que el
 * agente cuelgue (comprobado en producción: no deja eventos).
 */
async function endLeg(callSid: string | null): Promise<void> {
  if (!callSid) return;
  try {
    await getTwilioClient().calls(callSid).update({ status: 'completed' });
  } catch {
    // Ya había colgado.
  }
}

/**
 * ¿Queda en la sala alguien, aparte del llamante y del compañero destino?
 * Es lo que decide, al cancelar, si el llamante vuelve con un agente o a la
 * cola. null = no se pudo saber.
 */
async function isSourceStillInRoom(transfer: AgentTransfer): Promise<boolean | null> {
  try {
    const participants = await getTwilioClient()
      .conferences(transfer.conference_sid)
      .participants.list();
    return participants.some((p) => (
      p.callSid !== transfer.caller_call_sid && p.callSid !== transfer.to_agent_call_sid
    ));
  } catch {
    return null;
  }
}

/**
 * Devolver al llamante a la cola: el agente original ya no está y el
 * compañero no llegó. Mismo mecanismo que el re-encolado del room-watchdog
 * (lib/calls/room-watchdog.ts): queue-retry vuelve a sonar agentes y lo mete
 * de nuevo en la sala.
 */
async function requeueCaller(row: CallRow, transfer: AgentTransfer, reason: string): Promise<boolean> {
  const supabase = createAdminClient();

  if (row.direction !== 'inbound' || !row.queue_id) {
    // Sin cola a la que volver (no debería pasar: una entrante atendida vino
    // de una cola). Al menos, que deje de oír la música de espera.
    console.error(`[TRANSFER] ${row.twilio_call_sid}: sin cola para re-encolar (${reason}); se quita la espera.`);
    await unholdCaller(transfer, `requeue_sin_cola:${reason}`);
    return false;
  }

  const fresh = await loadCall(row.twilio_call_sid);
  const now = new Date().toISOString();
  await supabase
    .from('call_records')
    .update({
      status: 'in_queue',
      answered_by_user_id: null,
      twilio_data: {
        ...asRecord(fresh?.twilio_data ?? row.twilio_data),
        agent_call_sid: null,
        hold: null,
        agent_left_room_at: null,
        agent_left_room_leg: null,
        agent_left_room_conference: null,
        transfer_requeued_at: now,
        transfer_requeue_reason: reason,
      },
    })
    .eq('twilio_call_sid', row.twilio_call_sid)
    .eq('status', 'in_progress')
    .is('ended_at', null);

  try {
    await getTwilioClient().calls(row.twilio_call_sid).update({
      url: `${getBaseUrl()}/api/webhooks/twilio/voice/queue-retry`,
      method: 'POST',
    });
    console.warn(`[TRANSFER] ${row.twilio_call_sid}: re-encolado (${reason}).`);
    void emitEvent('call.ringing', {
      call_sid: row.twilio_call_sid,
      call_record_id: row.id,
      direction: 'inbound',
      status: 'in_queue',
      from: row.from_number ?? null,
      to: row.to_number ?? null,
      queue_id: row.queue_id,
      requeued_by_transfer: true,
    });
    return true;
  } catch (err) {
    console.error(`[TRANSFER] ${row.twilio_call_sid}: falló el re-encolado; se quita la espera:`, err);
    await supabase
      .from('call_records')
      .update({ status: 'in_progress' })
      .eq('twilio_call_sid', row.twilio_call_sid)
      .is('ended_at', null);
    await unholdCaller(transfer, `requeue_fallido:${reason}`);
    return false;
  }
}

/**
 * Red de seguridad tras cancelar: el cliente no puede quedarse solo en la
 * sala. Pasa si al cancelar se creyó que el agente original seguía dentro y
 * no era así (no se pudo mirar la sala, o salió justo entonces), o si falló
 * la vuelta a la cola. Mientras la transferencia estaba activa el
 * room-watchdog no vigilaba esta llamada, así que alguien tiene que hacerlo.
 * Si el cliente sigue solo, se re-encola; si eso falla, se reintenta una vez
 * más. En memoria: un reinicio justo en esos segundos la pierde.
 */
function scheduleAloneCheck(parentCallSid: string, transfer: AgentTransfer, attempt = 0): void {
  const delay = ALONE_CHECK_DELAYS_MS[attempt];
  if (delay === undefined) {
    console.error(`[TRANSFER] ${parentCallSid}: el cliente podría seguir solo tras cancelar; sin más reintentos.`);
    return;
  }
  const timer = setTimeout(() => {
    void (async () => {
      const row = await loadCall(parentCallSid);
      // Terminada, ya re-encolada o con otra transferencia en marcha: nada.
      if (!row || !isLive(row) || isTransferActive(readTransfer(row.twilio_data))) return;

      let participants;
      try {
        participants = await getTwilioClient()
          .conferences(transfer.conference_sid)
          .participants.list();
      } catch {
        scheduleAloneCheck(parentCallSid, transfer, attempt + 1);
        return;
      }
      if (!participants.some((p) => p.callSid === transfer.caller_call_sid)) return;
      if (participants.some((p) => p.callSid !== transfer.caller_call_sid)) return;

      console.warn(`[TRANSFER] ${parentCallSid}: el cliente está solo en la sala tras cancelar; se re-encola.`);
      if (!(await requeueCaller(row, transfer, 'alone_after_cancel'))) {
        scheduleAloneCheck(parentCallSid, transfer, attempt + 1);
      }
    })().catch((err) => {
      console.error(`[TRANSFER] Comprobación de cliente solo en ${parentCallSid} falló:`, err);
    });
  }, delay);
  timer.unref?.();
}

// ─── Inicio ────────────────────────────────────────────────────────────────

export type StartTransferResult =
  | { ok: true; transfer: AgentTransfer; target: { id: string; name: string | null } }
  | { ok: false; status: number; code: string; message: string };

export async function startAgentTransfer(params: {
  /** SID que manda el cliente: el del llamante o el de la leg del agente. */
  callSid: string;
  target: { userId?: string | null; rdnUserId?: string | null };
  requestedByUserId: string | null;
  authMethod: string;
}): Promise<StartTransferResult> {
  const fail = (status: number, code: string, message: string): StartTransferResult => (
    { ok: false, status, code, message }
  );
  const supabase = createAdminClient();

  // 1) La llamada. Aceptamos el SID del llamante o el de la leg del agente,
  //    igual que el resto de endpoints de control.
  let row = await loadCall(params.callSid);
  if (!row) {
    const { data } = await supabase
      .from('call_records')
      .select(CALL_COLUMNS)
      .filter('twilio_data->>agent_call_sid', 'eq', params.callSid)
      .eq('status', 'in_progress')
      .maybeSingle();
    row = (data as CallRow | null) ?? null;
  }
  if (!row || !isLive(row)) {
    return fail(409, 'call_not_active', 'La llamada ya no está activa.');
  }
  if (row.direction !== 'inbound') {
    return fail(
      400,
      'transfer_not_supported',
      'La transferencia a un compañero solo está disponible en llamadas entrantes.',
    );
  }

  const data = asRecord(row.twilio_data);
  if (isTransferActive(readTransfer(data))) {
    return fail(409, 'transfer_in_progress', 'Ya hay una transferencia en curso para esta llamada.');
  }

  const fromUserId = row.answered_by_user_id;
  const fromAgentLeg = asSid(data.agent_call_sid);
  if (!fromUserId || !fromAgentLeg) {
    return fail(409, 'call_not_answered', 'La llamada no tiene un agente conectado que pueda transferirla.');
  }
  const conferenceName = asSid(data.conference_name) ?? `call-${row.twilio_call_sid}`;

  // 2) El destino. Presencia REAL del softphone, no flags de base de datos:
  //    si su Tauri no está conectado, el aviso no le llegaría a nadie.
  let targetQuery = supabase
    .from('users')
    .select('id, name, rdn_user_id')
    .eq('active', true)
    .is('deleted_at', null);
  if (params.target.userId) {
    targetQuery = targetQuery.eq('id', params.target.userId);
  } else if (params.target.rdnUserId) {
    targetQuery = targetQuery.eq('rdn_user_id', params.target.rdnUserId);
  } else {
    return fail(400, 'target_required', 'Falta el compañero al que transferir.');
  }
  const { data: targetRow } = await targetQuery.maybeSingle();
  const target = targetRow as { id: string; name: string | null; rdn_user_id: string | null } | null;
  if (!target) {
    return fail(404, 'target_not_found', 'No se encontró a ese compañero en la centralita.');
  }
  const targetName = target.name || 'El compañero';
  if (target.id === fromUserId) {
    return fail(400, 'same_agent', 'No puedes transferirte la llamada a ti mismo.');
  }
  if (!hasActiveDesktopStreamForUser(target.id)) {
    return fail(409, 'target_offline', `${targetName} no tiene la centralita abierta ahora mismo.`);
  }
  const busy = await getBusyAgentIds(row.twilio_call_sid);
  if (busy.has(target.id)) {
    return fail(409, 'target_busy', `${targetName} está en otra llamada.`);
  }

  // 3) La sala: el llamante y el agente que transfiere tienen que estar dentro.
  const client = getTwilioClient();
  const conferences = await client.conferences.list({
    friendlyName: conferenceName,
    status: 'in-progress',
    limit: 1,
  });
  if (conferences.length === 0) {
    return fail(409, 'no_room', 'La llamada no está en una sala de conferencia.');
  }
  const conferenceSid = conferences[0].sid;
  const participants = await client.conferences(conferenceSid).participants.list();
  if (!participants.some((p) => p.callSid === row.twilio_call_sid)) {
    return fail(409, 'caller_not_in_room', 'El cliente ya no está en la llamada.');
  }
  const fromParticipant = participants.find((p) => p.callSid === fromAgentLeg);
  if (!fromParticipant) {
    return fail(409, 'agent_not_in_room', 'Tu audio no está conectado a la llamada; no se puede transferir.');
  }
  // Salas re-puenteadas por /resume (resume-*): la leg del agente entra con
  // endConferenceOnExit, así que terminarla al completar cerraría la sala y
  // colgaría al cliente y al compañero.
  if (fromParticipant.endConferenceOnExit) {
    return fail(
      409,
      'room_not_transferable',
      'Esta llamada no admite transferencia a un compañero ahora mismo.',
    );
  }

  // Dos peticiones casi a la vez (doble clic, o elegir otro compañero sin
  // esperar): solo una puede registrar la transferencia. Un solo proceso pm2,
  // así que un candado en memoria + releer dentro de él basta.
  const watch = getWatchState();
  if (watch.starting.has(row.twilio_call_sid)) {
    return fail(409, 'transfer_in_progress', 'Ya hay una transferencia en curso para esta llamada.');
  }
  watch.starting.add(row.twilio_call_sid);

  try {
    const fresh = await loadCall(row.twilio_call_sid);
    if (!fresh || !isLive(fresh) || isTransferActive(readTransfer(fresh.twilio_data))) {
      return fail(409, 'transfer_in_progress', 'Ya hay una transferencia en curso para esta llamada.');
    }

    // 4) Registrar la transferencia ANTES de tocar la sala: si algo falla a
    //    mitad, el vigilante sabe que hay un cliente en espera que devolver.
    const now = new Date().toISOString();
    const transfer: AgentTransfer = {
      id: crypto.randomUUID(),
      state: 'ringing',
      from_user_id: fromUserId,
      from_agent_call_sid: fromAgentLeg,
      to_user_id: target.id,
      to_agent_call_sid: null,
      caller_call_sid: row.twilio_call_sid,
      conference_sid: conferenceSid,
      conference_name: conferenceName,
      started_at: now,
      joining_at: null,
      finished_at: null,
      outcome: null,
      from_left_at: null,
    };

    // El marcador `hold` es el mismo que escribe /hold en modo conferencia,
    // así /resume sigue funcionando si el agente recupera al cliente a mano.
    const { error: writeError } = await supabase
      .from('call_records')
      .update({
        twilio_data: {
          ...asRecord(fresh.twilio_data),
          transfer,
          hold: {
            held: true,
            mode: 'conference',
            reason: 'transfer',
            conference_name: conferenceName,
            remote_call_sid: row.twilio_call_sid,
            agent_call_sid: fromAgentLeg,
            at: now,
          },
        },
      })
      .eq('twilio_call_sid', row.twilio_call_sid)
      .eq('status', 'in_progress')
      .is('ended_at', null);

    // Sin estado guardado no se toca la sala: poner al cliente en espera sin
    // un registro que el vigilante pueda ver lo dejaría ahí para siempre.
    if (writeError) {
      console.error(`[TRANSFER] No se pudo registrar la transferencia de ${row.twilio_call_sid}:`, writeError);
      return fail(500, 'transfer_state_failed', 'No se pudo iniciar la transferencia.');
    }

    watchTransfer(row.twilio_call_sid, transfer.id);

    // 5) Cliente en espera nativa con música (la misma de /hold).
    try {
      await client.conferences(conferenceSid).participants(row.twilio_call_sid).update({
        hold: true,
        holdUrl: `${getBaseUrl()}/api/webhooks/twilio/voice/wait-silence`,
        holdMethod: 'POST',
      });
    } catch (err) {
      console.error(`[TRANSFER] No se pudo poner en espera a ${row.twilio_call_sid}:`, err);
      await cancelAgentTransfer(row.twilio_call_sid, transfer.id, 'hold_failed');
      return fail(502, 'hold_failed', 'No se pudo poner al cliente en espera para transferir.');
    }

    // 6) Avisar al compañero. Solo SSE: ver cabecera del fichero.
    await publishCanonicalClientEvent({
      id: crypto.randomUUID(),
      type: 'incoming_call',
      timestamp: now,
      call_sid: row.twilio_call_sid,
      call_record_id: row.id,
      direction: 'inbound',
      status: 'ringing',
      agent_user_id: target.id,
      target_user_ids: [target.id],
      payload: {
        call_sid: row.twilio_call_sid,
        call_record_id: row.id,
        direction: 'inbound',
        status: 'ringing',
        from: row.from_number,
        to: row.to_number,
        conference_name: conferenceName,
        transfer: true,
        transfer_id: transfer.id,
        transferred_from_user_id: fromUserId,
      },
    });

    console.log(
      `[TRANSFER] ${row.twilio_call_sid}: ${fromUserId} -> ${target.id} en sala ${conferenceName} (transfer=${transfer.id})`,
    );

    void auditLog('call.transfer_started', 'call_record', row.twilio_call_sid, params.requestedByUserId, {
      transfer_id: transfer.id,
      mode: 'in_room',
      from_user_id: fromUserId,
      to_user_id: target.id,
      to_rdn_user_id: target.rdn_user_id,
      auth_method: params.authMethod,
    });

    return { ok: true, transfer, target: { id: target.id, name: target.name } };
  } finally {
    watch.starting.delete(row.twilio_call_sid);
  }
}

// ─── Entrada del compañero (webhook `client`) ─────────────────────────────

/**
 * Llamado por el webhook `client` antes de su guard de duplicados. Devuelve
 * true si esta leg es el compañero destino de una transferencia en curso: en
 * ese caso el webhook debe dejarla entrar y NO tocar la propiedad de la
 * llamada (eso ocurre al confirmar que está en la sala).
 */
export async function claimTransferJoin(params: {
  parentCallSid: string;
  operatorId: string;
  legSid: string;
}): Promise<boolean> {
  const row = await loadCall(params.parentCallSid);
  if (!row || !isLive(row)) return false;

  const transfer = readTransfer(row.twilio_data);
  if (!isTransferActive(transfer) || transfer.to_user_id !== params.operatorId) return false;

  const now = new Date().toISOString();
  const claimed = await transitionTransfer({
    row,
    from: transfer.state,
    patchTransfer: { state: 'joining', to_agent_call_sid: params.legSid, joining_at: now },
    requireLive: true,
  });

  if (claimed) {
    console.log(
      `[TRANSFER] ${params.parentCallSid}: el compañero ${params.operatorId} entra con la leg ${params.legSid}`,
    );
  }
  return Boolean(claimed);
}

// ─── Confirmación en sala (webhook de estado) ─────────────────────────────

/**
 * Llamado desde voice/status en cada participant-join. Completa la
 * transferencia cuando el que entra es la leg del compañero, y echa a una
 * leg que llega después de cancelar (el cliente ya volvió con el original).
 */
export async function completeTransferOnParticipantJoin(params: {
  parentCallSid: string;
  participantCallSid: string;
}): Promise<void> {
  const row = await loadCall(params.parentCallSid);
  if (!row) return;
  const transfer = readTransfer(row.twilio_data);
  if (!transfer || transfer.to_agent_call_sid !== params.participantCallSid) return;

  if (transfer.state === 'cancelled') {
    console.warn(
      `[TRANSFER] ${params.parentCallSid}: la leg ${params.participantCallSid} entró tras cancelar (${transfer.outcome}); se retira.`,
    );
    await endLeg(params.participantCallSid);
    return;
  }

  if (transfer.state === 'joining') {
    await finalizeTransfer(row, transfer);
  }
}

/** Devuelve true si la transferencia terminó (completada o, si la llamada ya no vivía, cancelada). */
async function finalizeTransfer(row: CallRow, transfer: AgentTransfer): Promise<boolean> {
  // La llamada murió mientras el compañero entraba (el cliente se cansó de
  // esperar): no se completa nada sobre un registro terminado — RDN la
  // "resucitaría" con el call.answered.
  if (!isLive(row)) {
    return cancelAgentTransfer(row.twilio_call_sid, transfer.id, 'call_ended');
  }

  // Quitar la espera ANTES de completar: si Twilio falla, no se completa y el
  // vigilante lo reintenta en el siguiente tick con el agente original aún
  // en la sala. Cualquiera de los dos finales quita la espera igualmente.
  if (!(await unholdCaller(transfer, 'completar'))) return false;

  // Releer: los reintentos de arriba pueden tardar segundos, y la escritura
  // de abajo reescribe twilio_data entero — con la lectura vieja pisaría lo
  // que otros hayan escrito entretanto.
  const fresh = await loadCall(row.twilio_call_sid);
  const freshTransfer = readTransfer(fresh?.twilio_data);
  if (!fresh || !freshTransfer || freshTransfer.id !== transfer.id || freshTransfer.state !== 'joining') {
    return false;
  }

  const now = new Date().toISOString();
  const previous = asRecord(fresh.twilio_data);
  const currentAgentLeg = asSid(previous.agent_call_sid);

  const completed = await transitionTransfer({
    row: fresh,
    from: 'joining',
    patchTransfer: { state: 'completed', finished_at: now, outcome: 'completed' },
    patchTwilioData: {
      agent_call_sid: transfer.to_agent_call_sid,
      hold: { ...asRecord(previous.hold), held: false, released_at: now },
      // Cualquier marcador del room-watchdog de la leg original queda sin
      // sentido: la llamada ya tiene agente en la sala.
      agent_left_room_at: null,
      agent_left_room_leg: null,
      agent_left_room_conference: null,
      transferred_at: now,
      transferred_by_user_id: transfer.from_user_id,
      transfer_previous_answered_by_user_id: transfer.from_user_id,
    },
    patchColumns: { answered_by_user_id: transfer.to_user_id },
    requireLive: true,
  });
  if (!completed) return false;

  stopWatching(row.twilio_call_sid);

  // Fuera el agente que transfería: su leg original y, si el Tauri se
  // re-unió durante el timbre con una leg nueva, también esa.
  await endLeg(transfer.from_agent_call_sid);
  if (
    currentAgentLeg
    && currentAgentLeg !== transfer.from_agent_call_sid
    && currentAgentLeg !== transfer.to_agent_call_sid
  ) {
    await endLeg(currentAgentLeg);
  }

  const { data: users } = await createAdminClient()
    .from('users')
    .select('id, rdn_user_id')
    .in('id', [transfer.from_user_id, transfer.to_user_id]);
  const rdnById = new Map(
    ((users ?? []) as Array<{ id: string; rdn_user_id: string | null }>).map((u) => [u.id, u.rdn_user_id]),
  );
  const toRdnUserId = rdnById.get(transfer.to_user_id) ?? null;
  const bothAgents = [transfer.from_user_id, transfer.to_user_id];

  // RDN: `call.answered` reasigna accepted_by al compañero (su filtro de
  // llamadas activas pasa a mostrársela a él y no al original) y
  // `call.transferred` marca la transferencia como completada. En SSE llegan
  // a los dos Tauri, que refrescan su estado.
  void emitEvent('call.answered', {
    call_sid: row.twilio_call_sid,
    call_record_id: row.id,
    direction: 'inbound',
    status: 'in_progress',
    answered_by_user_id: transfer.to_user_id,
    user_id: transfer.to_user_id,
    rdn_user_id: toRdnUserId,
    candidate_user_ids: bothAgents,
    transfer: true,
  });
  void emitEvent('call.transferred', {
    call_sid: row.twilio_call_sid,
    call_record_id: row.id,
    direction: 'inbound',
    status: 'in_progress',
    destination: `client:${transfer.to_user_id}`,
    user_id: transfer.to_user_id,
    rdn_user_id: toRdnUserId,
    transferred_by_user_id: transfer.from_user_id,
    transferred_by_rdn_user_id: rdnById.get(transfer.from_user_id) ?? null,
    candidate_user_ids: bothAgents,
    mode: 'in_room',
  });

  console.log(
    `[TRANSFER] ${row.twilio_call_sid}: completada ${transfer.from_user_id} -> ${transfer.to_user_id}`,
  );
  void auditLog('call.transfer_completed', 'call_record', row.twilio_call_sid, transfer.to_user_id, {
    transfer_id: transfer.id,
    from_user_id: transfer.from_user_id,
    to_user_id: transfer.to_user_id,
    to_agent_call_sid: transfer.to_agent_call_sid,
    from_left_early: Boolean(transfer.from_left_at),
    ring_ms: Date.parse(transfer.joining_at ?? now) - Date.parse(transfer.started_at),
  });
  return true;
}

// ─── Cancelación ─────────────────────────────────────────────────────────

/**
 * Termina una transferencia sin completarla y calla el timbre del compañero.
 * El llamante vuelve con el agente original si sigue en la sala; si ya no
 * está, vuelve a la cola. Idempotente: si la transferencia ya terminó por
 * otro camino, no hace nada. Devuelve true si esta llamada la canceló.
 */
export async function cancelAgentTransfer(
  parentCallSid: string,
  transferId: string,
  outcome: string,
): Promise<boolean> {
  const row = await loadCall(parentCallSid);
  if (!row) return false;
  const transfer = readTransfer(row.twilio_data);
  if (!isTransferActive(transfer) || transfer.id !== transferId) return false;

  const now = new Date().toISOString();
  const live = isLive(row);
  const previousHold = asRecord(asRecord(row.twilio_data).hold);

  const cancelled = await transitionTransfer({
    row,
    from: transfer.state,
    patchTransfer: { state: 'cancelled', finished_at: now, outcome },
    patchTwilioData: live ? { hold: { ...previousHold, held: false, released_at: now } } : undefined,
  });
  if (!cancelled) return false;

  stopWatching(parentCallSid);

  // Si el compañero llegó a lanzar su leg pero no se completó, fuera: la
  // llamada no es suya.
  await endLeg(transfer.to_agent_call_sid);

  let returnedTo: 'agent' | 'queue' | 'none' = 'none';
  if (live) {
    const sourceInRoom = transfer.from_left_at
      ? false
      : await isSourceStillInRoom(transfer);
    // Si no se pudo mirar la sala, se asume que el agente sigue (salvo que
    // conste que salió): sacar a un cliente de una conversación viva es peor
    // que dejarlo con música unos segundos más con alguien al otro lado.
    if (sourceInRoom === false) {
      returnedTo = 'queue';
      if (!(await requeueCaller(cancelled, transfer, `transfer_${outcome}`))) {
        scheduleAloneCheck(parentCallSid, transfer);
      }
    } else {
      await unholdCaller(transfer, `cancelar:${outcome}`);
      returnedTo = 'agent';
      // Se ha dado por hecho que el agente seguía en la sala: comprobarlo.
      scheduleAloneCheck(parentCallSid, transfer);
    }
  }

  // Callar el timbre del compañero. Solo SSE y solo a él: la llamada sigue
  // viva, un call.completed de dominio la cerraría en RDN para todos.
  await publishCanonicalClientEvent({
    id: crypto.randomUUID(),
    type: 'call_ended',
    timestamp: now,
    call_sid: parentCallSid,
    call_record_id: row.id,
    direction: 'inbound',
    status: 'canceled',
    agent_user_id: transfer.to_user_id,
    target_user_ids: [transfer.to_user_id],
    payload: {
      call_sid: parentCallSid,
      status: 'canceled',
      final_status: 'canceled',
      terminal_source: 'transfer_cancelled',
      reason: outcome,
      transfer_id: transfer.id,
    },
  });

  console.log(`[TRANSFER] ${parentCallSid}: cancelada (${outcome}); el cliente vuelve a: ${returnedTo}`);
  void auditLog('call.transfer_cancelled', 'call_record', parentCallSid, transfer.from_user_id, {
    transfer_id: transfer.id,
    outcome,
    from_user_id: transfer.from_user_id,
    to_user_id: transfer.to_user_id,
    returned_to: returnedTo,
  });
  return true;
}

// ─── Acciones de los agentes durante la transferencia ────────────────────

/**
 * Localiza la llamada a partir del SID que mande un cliente: el del llamante
 * (lo normal en Tauri y RDN), la leg actual del agente (lo que manda el widget
 * en conferencias), la leg del agente original o la del compañero.
 */
async function loadCallByAnySid(callSid: string): Promise<CallRow | null> {
  let row = await loadCall(callSid);
  for (const path of [
    'twilio_data->>agent_call_sid',
    'twilio_data->transfer->>from_agent_call_sid',
    'twilio_data->transfer->>to_agent_call_sid',
  ]) {
    if (row) break;
    const { data } = await createAdminClient()
      .from('call_records')
      .select(CALL_COLUMNS)
      .filter(path, 'eq', callSid)
      .eq('status', 'in_progress')
      .maybeSingle();
    row = (data as CallRow | null) ?? null;
  }
  return row;
}

async function loadActiveTransferRow(callSid: string): Promise<{ row: CallRow; transfer: AgentTransfer } | null> {
  const row = await loadCallByAnySid(callSid);
  if (!row) return null;
  const transfer = readTransfer(row.twilio_data);
  return isTransferActive(transfer) ? { row, transfer } : null;
}

/**
 * Colgado que llega justo DESPUÉS de completarse una transferencia desde el
 * lado del agente que transfirió: su aviso en RDN tarda unos segundos en
 * desaparecer (sondeo de 3 s) y su Tauri puede cruzarse con la finalización.
 * Si se atendiera, colgaría al cliente, que ya habla con el compañero.
 *
 * Solo el nuevo dueño puede colgar en esa ventana. Si no se sabe quién cuelga
 * (API key sin identidad), también se ignora: el nuevo dueño puede colgar
 * desde Tauri o pasada la ventana; cortar a un cliente por error no tiene
 * vuelta atrás.
 */
export async function shouldIgnoreHangupAfterTransfer(
  callSid: string,
  requesterUserId: string | null,
): Promise<boolean> {
  const row = await loadCallByAnySid(callSid);
  if (!row || !isLive(row)) return false;
  const transfer = readTransfer(row.twilio_data);
  if (!transfer || transfer.state !== 'completed' || !transfer.finished_at) return false;
  if (Date.now() - Date.parse(transfer.finished_at) > TRANSFER_HANGUP_GRACE_MS) return false;
  if (requesterUserId && requesterUserId === transfer.to_user_id) return false;

  console.warn(
    `[TRANSFER] ${row.twilio_call_sid}: colgado ignorado ${requesterUserId ?? 'sin identidad'} tras transferencia completada hace ${Date.now() - Date.parse(transfer.finished_at)} ms.`,
  );
  return true;
}

/**
 * El compañero destino cuelga antes de completarse la transferencia: es un
 * RECHAZO. La llamada no se corta, sea cual sea el target que mande su
 * softphone. Sin esto, su snapshot le volvería a presentar la llamada como
 * entrante y le sonaría otra vez.
 *
 * Devuelve true si había una transferencia suya que cancelar. Autorización
 * acotada a propósito: el destino puede rechazar SU transferencia y nada más.
 */
export async function rejectTransferByTarget(callSid: string, userId: string): Promise<boolean> {
  const found = await loadActiveTransferRow(callSid);
  if (!found || found.transfer.to_user_id !== userId) return false;
  return cancelAgentTransfer(found.row.twilio_call_sid, found.transfer.id, 'rejected_by_target');
}

/**
 * Cualquier otro colgado mientras la transferencia está pendiente (el agente
 * que transfiere desde Tauri, o RDN con su API key): sale SOLO el agente y la
 * transferencia sigue, ahora "a ciegas". Es lo que hace alguien acostumbrado
 * a transferir y colgar; antes esto colgaba al cliente justo cuando el
 * compañero iba a coger. Si el compañero no llega, el cliente vuelve a la
 * cola (cancelAgentTransfer ve que ya no queda nadie en la sala).
 *
 * Devuelve true si había una transferencia pendiente (y el colgado se ha
 * resuelto así); false si no la había y el colgado debe seguir su curso.
 */
export async function leaveTransferAsSource(callSid: string, requesterUserId: string | null): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const found = await loadActiveTransferRow(callSid);
    if (!found) return false;
    const { row, transfer } = found;
    if (requesterUserId && requesterUserId === transfer.to_user_id) return false;
    // Llamada ya terminada: el colgado normal no hace daño, y aquí se
    // borraría answered_by de un registro cerrado.
    if (!isLive(row)) return false;

    const currentAgentLeg = asSid(asRecord(row.twilio_data).agent_call_sid);
    const now = new Date().toISOString();
    const left = await transitionTransfer({
      row,
      from: transfer.state,
      patchTransfer: { from_left_at: transfer.from_left_at ?? now },
      // Liberar al agente ya: su Tauri deja de listar la llamada y vuelve a
      // estar disponible. Sin leg de agente registrada, su salida de la sala
      // tampoco dispara el room-watchdog: de este cliente se ocupa la
      // transferencia.
      patchTwilioData: { agent_call_sid: null },
      patchColumns: { answered_by_user_id: null },
      requireLive: true,
    });
    if (!left) continue; // otro camino tocó la transferencia: reevaluar

    await endLeg(transfer.from_agent_call_sid);
    if (currentAgentLeg && currentAgentLeg !== transfer.from_agent_call_sid) {
      await endLeg(currentAgentLeg);
    }
    console.log(
      `[TRANSFER] ${row.twilio_call_sid}: el agente ${transfer.from_user_id} colgó con la transferencia pendiente; sigue a ciegas.`,
    );
    return true;
  }
  // Dos carreras seguidas sin poder anotar la salida: si la transferencia
  // sigue pendiente, el agente sale igualmente (sin tocar al cliente);
  // cancelAgentTransfer verá la sala sin él y re-encolará si hace falta.
  const found = await loadActiveTransferRow(callSid);
  if (!found || !isLive(found.row) || (requesterUserId && requesterUserId === found.transfer.to_user_id)) {
    return false;
  }
  await endLeg(found.transfer.from_agent_call_sid);
  const currentAgentLeg = asSid(asRecord(found.row.twilio_data).agent_call_sid);
  if (currentAgentLeg && currentAgentLeg !== found.transfer.from_agent_call_sid) {
    await endLeg(currentAgentLeg);
  }
  return true;
}

/**
 * El agente que transfiere recupera al cliente (Reanudar) mientras suena el
 * compañero: la transferencia se cancela. Si no, el compañero podría coger
 * después y echarle a mitad de conversación.
 */
export async function cancelTransferOnResume(callSid: string): Promise<boolean> {
  const found = await loadActiveTransferRow(callSid);
  if (!found) return false;
  return cancelAgentTransfer(found.row.twilio_call_sid, found.transfer.id, 'resumed_by_agent');
}

// ─── Vigilancia ──────────────────────────────────────────────────────────

/**
 * Revisa una transferencia en curso. Devuelve true cuando ya no hay nada que
 * vigilar; false si hay que volver a mirar (incluido cuando una escritura
 * falló: el siguiente tick reintenta en vez de dejar al cliente en espera).
 */
async function checkTransfer(parentCallSid: string, transferId: string | null): Promise<boolean> {
  const row = await loadCall(parentCallSid);
  if (!row) return true;
  const transfer = readTransfer(row.twilio_data);
  if (!isTransferActive(transfer)) return true;
  if (transferId && transfer.id !== transferId) return true;

  if (!isLive(row)) {
    return cancelAgentTransfer(parentCallSid, transfer.id, 'call_ended');
  }

  const now = Date.now();
  if (transfer.state === 'ringing') {
    if (now - Date.parse(transfer.started_at) >= TRANSFER_RING_TIMEOUT_MS) {
      return cancelAgentTransfer(parentCallSid, transfer.id, 'no_answer');
    }
    return false;
  }

  // joining: si el compañero ya está en la sala pero el participant-join no
  // ha llegado (o se perdió), completar desde aquí.
  if (transfer.to_agent_call_sid) {
    try {
      const participants = await getTwilioClient()
        .conferences(transfer.conference_sid)
        .participants.list();
      if (participants.some((p) => p.callSid === transfer.to_agent_call_sid)) {
        if (await finalizeTransfer(row, transfer)) return true;
      }
    } catch {
      // Sala no inspeccionable ahora: reintentar en el siguiente tick.
    }
  }

  const joiningAt = Date.parse(transfer.joining_at ?? transfer.started_at);
  if (now - joiningAt >= TRANSFER_JOIN_GRACE_MS) {
    return cancelAgentTransfer(parentCallSid, transfer.id, 'join_timeout');
  }
  return false;
}

function watchTransfer(parentCallSid: string, transferId: string): void {
  const state = getWatchState();
  stopWatching(parentCallSid);

  // Tope de seguridad del propio timer; lo que quede lo recoge el barrido.
  const deadline = Date.now() + TRANSFER_RING_TIMEOUT_MS + TRANSFER_JOIN_GRACE_MS + 60_000;
  const timer = setInterval(() => {
    if (Date.now() > deadline) {
      stopWatching(parentCallSid);
      return;
    }
    if (state.checking.has(parentCallSid)) return;
    state.checking.add(parentCallSid);
    void checkTransfer(parentCallSid, transferId)
      .then((done) => {
        if (done) stopWatching(parentCallSid);
      })
      .catch((err) => {
        console.error(`[TRANSFER] Vigilancia de ${parentCallSid} falló:`, err);
      })
      .finally(() => {
        state.checking.delete(parentCallSid);
      });
  }, WATCH_INTERVAL_MS);
  timer.unref?.();
  state.timers.set(parentCallSid, timer);
}

function stopWatching(parentCallSid: string): void {
  const state = getWatchState();
  const timer = state.timers.get(parentCallSid);
  if (timer) {
    clearInterval(timer);
    state.timers.delete(parentCallSid);
  }
}

/**
 * Red de seguridad ante un reinicio del proceso a mitad de transferencia
 * (los timers viven en memoria): sin esto, un cliente podría quedarse en
 * espera sin nadie que lo devuelva. Se llama con debounce desde el sondeo de
 * /agent/me/state (el disparador fiable: los Tauri abiertos lo piden cada
 * ≤45 s), desde los eventos de sala de voice/status y desde /calls/reconcile.
 */
export async function sweepStaleTransfers(options?: { force?: boolean }): Promise<number> {
  const state = getWatchState();
  const now = Date.now();
  if (!options?.force && now - state.lastSweepAt < SWEEP_MIN_INTERVAL_MS) return 0;
  state.lastSweepAt = now;

  const { data } = await createAdminClient()
    .from('call_records')
    .select('twilio_call_sid')
    .filter('twilio_data->transfer->>state', 'in', '(ringing,joining)')
    .gte('started_at', new Date(now - 24 * 60 * 60 * 1000).toISOString())
    .limit(SWEEP_BATCH_LIMIT);

  let checked = 0;
  for (const item of (data ?? []) as Array<{ twilio_call_sid: string | null }>) {
    const sid = item.twilio_call_sid;
    if (!sid || state.timers.has(sid) || state.checking.has(sid)) continue;
    checked += 1;
    state.checking.add(sid);
    try {
      const done = await checkTransfer(sid, null);
      if (!done) {
        const row = await loadCall(sid);
        const transfer = readTransfer(row?.twilio_data);
        if (isTransferActive(transfer)) watchTransfer(sid, transfer.id);
      }
    } catch (err) {
      console.error(`[TRANSFER] sweep ${sid} falló:`, err);
    } finally {
      state.checking.delete(sid);
    }
  }
  if (checked > 0) console.log(`[TRANSFER] sweep: ${checked} transferencia(s) re-examinadas.`);
  return checked;
}
