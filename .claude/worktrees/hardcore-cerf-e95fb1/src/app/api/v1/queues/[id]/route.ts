import { NextRequest } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { authenticate, isAuthenticated } from '@/lib/api/auth';
import { apiSuccess, apiNotFound, apiBadRequest, apiInternalError, apiNoContent } from '@/lib/api/response';
import { updateQueueSchema } from '@/lib/api/validation';
import { auditLog } from '@/lib/api/audit';

interface Params {
  params: Promise<{ id: string }>;
}

// GET /api/v1/queues/:id — Detalle de cola con usuarios asignados
export async function GET(req: NextRequest, { params }: Params) {
  const auth = await authenticate(req);
  if (!isAuthenticated(auth)) return auth;

  const { id } = await params;
  const supabase = createAdminClient();

  const { data: queue, error } = await supabase
    .from('queues')
    .select('*')
    .eq('id', id)
    .single();

  if (error || !queue) return apiNotFound('Cola');

  // Obtener usuarios de la cola con datos del usuario
  const { data: queueUsers } = await supabase
    .from('queue_users')
    .select('id, priority, user_id, created_at')
    .eq('queue_id', id)
    .order('priority');

  // Obtener datos de cada usuario
  const userIds = (queueUsers || []).map((qu) => qu.user_id);
  let users: Record<string, unknown>[] = [];

  if (userIds.length > 0) {
    const { data: usersData } = await supabase
      .from('users')
      .select('id, name, email, phone, available, active')
      .in('id', userIds)
      .is('deleted_at', null);

    users = usersData || [];
  }

  // Combinar datos
  const usersMap = new Map(users.map((u) => [(u as { id: string }).id, u]));
  const queueUsersWithDetails = (queueUsers || []).map((qu) => ({
    ...qu,
    user: usersMap.get(qu.user_id) || null,
  }));

  return apiSuccess({
    ...queue,
    users: queueUsersWithDetails,
  });
}

// PUT /api/v1/queues/:id
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

  const parsed = updateQueueSchema.safeParse(body);
  if (!parsed.success) {
    return apiBadRequest('Datos inválidos', parsed.error.flatten().fieldErrors);
  }

  const supabase = createAdminClient();

  const { data, error } = await supabase
    .from('queues')
    .update(parsed.data)
    .eq('id', id)
    .select()
    .single();

  if (error || !data) return apiNotFound('Cola');

  await auditLog('queue.updated', 'queue', id, auth.userId, parsed.data);

  return apiSuccess(data);
}

// DELETE /api/v1/queues/:id
export async function DELETE(req: NextRequest, { params }: Params) {
  const auth = await authenticate(req);
  if (!isAuthenticated(auth)) return auth;

  const { id } = await params;
  const supabase = createAdminClient();

  const { error } = await supabase.from('queues').delete().eq('id', id);

  if (error) {
    console.error('Error deleting queue:', error);
    return apiInternalError();
  }

  await auditLog('queue.deleted', 'queue', id, auth.userId);

  return apiNoContent();
}
