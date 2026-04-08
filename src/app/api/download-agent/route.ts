import { promises as fs } from 'fs';
import path from 'path';
import { NextRequest, NextResponse } from 'next/server';
import { apiInternalError } from '@/lib/api/response';

type ReleaseAsset = {
  platform?: string;
  arch?: string;
  file_name?: string;
  url?: string;
};

type ReleaseManifest = {
  assets?: ReleaseAsset[];
};

const PUBLIC_ROOT = path.resolve(process.cwd(), 'public');
const PUBLIC_RELEASE_MANIFEST_PATH = path.resolve(
  process.cwd(),
  'public/downloads/voice-agent/latest.json'
);

function toAbsoluteBaseUrl(req: NextRequest): string {
  const url = new URL(req.url);
  return `${url.protocol}//${url.host}`;
}

function parseHttpUrl(rawUrl: string): string | null {
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

function getDownloadUrlFromEnv(): string | null {
  const rawUrl = process.env.VOICE_AGENT_DOWNLOAD_URL?.trim();
  if (!rawUrl) return null;
  return parseHttpUrl(rawUrl);
}

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

function scoreAsset(asset: ReleaseAsset): number {
  let score = 0;
  if (asset.platform === 'windows') score += 4;
  if (asset.arch === 'x64') score += 2;
  if ((asset.file_name || '').toLowerCase().endsWith('.exe')) score += 1;
  return score;
}

async function getDownloadUrlFromManifest(req: NextRequest): Promise<string | null> {
  try {
    const raw = await fs.readFile(PUBLIC_RELEASE_MANIFEST_PATH, 'utf8');
    const parsed = JSON.parse(raw) as ReleaseManifest;
    const assets = Array.isArray(parsed.assets) ? parsed.assets : [];

    const ranked = assets
      .filter((asset) => typeof asset?.url === 'string' && asset.url.length > 0)
      .sort((a, b) => scoreAsset(b) - scoreAsset(a));

    for (const asset of ranked) {
      const rawUrl = (asset.url || '').trim();
      if (!rawUrl) continue;

      if (rawUrl.startsWith('/')) {
        if (!(await assetExists(rawUrl))) continue;
        return new URL(rawUrl, toAbsoluteBaseUrl(req)).toString();
      }

      const external = parseHttpUrl(rawUrl);
      if (external) return external;
    }
  } catch {
    // Fallback below to env var
  }

  return null;
}

/**
 * GET /api/download-agent
 * Redirige al instalador publicado del Voice Agent (GitHub Releases o CDN).
 * TODO(auth): si se quiere restringir por rol, validar aqui con authenticate()/requireRole().
 */
export async function GET(req: NextRequest) {
  const manifestUrl = await getDownloadUrlFromManifest(req);
  const downloadUrl = manifestUrl || getDownloadUrlFromEnv();
  if (!downloadUrl) {
    return apiInternalError(
      'No se encontro instalador publicado. Revisa public/downloads/voice-agent/latest.json o VOICE_AGENT_DOWNLOAD_URL.'
    );
  }

  return NextResponse.redirect(downloadUrl, 307);
}
