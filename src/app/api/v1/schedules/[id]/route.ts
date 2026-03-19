import { NextRequest } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { authenticate, isAuthenticated } from '@/lib/api/auth';
import { apiSuccess, apiNotFound, apiBadRequest, apiInternalError, apiNoContent } from '@/lib/api/response';
import { updateScheduleSchema } from '@/lib/api/validation';
import { auditLog } from '@/lib/api/audit';

interface Params {
  params: Promise<{ id: string }>;
}

// GET /api/v1/schedules/:id — Con slots
export async function GET(req: NextRequest, { params }: Params) {
  const auth = await authenticate(req);
  if (!isAuthenticated(auth)) return auth;

  const { id } = await params;
  const supabase = createAdminClient();

  const { data: schedule, error } = await supabase
    .from('schedules')
    .select('*')
    .eq('id', id)
    .single();

  if (error || !schedule) return apiNotFound('Horario');

  const { data: slots } = await supabase
    .from('schedule_slots')
    .select('*')
    .eq('schedule_id', id)
    .order('day_of_week')
    .order('start_time');

  return apiSuccess({ ...schedule, slots: slots || [] });
}

// PUT /api/v1/schedules/:id — Actualiza horario y reemplaza slots
export async function PUT(req: NextRequest, { params }: Params) {
  const auth = await authenticate(req);
  if (!isAuthenticated(auth)) return auth;

  const { id } = await params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return apiBadRequest('Body JSON inválido');
  }

  const parsed = updateScheduleSchema.safeParse(body);
  if (!parsed.success) {
    return apiBadRequest('Datos inválidos', parsed.error.flatten().fieldErrors);
  }

  const supabase = createAdminClient();

  // Actualizar datos del horario
  const updateData: Record<string, unknown> = {};
  if (parsed.data.name) updateData.name = parsed.data.name;
  if (parsed.data.timezone) updateData.timezone = parsed.data.timezone;

  if (Object.keys(updateData).length > 0) {
    const { error } = await supabase
      .from('schedules')
      .update(updateData)
      .eq('id', id);

    if (error) {
      console.error('Error updating schedule:', error);
      return apiInternalError();
    }
  }

  // Si se envían slots, reemplazar todos
  if (parsed.data.slots !== undefined) {
    // Borrar slots existentes
    await supabase.from('schedule_slots').delete().eq('schedule_id', id);

    // Insertar nuevos
    if (parsed.data.slots.length > 0) {
      const slots = parsed.data.slots.map((s) => ({
        schedule_id: id,
        day_of_week: s.day_of_week,
        start_time: s.start_time,
        end_time: s.end_time,
      }));

      const { error: slotsError } = await supabase.from('schedule_slots').insert(slots);
      if (slotsError) {
        console.error('Error updating schedule slots:', slotsError);
      }
    }
  }

  // Devolver horario actualizado
  const { data: schedule } = await supabase
    .from('schedules')
    .select('*')
    .eq('id', id)
    .single();

  const { data: slots } = await supabase
    .from('schedule_slots')
    .select('*')
    .eq('schedule_id', id)
    .order('day_of_week')
    .order('start_time');

  await auditLog('schedule.updated', 'schedule', id, auth.userId);

  return apiSuccess({ ...schedule, slots: slots || [] });
}

// DELETE /api/v1/schedules/:id
export async function DELETE(req: NextRequest, { params }: Params) {
  const auth = await authenticate(req);
  if (!isAuthenticated(auth)) return auth;

  const { id } = await params;
  const supabase = createAdminClient();

  const { error } = await supabase.from('schedules').delete().eq('id', id);

  if (error) {
    console.error('Error deleting schedule:', error);
    return apiInternalError();
  }

  await auditLog('schedule.deleted', 'schedule', id, auth.userId);

  return apiNoContent();
}
