import { NextRequest } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { authenticate, isAuthenticated } from '@/lib/api/auth';
import { apiSuccess, apiCreated, apiBadRequest, apiConflict, apiInternalError, parsePagination, buildMeta } from '@/lib/api/response';
import { createScheduleSchema } from '@/lib/api/validation';
import { auditLog } from '@/lib/api/audit';
import type { Schedule } from '@/lib/types/database';

// GET /api/v1/schedules
export async function GET(req: NextRequest) {
  const auth = await authenticate(req);
  if (!isAuthenticated(auth)) return auth;

  const supabase = createAdminClient();
  const { searchParams } = new URL(req.url);
  const { page, limit, skip } = parsePagination(searchParams);

  const { data, error, count } = await supabase
    .from('schedules')
    .select('*', { count: 'exact' })
    .order('name')
    .range(skip, skip + limit - 1);

  if (error) {
    console.error('Error listing schedules:', error);
    return apiInternalError();
  }

  return apiSuccess(data, buildMeta(page, limit, count || 0));
}

// POST /api/v1/schedules
export async function POST(req: NextRequest) {
  const auth = await authenticate(req);
  if (!isAuthenticated(auth)) return auth;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return apiBadRequest('Body JSON inválido');
  }

  const parsed = createScheduleSchema.safeParse(body);
  if (!parsed.success) {
    return apiBadRequest('Datos inválidos', parsed.error.flatten().fieldErrors);
  }

  const supabase = createAdminClient();

  // Comprobar nombre duplicado
  const { data: existing } = await supabase
    .from('schedules')
    .select('id')
    .eq('name', parsed.data.name)
    .single();

  if (existing) {
    return apiConflict('Ya existe un horario con ese nombre');
  }

  // Crear horario
  const { data: schedule, error } = await supabase
    .from('schedules')
    .insert({
      name: parsed.data.name,
      timezone: parsed.data.timezone,
    })
    .select()
    .single<Schedule>();

  if (error || !schedule) {
    console.error('Error creating schedule:', error);
    return apiInternalError();
  }

  // Crear slots si los hay
  if (parsed.data.slots && parsed.data.slots.length > 0) {
    const slots = parsed.data.slots.map((s) => ({
      schedule_id: schedule.id,
      day_of_week: s.day_of_week,
      start_time: s.start_time,
      end_time: s.end_time,
    }));

    const { error: slotsError } = await supabase.from('schedule_slots').insert(slots);

    if (slotsError) {
      console.error('Error creating schedule slots:', slotsError);
      // No fallar — el horario ya se creó
    }
  }

  await auditLog('schedule.created', 'schedule', schedule.id, auth.userId, {
    name: parsed.data.name,
  });

  return apiCreated(schedule);
}
