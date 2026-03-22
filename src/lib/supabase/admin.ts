import { createClient as createSupabaseClient, SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/types/database';

/**
 * Cliente admin de Supabase (service role) — SINGLETON.
 * Bypasea RLS. Solo usar en server-side (API routes, server actions).
 * NUNCA exponer al cliente.
 *
 * Se reutiliza la misma instancia en toda la vida del proceso para
 * aprovechar el pool de conexiones interno de supabase-js.
 */
let adminClient: SupabaseClient<Database> | null = null;

export function createAdminClient(): SupabaseClient<Database> {
  if (!adminClient) {
    adminClient = createSupabaseClient<Database>(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      {
        auth: {
          autoRefreshToken: false,
          persistSession: false,
        },
      }
    );
  }
  return adminClient;
}
