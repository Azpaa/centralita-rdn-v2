import { NextRequest } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';
import { apiUnauthorized, apiForbidden } from '@/lib/api/response';
import crypto from 'crypto';
import type { UserRole } from '@/lib/types/database';

/**
 * Resultado de la autenticación.
 * - `user`: usuario de la tabla `users` de la centralita (si existe).
 * - `authMethod`: cómo se autenticó ('session' = panel web, 'api_key' = RDN).
 */
export interface AuthResult {
  userId: string | null; // ID en tabla users
  authId: string | null; // ID en auth.users de Supabase
  authMethod: 'session' | 'api_key';
  apiKeyId?: string;
  role?: UserRole;       // Rol del usuario (admin/operator) — null para api_key
}

/**
 * Autentica una request.
 * Intenta primero API Key (para RDN), luego sesión Supabase (para panel web).
 * Devuelve AuthResult si ok, o NextResponse de error si falla.
 */
export async function authenticate(req: NextRequest): Promise<AuthResult | Response> {
  // 1. Comprobar Bearer token (API key o JWT Supabase)
  const authHeader = req.headers.get('authorization');
  if (authHeader?.startsWith('Bearer ')) {
    const bearerToken = authHeader.slice(7).trim();
    if (bearerToken.includes('.')) {
      // JWT de Supabase (desktop/web clientes externos con token propio)
      return authenticateSupabaseJwt(bearerToken);
    }
    // API key M2M tradicional (ck_...)
    return authenticateApiKey(bearerToken);
  }

  // 2. Comprobar sesión Supabase
  return authenticateSession();
}

/**
 * Verifica que el usuario autenticado tiene un rol permitido.
 * Las API keys siempre pasan (se consideran "admin" por ser M2M).
 * Devuelve true si ok, o Response de error si no tiene permiso.
 */
export function requireRole(
  auth: AuthResult,
  ...allowedRoles: UserRole[]
): true | Response {
  // API keys son M2M — siempre autorizadas (equivalen a admin)
  if (auth.authMethod === 'api_key') return true;

  // Sin rol asignado (usuario sin registro en tabla users) → denegar
  if (!auth.role) {
    return apiForbidden('Tu cuenta no tiene un rol asignado en el sistema');
  }

  if (!allowedRoles.includes(auth.role)) {
    return apiForbidden(`Se requiere rol: ${allowedRoles.join(' o ')}`);
  }

  return true;
}

async function authenticateApiKey(apiKey: string): Promise<AuthResult | Response> {
  const hash = crypto.createHash('sha256').update(apiKey).digest('hex');
  const supabase = createAdminClient();

  const { data, error } = await supabase
    .from('api_keys')
    .select('id, active')
    .eq('key_hash', hash)
    .single();

  if (error || !data || !data.active) {
    return apiUnauthorized('API key inválida o desactivada');
  }

  // Actualizar last_used_at (fire and forget)
  supabase
    .from('api_keys')
    .update({ last_used_at: new Date().toISOString() })
    .eq('id', data.id)
    .then(() => {});

  return {
    userId: null,
    authId: null,
    authMethod: 'api_key',
    apiKeyId: data.id,
  };
}

async function authenticateSession(): Promise<AuthResult | Response> {
  const supabase = await createClient();

  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error || !user) {
    return apiUnauthorized('Sesión no válida');
  }

  // Buscar usuario en tabla users por auth_id
  const adminClient = createAdminClient();
  const { data: appUser } = await adminClient
    .from('users')
    .select('id, role')
    .eq('auth_id', user.id)
    .is('deleted_at', null)
    .single();

  return {
    userId: appUser?.id || null,
    authId: user.id,
    authMethod: 'session',
    role: (appUser?.role as UserRole) || undefined,
  };
}

async function authenticateSupabaseJwt(jwt: string): Promise<AuthResult | Response> {
  const adminClient = createAdminClient();
  const {
    data: { user },
    error,
  } = await adminClient.auth.getUser(jwt);

  if (error || !user) {
    return apiUnauthorized('JWT de Supabase no valido');
  }

  const { data: appUser } = await adminClient
    .from('users')
    .select('id, role')
    .eq('auth_id', user.id)
    .is('deleted_at', null)
    .single();

  return {
    userId: appUser?.id || null,
    authId: user.id,
    authMethod: 'session',
    role: (appUser?.role as UserRole) || undefined,
  };
}

/**
 * Helper para verificar que la auth fue exitosa.
 */
export function isAuthenticated(result: AuthResult | Response): result is AuthResult {
  return 'authMethod' in result;
}
