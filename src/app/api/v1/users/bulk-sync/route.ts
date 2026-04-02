import { NextRequest } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { authenticate, isAuthenticated, requireRole } from '@/lib/api/auth';
import { apiSuccess, apiBadRequest } from '@/lib/api/response';
import { auditLog } from '@/lib/api/audit';
import { generateTempPassword } from '@/lib/api/sanitize';
import { z } from 'zod';

// --- Validación ---

const bulkSyncUserSchema = z.object({
  rdn_user_id: z.string().min(1, 'rdn_user_id es requerido'),
  name: z.string().min(1).max(200),
  email: z.string().email(),
  phone: z.string().optional().nullable(),
  role: z.enum(['admin', 'operator']).default('operator'),
  active: z.boolean().default(true),
  password: z.string().min(8).max(72).optional(),
});

const bulkSyncSchema = z.object({
  users: z.array(bulkSyncUserSchema).min(1).max(100, 'Máximo 100 usuarios por batch'),
});

/**
 * POST /api/v1/users/bulk-sync
 * Sincronización masiva de usuarios desde RDN.
 *
 * Para cada usuario del array:
 * - Si existe un usuario con el mismo `rdn_user_id` → actualiza (nombre, email, phone, active)
 * - Si no existe pero hay coincidencia por `email` → vincula y actualiza
 * - Si no existe en absoluto → crea nuevo
 *
 * Siempre idempotente: se puede llamar repetidamente con los mismos datos.
 *
 * Body: { users: [{ rdn_user_id, name, email, phone?, role?, active? }] }
 */
export async function POST(req: NextRequest) {
  const auth = await authenticate(req);
  if (!isAuthenticated(auth)) return auth;

  const roleCheck = requireRole(auth, 'admin');
  if (roleCheck !== true) return roleCheck;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return apiBadRequest('Body JSON inválido');
  }

  const parsed = bulkSyncSchema.safeParse(body);
  if (!parsed.success) {
    return apiBadRequest('Datos inválidos', parsed.error.flatten().fieldErrors);
  }

  const supabase = createAdminClient();
  const results: {
    rdn_user_id: string;
    action: 'created' | 'updated' | 'linked' | 'error';
    user_id?: string;
    error?: string;
    _temp_password?: string;
  }[] = [];

  for (const input of parsed.data.users) {
    try {
      // 1. Buscar por rdn_user_id
      const { data: existingByRdn } = await supabase
        .from('users')
        .select('id, email, name')
        .eq('rdn_user_id', input.rdn_user_id)
        .is('deleted_at', null)
        .single();

      if (existingByRdn) {
        // Ya vinculado → actualizar
        await supabase
          .from('users')
          .update({
            name: input.name,
            email: input.email,
            phone: input.phone ?? null,
            role: input.role,
            active: input.active,
          })
          .eq('id', existingByRdn.id);

        results.push({ rdn_user_id: input.rdn_user_id, action: 'updated', user_id: existingByRdn.id });
        continue;
      }

      // 2. Buscar por email
      const { data: existingByEmail } = await supabase
        .from('users')
        .select('id, rdn_user_id, auth_id')
        .eq('email', input.email)
        .is('deleted_at', null)
        .single();

      if (existingByEmail) {
        if (existingByEmail.rdn_user_id && existingByEmail.rdn_user_id !== input.rdn_user_id) {
          // Ya vinculado a OTRO rdn_user_id → conflicto
          results.push({
            rdn_user_id: input.rdn_user_id,
            action: 'error',
            error: `Email ${input.email} ya está vinculado a rdn_user_id=${existingByEmail.rdn_user_id}`,
          });
          continue;
        }

        // Vincular y actualizar
        const updateFields: Record<string, unknown> = {
          rdn_user_id: input.rdn_user_id,
          rdn_linked: true,
          name: input.name,
          phone: input.phone ?? null,
          role: input.role,
          active: input.active,
        };

        // Si no tiene cuenta auth, crearla ahora
        let tempPassword: string | undefined;
        if (!existingByEmail.auth_id) {
          tempPassword = input.password || generateTempPassword();
          const { data: authData, error: authError } = await supabase.auth.admin.createUser({
            email: input.email,
            password: tempPassword,
            email_confirm: true,
          });
          if (!authError && authData.user) {
            updateFields.auth_id = authData.user.id;
            updateFields.must_change_password = !input.password;
          }
        }

        await supabase
          .from('users')
          .update(updateFields)
          .eq('id', existingByEmail.id);

        results.push({
          rdn_user_id: input.rdn_user_id,
          action: 'linked',
          user_id: existingByEmail.id,
          _temp_password: tempPassword && !input.password ? tempPassword : undefined,
        });
        continue;
      }

      // 3. No existe → crear con cuenta auth
      const tempPassword = input.password || generateTempPassword();
      const { data: authData, error: authError } = await supabase.auth.admin.createUser({
        email: input.email,
        password: tempPassword,
        email_confirm: true,
      });

      if (authError) {
        results.push({
          rdn_user_id: input.rdn_user_id,
          action: 'error',
          error: `Error creando cuenta auth: ${authError.message}`,
        });
        continue;
      }

      const { data: newUser, error: createError } = await supabase
        .from('users')
        .insert({
          auth_id: authData.user.id,
          name: input.name,
          email: input.email,
          phone: input.phone ?? null,
          role: input.role,
          rdn_user_id: input.rdn_user_id,
          rdn_linked: true,
          available: false,
          active: input.active,
          must_change_password: !input.password,
        })
        .select('id')
        .single();

      if (createError) {
        // Rollback: eliminar auth user
        await supabase.auth.admin.deleteUser(authData.user.id);
        results.push({
          rdn_user_id: input.rdn_user_id,
          action: 'error',
          error: createError.message,
        });
        continue;
      }

      results.push({
        rdn_user_id: input.rdn_user_id,
        action: 'created',
        user_id: newUser?.id,
        _temp_password: input.password ? undefined : tempPassword,
      });
    } catch (err) {
      results.push({
        rdn_user_id: input.rdn_user_id,
        action: 'error',
        error: err instanceof Error ? err.message : 'Error desconocido',
      });
    }
  }

  const summary = {
    total: results.length,
    created: results.filter(r => r.action === 'created').length,
    updated: results.filter(r => r.action === 'updated').length,
    linked: results.filter(r => r.action === 'linked').length,
    errors: results.filter(r => r.action === 'error').length,
  };

  await auditLog('user.updated', 'bulk_sync', null, auth.userId, { summary });

  return apiSuccess({ summary, results });
}
