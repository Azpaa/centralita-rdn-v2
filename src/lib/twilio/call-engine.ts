/**
 * Motor de llamadas — lógica central de enrutamiento.
 * Funciones puras que consultan la DB y devuelven decisiones de routing.
 */

import { createAdminClient } from '@/lib/supabase/admin';
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
    hour12: false,
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

  // Buscar si algún slot coincide
  return slots.some(slot => {
    if (slot.day_of_week !== dayOfWeek) return false;
    return currentTime >= slot.start_time && currentTime < slot.end_time;
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
    .eq('available', true)
    .is('deleted_at', null);

  if (!users) {
    return { queue: queue as Queue, operators: [] };
  }

  // Combinar con prioridad (ya no filtramos solo los que tienen teléfono,
  // porque también pueden recibir llamadas en el navegador vía Twilio Client)
  const priorityMap = new Map((queueUsers as QueueUser[]).map(qu => [qu.user_id, qu.priority]));
  const operators = (users as User[])
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
  twilioData?: Record<string, string>;
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
      twilio_data: params.twilioData ?? null,
    })
    .select('id')
    .single();

  if (error) {
    console.error('Error creating call record:', error);
    return null;
  }

  return (data as { id: string })?.id ?? null;
}

// --- Actualizar estado de llamada ---

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

  const { error } = await supabase
    .from('call_records')
    .update(updateData)
    .eq('twilio_call_sid', twilioCallSid);

  if (error) {
    console.error('Error updating call status:', error);
  }
}
