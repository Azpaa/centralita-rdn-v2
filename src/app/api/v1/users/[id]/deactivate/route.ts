import { NextRequest } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { authenticate, isAuthenticated } from '@/lib/api/auth';
import { apiSuccess, apiNotFound } from '@/lib/api/response';
import { auditLog } from '@/lib/api/audit';

interface Params {
  params: Promise<{ id: string }>;
}

// PATCH /api/v1/users/:id/deactivate
export async function PATCH(req: NextRequest, { params }: Params) {
  const auth = await authenticate(req);
  if (!isAuthenticated(auth)) return auth;

  const { id } = await params;
  const supabase = createAdminClient();

  const { data, error } = await supabase
    .from('users')
    .update({ active: false, available: false })
    .eq('id', id)
    .is('deleted_at', null)
    .select()
    .single();

  if (error || !data) return apiNotFound('Usuario');

  await auditLog('user.deactivated', 'user', id, auth.userId);

  return apiSuccess(data);
}
