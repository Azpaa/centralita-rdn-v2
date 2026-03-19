/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Script para crear el primer usuario admin en Supabase Auth + tabla users.
 *
 * Ejecutar:  npx tsx --env-file=.env.local scripts/seed-admin.ts
 *
 * Variables requeridas en .env.local:
 *   NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

declare const process: { env: Record<string, string | undefined>; exit(code: number): never };

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const ADMIN_EMAIL = 'admin@rdn.com';
const ADMIN_PASSWORD = 'Admin1234!';
const ADMIN_NAME = 'Admin RDN';

async function seed() {
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    console.error('❌ Faltan variables de entorno SUPABASE_URL / SERVICE_ROLE_KEY');
    process.exit(1);
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  console.log('🔧 Creando usuario admin en Supabase Auth...');

  // 1. Crear en auth
  const { data: authData, error: authError } = await supabase.auth.admin.createUser({
    email: ADMIN_EMAIL,
    password: ADMIN_PASSWORD,
    email_confirm: true,
  });

  if (authError) {
    if (authError.message.includes('already been registered')) {
      console.log('ℹ️  El usuario auth ya existe. Buscándolo...');
      const { data: list } = await supabase.auth.admin.listUsers();
      const existing = list?.users.find((u) => u.email === ADMIN_EMAIL);
      if (existing) {
        await ensureUserRow(supabase, existing.id);
      }
      return;
    }
    console.error('❌ Error creando usuario auth:', authError.message);
    process.exit(1);
  }

  if (!authData.user) {
    console.error('❌ No se recibió usuario del auth');
    process.exit(1);
  }

  console.log('✅ Usuario auth creado:', authData.user.id);

  // 2. Crear en tabla users
  await ensureUserRow(supabase, authData.user.id);
}

async function ensureUserRow(supabase: SupabaseClient<any, any, any>, authId: string) {
  const { data: existing } = await supabase
    .from('users')
    .select('id')
    .eq('email', ADMIN_EMAIL)
    .single();

  if (existing) {
    // Actualizar auth_id si falta
    await supabase.from('users').update({ auth_id: authId } as any).eq('id', (existing as any).id);
    console.log('ℹ️  Usuario ya existe en tabla users, auth_id vinculado.');
    return;
  }

  const { error } = await supabase.from('users').insert({
    auth_id: authId,
    name: ADMIN_NAME,
    email: ADMIN_EMAIL,
    role: 'admin',
    available: true,
    active: true,
    rdn_linked: false,
  } as any);

  if (error) {
    console.error('❌ Error insertando en tabla users:', error.message);
    process.exit(1);
  }

  console.log('✅ Usuario admin creado en tabla users');
  console.log('');
  console.log('📋 Credenciales:');
  console.log(`   Email:    ${ADMIN_EMAIL}`);
  console.log(`   Password: ${ADMIN_PASSWORD}`);
  console.log('');
  console.log('🚀 Ahora puedes iniciar sesión en el panel.');
}

seed().catch(console.error);
