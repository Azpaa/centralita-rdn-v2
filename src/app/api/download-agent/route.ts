import { NextResponse } from 'next/server';
import { apiInternalError } from '@/lib/api/response';

function getDownloadUrl(): string | null {
  const rawUrl = process.env.VOICE_AGENT_DOWNLOAD_URL?.trim();
  if (!rawUrl) return null;

  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

/**
 * GET /api/download-agent
 * Redirige al instalador publicado del Voice Agent (GitHub Releases o CDN).
 * TODO(auth): si se quiere restringir por rol, validar aqui con authenticate()/requireRole().
 */
export async function GET() {
  const downloadUrl = getDownloadUrl();
  if (!downloadUrl) {
    return apiInternalError(
      'VOICE_AGENT_DOWNLOAD_URL no esta configurada o es invalida. Configura la URL del instalador.'
    );
  }

  return NextResponse.redirect(downloadUrl, 307);
}
