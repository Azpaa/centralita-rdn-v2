import { NextRequest } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { authenticate, isAuthenticated } from '@/lib/api/auth';
import { apiSuccess, apiNotFound, apiBadRequest } from '@/lib/api/response';
import { availabilitySchema } from '@/lib/api/validation';
import { auditLog } from '@/lib/api/audit';

interface Params {
  params: Promise<{ id: string }>;
}

// PATCH /api/v1/users/:id/availability
export async function PATCH(req: NextRequest, { params }: Params) {
  const auth = await authenticate(req);
  if (!isAuthenticated(auth)) return auth;

  const { id } = await params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return apiBadRequest('Body JSON inválido');
  }

  const parsed = availabilitySchema.safeParse(body);
  if (!parsed.success) {
    return apiBadRequest('Datos inválidos', parsed.error.flatten().fieldErrors);
  }

  const supabase = createAdminClient();

  const { data, error } = await supabase
    .from('users')
    .update({ available: parsed.data.available })
    .eq('id', id)
    .eq('active', true)
    .is('deleted_at', null)
    .select()
    .single();

  if (error || !data) return apiNotFound('Usuario');

  await auditLog('user.availability_changed', 'user', id, auth.userId, {
    available: parsed.data.available,
  });

  return apiSuccess(data);
}
