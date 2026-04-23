'use server';

import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { redirect } from 'next/navigation';

export async function login(formData: FormData) {
  const supabase = await createClient();

  const email = formData.get('email') as string;
  const password = formData.get('password') as string;

  const { error } = await supabase.auth.signInWithPassword({ email, password });

  if (error) {
    return { error: error.message };
  }

  // Comprobar si debe cambiar contraseña
  let mustChangePassword = false;
  const { data: { user } } = await supabase.auth.getUser();
  if (user) {
    try {
      const admin = createAdminClient();
      const { data: profile } = await admin
        .from('users')
        .select('must_change_password')
        .eq('auth_id', user.id)
        .single();

      mustChangePassword = profile?.must_change_password === true;
    } catch {
      // Columna puede no existir aún — continuar al dashboard
    }
  }

  redirect(mustChangePassword ? '/change-password' : '/');
}

export async function changePassword(formData: FormData) {
  const supabase = await createClient();

  const currentPassword = formData.get('currentPassword') as string;
  const newPassword = formData.get('newPassword') as string;
  const confirmPassword = formData.get('confirmPassword') as string;

  if (!currentPassword || !newPassword || !confirmPassword) {
    return { error: 'Todos los campos son obligatorios' };
  }

  if (newPassword.length < 8) {
    return { error: 'La nueva contraseña debe tener al menos 8 caracteres' };
  }

  if (newPassword !== confirmPassword) {
    return { error: 'Las contraseñas no coinciden' };
  }

  if (currentPassword === newPassword) {
    return { error: 'La nueva contraseña debe ser diferente a la actual' };
  }

  // Verificar contraseña actual re-autenticando
  const { data: { user } } = await supabase.auth.getUser();
  if (!user?.email) {
    return { error: 'Sesión inválida' };
  }

  const { error: signInError } = await supabase.auth.signInWithPassword({
    email: user.email,
    password: currentPassword,
  });

  if (signInError) {
    return { error: 'La contraseña actual es incorrecta' };
  }

  // Actualizar contraseña
  const { error: updateError } = await supabase.auth.updateUser({
    password: newPassword,
  });

  if (updateError) {
    return { error: 'No se pudo actualizar la contraseña: ' + updateError.message };
  }

  // Quitar el flag must_change_password
  const admin = createAdminClient();
  await admin
    .from('users')
    .update({ must_change_password: false })
    .eq('auth_id', user.id);

  redirect('/');
}

export async function logout() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect('/login');
}
