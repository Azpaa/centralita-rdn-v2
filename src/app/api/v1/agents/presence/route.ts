import { NextRequest } from 'next/server';
import { authenticate, isAuthenticated } from '@/lib/api/auth';
import { apiSuccess } from '@/lib/api/response';
import { createAdminClient } from '@/lib/supabase/admin';
import { hasActiveDesktopStreamForUser } from '@/lib/events/client-stream';
import { getBusyAgentIds } from '@/lib/twilio/call-engine';

// La presencia vive en el mapa de suscriptores SSE de ESTE proceso: nada de
// edge ni de respuestas cacheadas.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/v1/agents/presence
 * Quién está de verdad disponible para recibir una llamada o una
 * transferencia, con las MISMAS reglas que aplica el backend al transferir
 * (lib/calls/transfer.ts): softphone de escritorio conectado y sin llamada en
 * curso.
 *
 * Existe para que RDN deje de decidir con su presencia propia
 * (`profiles.call_status` del Twilio antiguo), que no refleja si el Tauri del
 * agente está abierto: su selector de transferencia salía casi vacío y
 * rechazaba compañeros que sí estaban conectados.
 */
export async function GET(req: NextRequest) {
  const auth = await authenticate(req);
  if (!isAuthenticated(auth)) return auth;

  const supabase = createAdminClient();
  const { data: users } = await supabase
    .from('users')
    .select('id, name, rdn_user_id')
    .eq('active', true)
    .is('deleted_at', null)
    .order('name', { ascending: true });

  const busy = await getBusyAgentIds();

  const agents = ((users ?? []) as Array<{ id: string; name: string | null; rdn_user_id: string | null }>)
    .map((user) => {
      const softphoneOnline = hasActiveDesktopStreamForUser(user.id);
      const isBusy = busy.has(user.id);
      return {
        user_id: user.id,
        rdn_user_id: user.rdn_user_id,
        name: user.name,
        softphone_online: softphoneOnline,
        busy: isBusy,
        available_for_transfer: softphoneOnline && !isBusy,
      };
    });

  return apiSuccess({ agents, generated_at: new Date().toISOString() });
}
