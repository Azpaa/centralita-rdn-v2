import { NextRequest } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { authenticate, isAuthenticated, requireRole } from '@/lib/api/auth';
import { apiSuccess, apiNotFound, apiBadRequest } from '@/lib/api/response';
import { linkRdnSchema } from '@/lib/api/validation';
import { auditLog } from '@/lib/api/audit';

interface Params {
  params: Promise<{ id: string }>;
}

// POST /api/v1/users/:id/link-rdn
export async function POST(req: NextRequest, { params }: Params) {
  const auth = await authenticate(req);
  if (!isAuthenticated(auth)) return auth;
  const roleCheck = requireRole(auth, 'admin');
  if (roleCheck !== true) return roleCheck;

  const { id } = await params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return apiBadRequest('Body JSON invÃ¡lido');
  }

  const parsed = linkRdnSchema.safeParse(body);
  if (!parsed.success) {
    return apiBadRequest('Datos invÃ¡lidos', parsed.error.flatten().fieldErrors);
  }

  const supabase = createAdminClient();

  const { data, error } = await supabase
    .from('users')
    .update({
      rdn_user_id: parsed.data.rdn_user_id,
      rdn_linked: true,
    })
    .eq('id', id)
    .is('deleted_at', null)
    .select()
    .single();

  if (error || !data) return apiNotFound('Usuario');

  await auditLog('user.linked_rdn', 'user', id, auth.userId, {
    rdn_user_id: parsed.data.rdn_user_id,
  });

  return apiSuccess(data);
}

