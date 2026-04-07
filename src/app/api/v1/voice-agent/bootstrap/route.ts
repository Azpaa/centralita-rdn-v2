import { NextRequest } from 'next/server';
import { apiSuccess } from '@/lib/api/response';

/**
 * GET /api/v1/voice-agent/bootstrap
 * Configuración de bootstrap para el cliente Tauri de voz.
 *
 * Solo expone claves públicas/config pública:
 * - URL base backend
 * - URL/anon key de Supabase (ya públicas en web)
 * - endpoints canónicos de stream/estado/comandos
 * - endpoints de releases/download para updates
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const inferredBaseUrl = `${url.protocol}//${url.host}`;
  const backendBaseUrl = process.env.NEXT_PUBLIC_APP_URL || inferredBaseUrl;

  return apiSuccess({
    app: {
      id: 'com.rdn.voice_agent',
      name: 'RDN Voice Agent',
    },
    backend: {
      base_url: backendBaseUrl,
      api_base_path: '/api/v1',
      stream_events_path: '/api/v1/stream/events',
      agent_state_path: '/api/v1/agent/me/state',
      call_commands_base_path: '/api/v1/calls',
    },
    auth: {
      mode: 'supabase_jwt',
      supabase_url: process.env.NEXT_PUBLIC_SUPABASE_URL || '',
      supabase_anon_key: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '',
      note: 'Desktop client signs in with Supabase and sends Authorization Bearer JWT to backend APIs.',
    },
    distribution: {
      download_index_url: `${backendBaseUrl}/voice-agent/download`,
      releases_latest_url: `${backendBaseUrl}/api/v1/voice-agent/releases/latest`,
      public_artifacts_base_url: `${backendBaseUrl}/downloads/voice-agent`,
    },
  });
}
