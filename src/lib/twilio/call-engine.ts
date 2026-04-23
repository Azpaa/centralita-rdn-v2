/**
 * Motor de llamadas — lógica central de enrutamiento.
 * Funciones puras que consultan la DB y devuelven decisiones de routing.
 */

import { createAdminClient } from '@/lib/supabase/admin';
import { hasActiveDesktopStreamForUser } from '@/lib/events/client-stream';
import { getTwilioClient } from '@/lib/twilio/client';
import type { PhoneNumber, Schedule, ScheduleSlot, Queue, User, QueueUser, CallStatus, CallDirection } from '@/lib/types/database';

// --- Tipos de resultado ---

export interface RouteDecision {
  type: 'in_hours' | 'out_of_hours' | 'no_schedule' | 'inactive';
  phoneNumber: PhoneNumber;
  schedule?: Schedule & { slots: ScheduleSlot[] };
  queue?: Queue;
  operators?: (User & { priority: number })[];
}

// --- Buscar número por número de teléfono ---

export async function findPhoneNumber(phoneNumber: string): Promise<PhoneNumber | null> {
  const supabase = createAdminClient();

  // Twilio envía en formato E.164 (+34612345678)
  const { data } = await supabase
    .from('phone_numbers')
    .select('*')
    .eq('phone_number', phoneNumber)
    .single();

  return data as PhoneNumber | null;
}

// --- Comprobar si estamos dentro del horario ---

export function isWithinSchedule(
  schedule: Schedule,
  slots: ScheduleSlot[],
  now?: Date
): boolean {
  const currentDate = now ?? new Date();

  // Convertir a la zona horaria del horario
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: schedule.timezone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });

  const parts = formatter.formatToParts(currentDate);
  const dayName = parts.find(p => p.type === 'weekday')?.value;
  const hour = parts.find(p => p.type === 'hour')?.value;
  const minute = parts.find(p => p.type === 'minute')?.value;

  if (!dayName || !hour || !minute) return false;

  // Convertir día de la semana a número (0=Domingo)
  const dayMap: Record<string, number> = {
    Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
  };
  const dayOfWeek = dayMap[dayName] ?? -1;
  const currentTime = `${hour}:${minute}`;

  // Buscar si algún slot coincide.
  // Normalizar start/end a HH:MM (la DB puede tener HH:MM:SS).
  return slots.some(slot => {
    if (slot.day_of_week !== dayOfWeek) return false;
    const start = slot.start_time.slice(0, 5); // "00:01:00" → "00:01"
    const end = slot.end_time.slice(0, 5);     // "23:59:00" → "23:59"
    return currentTime >= start && currentTime < end;
  });
}

// --- Obtener horario completo con slots ---

export async function getScheduleWithSlots(scheduleId: string): Promise<(Schedule & { slots: ScheduleSlot[] }) | null> {
  const supabase = createAdminClient();

  const { data: schedule } = await supabase
    .from('schedules')
    .select('*')
    .eq('id', scheduleId)
    .single();

  if (!schedule) return null;

  const { data: slots } = await supabase
    .from('schedule_slots')
    .select('*')
    .eq('schedule_id', scheduleId)
    .order('day_of_week')
    .order('start_time');

  return {
    ...(schedule as Schedule),
    slots: (slots as ScheduleSlot[]) || [],
  };
}

// --- Obtener IDs de agentes que están en llamada activa ---

async function getBusyAgentIds(excludeCallSid?: string): Promise<Set<string>> {
  const supabase = createAdminClient();
  const twilioClient = getTwilioClient();
  const nowMs = Date.now();
  const staleVerificationAgeMs = 90 * 1000;
  const terminalTwilioStatuses = new Set(['completed', 'busy', 'no-answer', 'failed', 'canceled']);
  const mapTerminalStatus = (status: string): CallStatus => {
    if (status === 'no-answer') return 'no_answer';
    return (status as CallStatus);
  };

  // Solo considerar llamadas en progreso real (ya contestadas)
  // Las llamadas ringing/in_queue sin answered_by_user_id son llamadas esperando,
  // no bloquean a ningún agente.
  // Añadir filtro temporal: ignorar registros de más de 4 horas (posibles fantasmas)
  const fourHoursAgo = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();

  let query = supabase
    .from('call_records')
    .select('answered_by_user_id, twilio_data, twilio_call_sid, started_at')
    .in('status', ['in_progress'] as CallStatus[])
    .not('answered_by_user_id', 'is', null)
    .is('ended_at', null)
    .gte('started_at', fourHoursAgo);

  if (excludeCallSid) {
    query = query.neq('twilio_call_sid', excludeCallSid);
  }

  const { data: activeCalls } = await query;

  const busyIds = new Set<string>();
  if (!activeCalls) return busyIds;

  for (const call of activeCalls as Array<{
    answered_by_user_id: string | null;
    twilio_data: Record<string, unknown> | null;
    twilio_call_sid: string | null;
    started_at: string;
  }>) {
    const transferReleased = Boolean(
      call.twilio_data
      && typeof call.twilio_data === 'object'
      && (
        call.twilio_data.transfer_agent_released === true
        || typeof call.twilio_data.transfer_agent_released_at === 'string'
      )
    );
    if (transferReleased) {
      continue;
    }

    const callSid = call.twilio_call_sid;
    const startedAtMs = Date.parse(call.started_at);
    const shouldVerifyWithTwilio = Boolean(
      callSid
      && !callSid.startsWith('pending-')
      && Number.isFinite(startedAtMs)
      && (nowMs - startedAtMs) >= staleVerificationAgeMs
    );

    if (shouldVerifyWithTwilio && callSid) {
      try {
        const liveCall = await twilioClient.calls(callSid).fetch();
        const liveStatus = (liveCall.status || '').toLowerCase();

        if (terminalTwilioStatuses.has(liveStatus)) {
          const endedAt = liveCall.endTime
            ? new Date(liveCall.endTime).toISOString()
            : new Date().toISOString();
          const parsedDuration = parseInt(String(liveCall.duration ?? '0'), 10);
          const safeDuration = Number.isFinite(parsedDuration) ? parsedDuration : 0;

          const { error: reconcileErr } = await supabase
            .from('call_records')
            .update({
              status: mapTerminalStatus(liveStatus),
              ended_at: endedAt,
              duration: safeDuration,
            })
            .eq('twilio_call_sid', callSid)
            .eq('status', 'in_progress')
            .is('ended_at', null);

          if (reconcileErr) {
            console.warn(`[CALL-ENGINE] Failed reconciling stale busy call ${callSid}:`, reconcileErr.message);
          } else {
            console.log(`[CALL-ENGINE] Reconciled stale busy call ${callSid} -> ${liveStatus}`);
          }
          continue;
        }
      } catch (verifyErr) {
        const errorCode = (verifyErr as { code?: number; status?: number })?.code;
        const errorStatus = (verifyErr as { code?: number; status?: number })?.status;
        const isNotFound = errorCode === 20404 || errorStatus === 404;

        if (isNotFound) {
          const endedAt = new Date().toISOString();
          const { error: reconcileErr } = await supabase
            .from('call_records')
            .update({
              status: 'canceled',
              ended_at: endedAt,
            })
            .eq('twilio_call_sid', callSid)
            .eq('status', 'in_progress')
            .is('ended_at', null);

          if (reconcileErr) {
            console.warn(`[CALL-ENGINE] Failed reconciling missing busy call ${callSid}:`, reconcileErr.message);
          } else {
            console.log(`[CALL-ENGINE] Reconciled missing busy call ${callSid} -> canceled`);
          }
          continue;
        }

        console.warn(
          `[CALL-ENGINE] Unable to verify busy call ${callSid} in Twilio: ${
            verifyErr instanceof Error ? verifyErr.message : 'unknown_error'
          }`
        );
      }
    }

    if (call.answered_by_user_id) {
      busyIds.add(call.answered_by_user_id);
    }
    // También comprobar resolved_agent_id en twilio_data
    if (call.twilio_data && typeof call.twilio_data === 'object') {
      const resolvedId = call.twilio_data.resolved_agent_id;
      if (typeof resolvedId === 'string' && resolvedId.length > 0) {
        busyIds.add(resolvedId);
      }
    }
  }

  return busyIds;
}

// --- Obtener cola con operadores disponibles ---

export async function getQueueWithOperators(queueId: string): Promise<{
  queue: Queue;
  operators: (User & { priority: number })[];
} | null> {
  const supabase = createAdminClient();

  const { data: queue } = await supabase
    .from('queues')
    .select('*')
    .eq('id', queueId)
    .single();

  if (!queue) return null;

  // Obtener usuarios asignados a la cola con su prioridad
  const { data: queueUsers } = await supabase
    .from('queue_users')
    .select('user_id, priority')
    .eq('queue_id', queueId)
    .order('priority', { ascending: true });

  if (!queueUsers || queueUsers.length === 0) {
    return { queue: queue as Queue, operators: [] };
  }

  // Obtener datos de los usuarios que están activos y disponibles
  const userIds = (queueUsers as QueueUser[]).map(qu => qu.user_id);
  const { data: users } = await supabase
    .from('users')
    .select('*')
    .in('id', userIds)
    .eq('active', true)
    .is('deleted_at', null);

  if (!users) {
    return { queue: queue as Queue, operators: [] };
  }

  // Combinar con prioridad (ya no filtramos solo los que tienen teléfono,
  // porque también pueden recibir llamadas en el navegador vía Twilio Client)
  // Excluir agentes que ya están en una llamada activa
  const busyAgentIds = await getBusyAgentIds();
  const priorityMap = new Map((queueUsers as QueueUser[]).map(qu => [qu.user_id, qu.priority]));
  const operators = (users as User[])
    .filter((u) => {
      if (busyAgentIds.has(u.id)) return false;
      if (u.available) return true;
      return hasActiveDesktopStreamForUser(u.id);
    })
    .map(u => ({
      ...u,
      priority: priorityMap.get(u.id) ?? 0,
    }))
    .sort((a, b) => a.priority - b.priority);

  return { queue: queue as Queue, operators };
}

// --- Decisión de enrutamiento completa ---

export async function routeIncomingCall(toNumber: string): Promise<RouteDecision | null> {
  // 1. Buscar el número
  const phoneNumber = await findPhoneNumber(toNumber);
  if (!phoneNumber) return null;

  // 2. Si el número está inactivo
  if (!phoneNumber.active) {
    return { type: 'inactive', phoneNumber };
  }

  // 3. Comprobar horario (si tiene uno asignado)
  if (phoneNumber.schedule_id) {
    const schedule = await getScheduleWithSlots(phoneNumber.schedule_id);
    if (schedule) {
      const inHours = isWithinSchedule(schedule, schedule.slots);

      if (!inHours) {
        return { type: 'out_of_hours', phoneNumber, schedule };
      }

      // Dentro de horario: obtener cola si existe
      if (phoneNumber.queue_id) {
        const queueData = await getQueueWithOperators(phoneNumber.queue_id);
        return {
          type: 'in_hours',
          phoneNumber,
          schedule,
          queue: queueData?.queue,
          operators: queueData?.operators || [],
        };
      }

      return { type: 'in_hours', phoneNumber, schedule };
    }
  }

  // 4. Sin horario: tratar como si siempre estuviera disponible
  if (phoneNumber.queue_id) {
    const queueData = await getQueueWithOperators(phoneNumber.queue_id);
    return {
      type: 'no_schedule',
      phoneNumber,
      queue: queueData?.queue,
      operators: queueData?.operators || [],
    };
  }

  return { type: 'no_schedule', phoneNumber };
}

// --- Crear registro de llamada ---

export async function createCallRecord(params: {
  twilioCallSid: string;
  direction: 'inbound' | 'outbound';
  fromNumber: string;
  toNumber: string;
  status: string;
  queueId?: string | null;
  phoneNumberId?: string | null;
  answeredByUserId?: string | null;
  twilioData?: Record<string, unknown>;
}): Promise<string | null> {
  const supabase = createAdminClient();

  const { data, error } = await supabase
    .from('call_records')
    .insert({
      twilio_call_sid: params.twilioCallSid,
      direction: params.direction as CallDirection,
      from_number: params.fromNumber,
      to_number: params.toNumber,
      status: params.status as CallStatus,
      started_at: new Date().toISOString(),
      queue_id: params.queueId ?? null,
      phone_number_id: params.phoneNumberId ?? null,
      answered_by_user_id: params.answeredByUserId ?? null,
      twilio_data: params.twilioData ?? null,
    })
    .select('id')
    .single();

  if (error) {
    // 23505 = unique_violation. Two constraints can fire here:
    //   1. `twilio_call_sid` UNIQUE → Twilio webhook retry or duplicate SID.
    //      (Real SID winners are always returned — they own the media path.)
    //   2. `idx_call_records_pending_agent_unique` (partial, migration 007)
    //      → concurrent dial racing for the same agent.
    //
    // For the pending_agent case: returning the existing id silently is only
    // correct if it's a genuine double-submit of the SAME attempt. If the
    // existing row is stale (>30s old) or still carries a `pending-` SID
    // placeholder (device.connect never resolved), we force-close it so the
    // new dial can proceed. Otherwise the operator gets trapped — the UI
    // shows "accepting" tied to a dead row forever.
    if ((error as { code?: string }).code === '23505') {
      const { data: existingBySid } = await supabase
        .from('call_records')
        .select('id')
        .eq('twilio_call_sid', params.twilioCallSid)
        .maybeSingle();
      if (existingBySid) {
        return (existingBySid as { id: string }).id;
      }

      if (params.status === 'pending_agent' && params.answeredByUserId) {
        const { data: existingByAgent } = await supabase
          .from('call_records')
          .select('id, started_at, twilio_call_sid')
          .eq('answered_by_user_id', params.answeredByUserId)
          .eq('status', 'pending_agent')
          .is('ended_at', null)
          .maybeSingle();

        if (existingByAgent) {
          const existing = existingByAgent as {
            id: string;
            started_at: string | null;
            twilio_call_sid: string | null;
          };
          const startedAtMs = existing.started_at
            ? Date.parse(existing.started_at)
            : 0;
          const ageMs = Number.isFinite(startedAtMs)
            ? Date.now() - startedAtMs
            : Number.POSITIVE_INFINITY;
          const hasRealSid = Boolean(
            existing.twilio_call_sid
            && !existing.twilio_call_sid.startsWith('pending-')
          );

          // Genuine fresh double-submit: same attempt, return its id.
          if (ageMs < 30_000 && hasRealSid) {
            return existing.id;
          }

          // Stale or unresolved placeholder: force-close and retry insert.
          console.warn(
            `[CREATE_CALL_RECORD] Force-closing stale pending_agent ${existing.id}`
            + ` age_ms=${ageMs} sid=${existing.twilio_call_sid ?? 'null'}`
          );
          await supabase
            .from('call_records')
            .update({
              status: 'canceled' as CallStatus,
              ended_at: new Date().toISOString(),
              twilio_data: {
                ...(params.twilioData ?? {}),
                force_closed_reason: 'stale_pending_agent_before_new_dial',
                force_closed_at: new Date().toISOString(),
                force_closed_age_ms: Number.isFinite(ageMs) ? ageMs : null,
              },
            })
            .eq('id', existing.id)
            .is('ended_at', null);

          const retry = await supabase
            .from('call_records')
            .insert({
              twilio_call_sid: params.twilioCallSid,
              direction: params.direction as CallDirection,
              from_number: params.fromNumber,
              to_number: params.toNumber,
              status: params.status as CallStatus,
              started_at: new Date().toISOString(),
              queue_id: params.queueId ?? null,
              phone_number_id: params.phoneNumberId ?? null,
              answered_by_user_id: params.answeredByUserId ?? null,
              twilio_data: params.twilioData ?? null,
            })
            .select('id')
            .single();

          if (retry.error) {
            console.error(
              '[CREATE_CALL_RECORD] Retry after force-close failed:',
              retry.error
            );
            return null;
          }
          return (retry.data as { id: string })?.id ?? null;
        }
      }
    }
    console.error('Error creating call record:', error);
    return null;
  }

  return (data as { id: string })?.id ?? null;
}

// --- Actualizar estado de llamada ---

const TERMINAL_CALL_STATUSES: CallStatus[] = ['completed', 'busy', 'no_answer', 'failed', 'canceled'];

export async function updateCallStatus(
  twilioCallSid: string,
  updates: {
    status?: string;
    answeredAt?: string;
    endedAt?: string;
    duration?: number;
    waitTime?: number;
    answeredByUserId?: string;
  }
): Promise<void> {
  const supabase = createAdminClient();

  const updateData: Record<string, unknown> = {};
  if (updates.status) updateData.status = updates.status as CallStatus;
  if (updates.answeredAt) updateData.answered_at = updates.answeredAt;
  if (updates.endedAt) updateData.ended_at = updates.endedAt;
  if (updates.duration !== undefined) updateData.duration = updates.duration;
  if (updates.waitTime !== undefined) updateData.wait_time = updates.waitTime;
  if (updates.answeredByUserId) updateData.answered_by_user_id = updates.answeredByUserId;

  // When the call reaches a terminal state we also wipe
  // `current_ring_target_user_ids` in twilio_data. Without this, any user
  // that happened to be in the ring pool at the moment of termination stays
  // pinned to the call in `resolveAgentRuntimeSnapshot` (targeted-pending
  // query), which is the exact "todos los usuarios se quedan bloqueados"
  // symptom observed in production. agent-connect already clears it on
  // answer; this covers the miss/no-answer/cancelled paths.
  const isTerminalUpdate = Boolean(
    updates.status && TERMINAL_CALL_STATUSES.includes(updates.status as CallStatus),
  );

  if (isTerminalUpdate) {
    const { data: existing } = await supabase
      .from('call_records')
      .select('twilio_data')
      .eq('twilio_call_sid', twilioCallSid)
      .maybeSingle();

    const existingTwilioData = (
      existing?.twilio_data
      && typeof existing.twilio_data === 'object'
      && !Array.isArray(existing.twilio_data)
    )
      ? (existing.twilio_data as Record<string, unknown>)
      : null;

    if (existingTwilioData) {
      const currentRingTargets = Array.isArray(existingTwilioData.current_ring_target_user_ids)
        ? (existingTwilioData.current_ring_target_user_ids as unknown[])
        : null;

      if (currentRingTargets && currentRingTargets.length > 0) {
        updateData.twilio_data = {
          ...existingTwilioData,
          current_ring_target_user_ids: [],
          current_round_robin_attempt_id: null,
          ring_cleared_at: new Date().toISOString(),
          ring_cleared_reason: `terminal_status_${updates.status}`,
        };
      }
    }
  }

  const { error } = await supabase
    .from('call_records')
    .update(updateData)
    .eq('twilio_call_sid', twilioCallSid);

  if (error) {
    console.error('Error updating call status:', error);
  }
}
