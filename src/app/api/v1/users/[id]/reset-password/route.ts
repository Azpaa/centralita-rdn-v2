import { NextRequest } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { authenticate, isAuthenticated, requireRole } from '@/lib/api/auth';
import { apiSuccess, apiBadRequest, apiNotFound, apiInternalError } from '@/lib/api/response';
import { auditLog } from '@/lib/api/audit';
import { generateTempPassword } from '@/lib/api/sanitize';
import { z } from 'zod';

const resetPasswordSchema = z.object({
  password: z.string().min(8).max(72).optional(),
});

/**
 * POST /api/v1/users/{id}/reset-password
 *
 * Resetea la contraseña de un usuario. Útil para:
 * - RDN quiere darle acceso a un empleado que olvidó su contraseña
 * - RDN quiere generar una nueva contraseña temporal para un usuario existente
 *
 * Si se envía `password`, se usa esa. Si no, se genera una temporal.
 * Siempre activa `must_change_password = true`.
 *
 * Respuesta incluye `_temp_password` si se generó automáticamente.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await authenticate(req);
  if (!isAuthenticated(auth)) return auth;

  const roleCheck = requireRole(auth, 'admin');
  if (roleCheck !== true) return roleCheck;

  const { id } = await params;

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    // Body vacío = generar temporal
  }

  const parsed = resetPasswordSchema.safeParse(body);
  if (!parsed.success) {
    return apiBadRequest('Datos inválidos', parsed.error.flatten().fieldErrors);
  }

  const supabase = createAdminClient();

  // Buscar usuario
  const { data: user } = await supabase
    .from('users')
    .select('id, auth_id, email, name')
    .eq('id', id)
    .is('deleted_at', null)
    .single();

  if (!user) {
    return apiNotFound('Usuario no encontrado');
  }

  const newPassword = parsed.data?.password || generateTempPassword();
  const isTemp = !parsed.data?.password;

  // Si no tiene auth_id, crear cuenta auth
  if (!user.auth_id) {
    const { data: authData, error: authError } = await supabase.auth.admin.createUser({
      email: user.email,
      password: newPassword,
      email_confirm: true,
    });

    if (authError) {
      console.error('Error creating auth user:', authError);
      return apiInternalError('No se pudo crear la cuenta de autenticación');
    }

    await supabase
      .from('users')
      .update({
        auth_id: authData.user.id,
        must_change_password: isTemp,
      })
      .eq('id', id);
  } else {
    // Ya tiene auth_id → actualizar contraseña
    const { error: updateError } = await supabase.auth.admin.updateUserById(
      user.auth_id,
      { password: newPassword }
    );

    if (updateError) {
      console.error('Error updating password:', updateError);
      return apiInternalError('No se pudo actualizar la contraseña');
    }

    await supabase
      .from('users')
      .update({ must_change_password: isTemp })
      .eq('id', id);
  }

  await auditLog('user.updated', 'user', id, auth.userId, { action: 'password_reset', is_temp: isTemp });

  return apiSuccess({
    user_id: id,
    email: user.email,
    must_change_password: isTemp,
    ...(isTemp ? { _temp_password: newPassword } : {}),
  });
}
