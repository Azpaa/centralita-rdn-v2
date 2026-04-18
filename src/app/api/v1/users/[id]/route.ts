import { NextRequest } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { authenticate, isAuthenticated, requireRole } from '@/lib/api/auth';
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
  const roleCheck = requireRole(auth, 'admin');
  if (roleCheck !== true) return roleCheck;

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
  const roleCheck = requireRole(auth, 'admin');
  if (roleCheck !== true) return roleCheck;

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

// DELETE /api/v1/users/:id (hard delete en users + auth.users)
export async function DELETE(req: NextRequest, { params }: Params) {
  const auth = await authenticate(req);
  if (!isAuthenticated(auth)) return auth;
  const roleCheck = requireRole(auth, 'admin');
  if (roleCheck !== true) return roleCheck;

  const { id } = await params;
  const supabase = createAdminClient();

  const { data: user, error: userError } = await supabase
    .from('users')
    .select('id, auth_id, email')
    .eq('id', id)
    .is('deleted_at', null)
    .maybeSingle();

  if (userError) {
    console.error('Error loading user before delete:', userError);
    return apiInternalError();
  }

  if (!user) return apiNotFound('Usuario');

  // 1) Eliminar cuenta de autenticación (si existe)
  if (user.auth_id) {
    const { error: authDeleteError } = await supabase.auth.admin.deleteUser(user.auth_id);

    // Si en Auth ya no existe, continuamos igualmente para limpiar public.users.
    const statusMaybe = (authDeleteError as { status?: unknown } | null)?.status;
    const isNotFound = typeof statusMaybe === 'number' && statusMaybe === 404;

    if (authDeleteError && !isNotFound) {
      console.error('Error deleting auth user:', authDeleteError);
      return apiInternalError('No se pudo eliminar el usuario en autenticación');
    }
  }

  // 2) Borrado físico en tabla users
  const { error: deleteError } = await supabase
    .from('users')
    .delete()
    .eq('id', id);

  if (deleteError) {
    console.error('Error deleting user row:', deleteError);
    return apiInternalError();
  }

  await auditLog('user.deleted', 'user', id, auth.userId, {
    deleted_email: user.email,
    auth_id: user.auth_id,
    hard_delete: true,
  });

  return apiNoContent();
}
