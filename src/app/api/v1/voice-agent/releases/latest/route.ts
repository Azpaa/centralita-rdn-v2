import { promises as fs } from 'fs';
import path from 'path';
import { apiInternalError, apiNotFound, apiSuccess } from '@/lib/api/response';

type ReleaseAsset = {
  platform: string;
  arch: string;
  file_name: string;
  url: string;
  signature_url?: string | null;
  sha256?: string | null;
};

type ReleaseManifest = {
  app_id: string;
  version: string;
  released_at: string;
  notes: string;
  assets: ReleaseAsset[];
};

const PUBLIC_ROOT = path.resolve(process.cwd(), 'public');
const PUBLIC_RELEASE_MANIFEST_PATH = path.resolve(
  process.cwd(),
  'public/downloads/voice-agent/latest.json'
);

function resolveAbsolutePublicPath(urlPath: string): string | null {
  if (!urlPath.startsWith('/')) return null;
  const normalized = urlPath.replace(/\\/g, '/');
  const absolute = path.resolve(PUBLIC_ROOT, `.${normalized}`);
  if (!absolute.startsWith(PUBLIC_ROOT)) return null;
  return absolute;
}

async function assetExists(urlPath: string): Promise<boolean> {
  const absolute = resolveAbsolutePublicPath(urlPath);
  if (!absolute) return false;
  try {
    const stat = await fs.stat(absolute);
    return stat.isFile();
  } catch {
    return false;
  }
}

export async function GET() {
  try {
    const raw = await fs.readFile(PUBLIC_RELEASE_MANIFEST_PATH, 'utf8');
    const parsed = JSON.parse(raw) as ReleaseManifest;

    if (!parsed || !Array.isArray(parsed.assets)) {
      return apiInternalError('Manifest de release invalido');
    }

    const filteredAssets: ReleaseAsset[] = [];
    for (const asset of parsed.assets) {
      if (!asset || typeof asset.url !== 'string') continue;
      if (await assetExists(asset.url)) {
        filteredAssets.push(asset);
      }
    }

    return apiSuccess({
      ...parsed,
      assets: filteredAssets,
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return apiNotFound('Manifest de release de Voice Agent');
    }
    console.error('[VOICE-AGENT] Error reading latest release manifest:', err);
    return apiInternalError('No se pudo leer el manifest de releases');
  }
}

