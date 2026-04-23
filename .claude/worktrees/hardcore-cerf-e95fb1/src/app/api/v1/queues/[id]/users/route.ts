import { NextRequest } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { authenticate, isAuthenticated } from '@/lib/api/auth';
import { apiCreated, apiBadRequest, apiConflict, apiInternalError } from '@/lib/api/response';
import { assignQueueUserSchema } from '@/lib/api/validation';
import { auditLog } from '@/lib/api/audit';

interface Params {
  params: Promise<{ id: string }>;
}

// POST /api/v1/queues/:id/users — Asignar usuario a cola
export async function POST(req: NextRequest, { params }: Params) {
  const auth = await authenticate(req);
  if (!isAuthenticated(auth)) return auth;

  const { id: queueId } = await params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return apiBadRequest('Body JSON inválido');
  }

  const parsed = assignQueueUserSchema.safeParse(body);
  if (!parsed.success) {
    return apiBadRequest('Datos inválidos', parsed.error.flatten().fieldErrors);
  }

  const supabase = createAdminClient();

  // Verificar que la cola existe
  const { data: queue } = await supabase.from('queues').select('id').eq('id', queueId).single();
  if (!queue) return apiBadRequest('Cola no encontrada');

  // Verificar que el usuario existe
  const { data: user } = await supabase
    .from('users')
    .select('id')
    .eq('id', parsed.data.user_id)
    .is('deleted_at', null)
    .single();
  if (!user) return apiBadRequest('Usuario no encontrado');

  // Insertar
  const { data, error } = await supabase
    .from('queue_users')
    .insert({
      queue_id: queueId,
      user_id: parsed.data.user_id,
      priority: parsed.data.priority,
    })
    .select()
    .single();

  if (error) {
    if (error.code === '23505') {
      return apiConflict('El usuario ya está asignado a esta cola');
    }
    console.error('Error assigning user to queue:', error);
    return apiInternalError();
  }

  await auditLog('queue.user_added', 'queue', queueId, auth.userId, {
    user_id: parsed.data.user_id,
  });

  return apiCreated(data);
}
