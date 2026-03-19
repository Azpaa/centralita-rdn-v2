import { NextRequest } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { authenticate, isAuthenticated } from '@/lib/api/auth';
import { apiSuccess, apiNotFound, apiBadRequest, apiInternalError, apiNoContent } from '@/lib/api/response';
import { updateUserSchema } from '@/lib/api/validation';
import { auditLog } from '@/lib/api/audit';

interface Params {
  params: Promise<{ id: string }>;
}

// GET /api/v1/users/:id
export async function GET(req: NextRequest, { params }: Params) {
  const auth = await authenticate(req);
  if (!isAuthenticated(auth)) return auth;

  const { id } = await params;
  const supabase = createAdminClient();

  const { data, error } = await supabase
    .from('users')
    .select('*')
    .eq('id', id)
    .is('deleted_at', null)
    .single();

  if (error || !data) return apiNotFound('Usuario');

  return apiSuccess(data);
}

// PUT /api/v1/users/:id
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

  const parsed = updateUserSchema.safeParse(body);
  if (!parsed.success) {
    return apiBadRequest('Datos inválidos', parsed.error.flatten().fieldErrors);
  }

  const supabase = createAdminClient();

  const { data, error } = await supabase
    .from('users')
    .update(parsed.data)
    .eq('id', id)
    .is('deleted_at', null)
    .select()
    .single();

  if (error || !data) return apiNotFound('Usuario');

  await auditLog('user.updated', 'user', id, auth.userId, parsed.data);

  return apiSuccess(data);
}

// DELETE /api/v1/users/:id (soft delete)
export async function DELETE(req: NextRequest, { params }: Params) {
  const auth = await authenticate(req);
  if (!isAuthenticated(auth)) return auth;

  const { id } = await params;
  const supabase = createAdminClient();

  const { error } = await supabase
    .from('users')
    .update({
      deleted_at: new Date().toISOString(),
      active: false,
      available: false,
    })
    .eq('id', id)
    .is('deleted_at', null);

  if (error) {
    console.error('Error deleting user:', error);
    return apiInternalError();
  }

  await auditLog('user.deleted', 'user', id, auth.userId);

  return apiNoContent();
}
