import { promises as fs } from 'fs';
import path from 'path';
import { apiInternalError, apiNotFound, apiSuccess } from '@/lib/api/response';

const RELEASE_MANIFEST_PATH = path.resolve(
  process.cwd(),
  'apps/voice-agent-tauri/releases/latest.json'
);

export async function GET() {
  try {
    const raw = await fs.readFile(RELEASE_MANIFEST_PATH, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    return apiSuccess(parsed);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return apiNotFound('Manifest de release de Voice Agent');
    }
    console.error('[VOICE-AGENT] Error reading latest release manifest:', err);
    return apiInternalError('No se pudo leer el manifest de releases');
  }
}
