import { NextRequest } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { authenticate, isAuthenticated } from '@/lib/api/auth';
import { apiSuccess, apiCreated, apiBadRequest, apiConflict, apiInternalError, parsePagination, buildMeta } from '@/lib/api/response';
import { createQueueSchema } from '@/lib/api/validation';
import { auditLog } from '@/lib/api/audit';
import type { Queue } from '@/lib/types/database';

// GET /api/v1/queues
export async function GET(req: NextRequest) {
  const auth = await authenticate(req);
  if (!isAuthenticated(auth)) return auth;

  const supabase = createAdminClient();
  const { searchParams } = new URL(req.url);
  const { page, limit, skip } = parsePagination(searchParams);

  const { data, error, count } = await supabase
    .from('queues')
    .select('*', { count: 'exact' })
    .order('name')
    .range(skip, skip + limit - 1);

  if (error) {
    console.error('Error listing queues:', error);
    return apiInternalError();
  }

  return apiSuccess(data, buildMeta(page, limit, count || 0));
}

// POST /api/v1/queues
export async function POST(req: NextRequest) {
  const auth = await authenticate(req);
  if (!isAuthenticated(auth)) return auth;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return apiBadRequest('Body JSON inválido');
  }

  const parsed = createQueueSchema.safeParse(body);
  if (!parsed.success) {
    return apiBadRequest('Datos inválidos', parsed.error.flatten().fieldErrors);
  }

  const supabase = createAdminClient();

  // Comprobar nombre duplicado
  const { data: existing } = await supabase
    .from('queues')
    .select('id')
    .eq('name', parsed.data.name)
    .single();

  if (existing) {
    return apiConflict('Ya existe una cola con ese nombre');
  }

  const { data, error } = await supabase
    .from('queues')
    .insert(parsed.data)
    .select()
    .single<Queue>();

  if (error) {
    console.error('Error creating queue:', error);
    return apiInternalError();
  }

  await auditLog('queue.created', 'queue', data.id, auth.userId, { name: parsed.data.name });

  return apiCreated(data);
}
