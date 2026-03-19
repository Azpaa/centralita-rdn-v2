import { NextRequest } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { authenticate, isAuthenticated } from '@/lib/api/auth';
import { apiSuccess, apiBadRequest, apiNotFound } from '@/lib/api/response';
import { matchEmailSchema } from '@/lib/api/validation';

// POST /api/v1/users/match-email — Buscar usuario por email para vincular con RDN
export async function POST(req: NextRequest) {
  const auth = await authenticate(req);
  if (!isAuthenticated(auth)) return auth;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return apiBadRequest('Body JSON inválido');
  }

  const parsed = matchEmailSchema.safeParse(body);
  if (!parsed.success) {
    return apiBadRequest('Datos inválidos', parsed.error.flatten().fieldErrors);
  }

  const supabase = createAdminClient();

  const { data, error } = await supabase
    .from('users')
    .select('id, name, email, rdn_user_id, rdn_linked')
    .eq('email', parsed.data.email)
    .is('deleted_at', null)
    .single();

  if (error || !data) return apiNotFound('Usuario con ese email');

  return apiSuccess(data);
}
