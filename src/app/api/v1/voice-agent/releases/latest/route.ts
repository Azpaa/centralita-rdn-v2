import { promises as fs } from 'fs';
import path from 'path';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

/**
 * GET /api/v1/voice-agent/releases/latest
 *
 * Tauri v2 auto-updater endpoint (configured in tauri.conf.json). It MUST
 * return the native updater manifest shape — raw JSON, not the `{ ok, data }`
 * API envelope:
 *
 *   { "version": "x.y.z", "pub_date": "...", "notes": "...",
 *     "platforms": { "windows-x86_64": { "signature": "<inline .sig>", "url": "<https...>" } } }
 *
 * The updater verifies `signature` against the `pubkey` baked into the app, so
 * we only ever advertise a platform that has a real signature on disk. With no
 * signed build we return 204 (no update) rather than a manifest the client
 * would reject.
 *
 * Note: this route is consumed ONLY by the updater. The human download page
 * reads `public/downloads/voice-agent/latest.json` directly.
 */

type ReleaseAsset = {
  platform: string;
  arch: string;
  file_name: string;
  url: string;
  signature_url?: string | null;
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

function noUpdate(): NextResponse {
  // 204 No Content → the Tauri updater concludes there is no update available.
  return new NextResponse(null, { status: 204 });
}

function resolveAbsolutePublicPath(urlPath: string): string | null {
  if (!urlPath.startsWith('/')) return null;
  const normalized = urlPath.replace(/\\/g, '/');
  const absolute = path.resolve(PUBLIC_ROOT, `.${normalized}`);
  if (!absolute.startsWith(PUBLIC_ROOT)) return null;
  return absolute;
}

function isExternalUrl(url: string): boolean {
  return url.startsWith('https://') || url.startsWith('http://');
}

/** Map our manifest platform/arch to a Tauri updater target key "<os>-<arch>". */
function toTauriTargetKey(platform: string, arch: string): string | null {
  const a = arch.toLowerCase();
  const archKey =
    a === 'x64' || a === 'x86_64' || a === 'amd64' ? 'x86_64'
    : a === 'arm64' || a === 'aarch64' ? 'aarch64'
    : null;
  if (!archKey) return null;

  const os = platform.toLowerCase();
  const osKey =
    os.startsWith('win') ? 'windows'
    : os.startsWith('mac') || os === 'darwin' ? 'darwin'
    : os.startsWith('linux') ? 'linux'
    : null;
  if (!osKey) return null;

  return `${osKey}-${archKey}`;
}

function toAbsoluteUrl(assetUrl: string, baseUrl: string): string {
  if (isExternalUrl(assetUrl)) return assetUrl;
  const base = baseUrl.replace(/\/+$/, '');
  return `${base}${assetUrl.startsWith('/') ? '' : '/'}${assetUrl}`;
}

async function readSignature(signatureUrl: string | null | undefined): Promise<string | null> {
  if (!signatureUrl) return null;

  if (isExternalUrl(signatureUrl)) {
    try {
      const res = await fetch(signatureUrl);
      if (!res.ok) return null;
      const text = (await res.text()).trim();
      return text.length > 0 ? text : null;
    } catch {
      return null;
    }
  }

  const absolute = resolveAbsolutePublicPath(signatureUrl);
  if (!absolute) return null;
  try {
    const text = (await fs.readFile(absolute, 'utf8')).trim();
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest) {
  let parsed: ReleaseManifest;
  try {
    const raw = await fs.readFile(PUBLIC_RELEASE_MANIFEST_PATH, 'utf8');
    parsed = JSON.parse(raw) as ReleaseManifest;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return noUpdate();
    console.error('[VOICE-AGENT] Error reading latest release manifest:', err);
    return noUpdate();
  }

  if (!parsed || !Array.isArray(parsed.assets) || typeof parsed.version !== 'string') {
    return noUpdate();
  }

  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || new URL(req.url).origin;

  const platforms: Record<string, { signature: string; url: string }> = {};
  for (const asset of parsed.assets) {
    if (!asset || typeof asset.url !== 'string') continue;
    const targetKey = toTauriTargetKey(asset.platform, asset.arch);
    if (!targetKey) continue;

    // Never advertise a platform without a valid signature — the updater
    // verifies it against the configured pubkey and would reject an unsigned
    // build anyway.
    const signature = await readSignature(asset.signature_url);
    if (!signature) continue;

    platforms[targetKey] = {
      signature,
      url: toAbsoluteUrl(asset.url, baseUrl),
    };
  }

  if (Object.keys(platforms).length === 0) {
    // No signed installable asset → nothing to offer.
    return noUpdate();
  }

  return NextResponse.json({
    version: parsed.version,
    pub_date: parsed.released_at,
    notes: parsed.notes,
    platforms,
  });
}
