import { NextRequest } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { authenticate, isAuthenticated } from '@/lib/api/auth';
import { apiSuccess, apiCreated, apiBadRequest, apiConflict, apiInternalError, parsePagination, buildMeta } from '@/lib/api/response';
import { createUserSchema } from '@/lib/api/validation';
import { auditLog } from '@/lib/api/audit';
import { escapeIlike } from '@/lib/api/sanitize';
import type { User } from '@/lib/types/database';

// GET /api/v1/users — Listar usuarios
export async function GET(req: NextRequest) {
  const auth = await authenticate(req);
  if (!isAuthenticated(auth)) return auth;

  const supabase = createAdminClient();
  const { searchParams } = new URL(req.url);
  const { page, limit, skip } = parsePagination(searchParams);

  // Filtros
  let query = supabase
    .from('users')
    .select('*', { count: 'exact' })
    .is('deleted_at', null)
    .order('created_at', { ascending: false });

  const active = searchParams.get('active');
  if (active !== null) query = query.eq('active', active === 'true');

  const available = searchParams.get('available');
  if (available !== null) query = query.eq('available', available === 'true');

  const linked = searchParams.get('rdn_linked');
  if (linked !== null) query = query.eq('rdn_linked', linked === 'true');

  const search = searchParams.get('search');
  if (search) {
    const safe = escapeIlike(search);
    query = query.or(`name.ilike.%${safe}%,email.ilike.%${safe}%`);
  }

  query = query.range(skip, skip + limit - 1);

  const { data, error, count } = await query;

  if (error) {
    console.error('Error listing users:', error);
    return apiInternalError();
  }

  return apiSuccess(data, buildMeta(page, limit, count || 0));
}

// POST /api/v1/users — Crear usuario
export async function POST(req: NextRequest) {
  const auth = await authenticate(req);
  if (!isAuthenticated(auth)) return auth;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return apiBadRequest('Body JSON inválido');
  }

  const parsed = createUserSchema.safeParse(body);
  if (!parsed.success) {
    return apiBadRequest('Datos de validación inválidos', parsed.error.flatten().fieldErrors);
  }

  const supabase = createAdminClient();
  const input = parsed.data;

  // Comprobar email duplicado
  const { data: existing } = await supabase
    .from('users')
    .select('id')
    .eq('email', input.email)
    .is('deleted_at', null)
    .single();

  if (existing) {
    return apiConflict('Ya existe un usuario con ese email');
  }

  const { data, error } = await supabase
    .from('users')
    .insert({
      name: input.name,
      email: input.email,
      phone: input.phone || null,
      role: input.role,
      rdn_user_id: input.rdn_user_id || null,
      rdn_linked: !!input.rdn_user_id,
      available: false,
      active: true,
    })
    .select()
    .single<User>();

  if (error) {
    console.error('Error creating user:', error);
    return apiInternalError();
  }

  await auditLog('user.created', 'user', data.id, auth.userId, { email: input.email });

  return apiCreated(data);
}
