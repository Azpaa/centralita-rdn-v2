import { promises as fs } from 'fs';
import path from 'path';
import Link from 'next/link';

type ReleaseAsset = {
  platform: string;
  arch: string;
  file_name: string;
  url: string;
  signature_url?: string | null;
  sha256?: string | null;
};

type VoiceAgentReleaseManifest = {
  app_id: string;
  version: string;
  released_at: string;
  notes: string;
  assets: ReleaseAsset[];
};

type ManifestState =
  | { status: 'ok'; manifest: VoiceAgentReleaseManifest }
  | { status: 'missing' }
  | { status: 'invalid' };

const PUBLIC_ROOT = path.resolve(process.cwd(), 'public');
const PUBLIC_RELEASE_MANIFEST_PATH = path.resolve(
  process.cwd(),
  'public/downloads/voice-agent/latest.json'
);

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function parseManifest(input: unknown): VoiceAgentReleaseManifest | null {
  if (!input || typeof input !== 'object') return null;
  const raw = input as Record<string, unknown>;
  if (!isNonEmptyString(raw.app_id)) return null;
  if (!isNonEmptyString(raw.version)) return null;
  if (!isNonEmptyString(raw.released_at)) return null;
  if (!isNonEmptyString(raw.notes)) return null;
  if (!Array.isArray(raw.assets)) return null;

  const assets: ReleaseAsset[] = [];
  for (const item of raw.assets) {
    if (!item || typeof item !== 'object') return null;
    const rawAsset = item as Record<string, unknown>;
    if (!isNonEmptyString(rawAsset.platform)) return null;
    if (!isNonEmptyString(rawAsset.arch)) return null;
    if (!isNonEmptyString(rawAsset.file_name)) return null;
    if (!isNonEmptyString(rawAsset.url)) return null;

    assets.push({
      platform: rawAsset.platform,
      arch: rawAsset.arch,
      file_name: rawAsset.file_name,
      url: rawAsset.url,
      signature_url: typeof rawAsset.signature_url === 'string' ? rawAsset.signature_url : null,
      sha256: typeof rawAsset.sha256 === 'string' ? rawAsset.sha256 : null,
    });
  }

  return {
    app_id: raw.app_id,
    version: raw.version,
    released_at: raw.released_at,
    notes: raw.notes,
    assets,
  };
}

async function loadManifestState(): Promise<ManifestState> {
  try {
    const raw = await fs.readFile(PUBLIC_RELEASE_MANIFEST_PATH, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    const manifest = parseManifest(parsed);
    if (!manifest) return { status: 'invalid' };
    return { status: 'ok', manifest };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { status: 'missing' };
    return { status: 'invalid' };
  }
}

function resolveAbsolutePublicPath(urlPath: string): string | null {
  if (!urlPath.startsWith('/')) return null;
  const normalized = urlPath.replace(/\\/g, '/');
  const absolute = path.resolve(PUBLIC_ROOT, `.${normalized}`);
  if (!absolute.startsWith(PUBLIC_ROOT)) return null;
  return absolute;
}

async function assetIsPublished(asset: ReleaseAsset): Promise<boolean> {
  const absolute = resolveAbsolutePublicPath(asset.url);
  if (!absolute) return false;
  try {
    const stat = await fs.stat(absolute);
    return stat.isFile();
  } catch {
    return false;
  }
}

export default async function VoiceAgentDownloadPage() {
  const manifestState = await loadManifestState();
  const publishedAssets: ReleaseAsset[] = [];

  if (manifestState.status === 'ok') {
    for (const asset of manifestState.manifest.assets) {
      if (await assetIsPublished(asset)) {
        publishedAssets.push(asset);
      }
    }
  }

  return (
    <main className="mx-auto w-full max-w-3xl px-6 py-10 space-y-6">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold">RDN Voice Agent Desktop</h1>
        <p className="text-sm text-muted-foreground">
          Descarga oficial del cliente Tauri de voz para Centralita.
        </p>
        <div>
          <Link
            href="/api/download-agent"
            className="inline-flex rounded-md border border-input bg-background px-3 py-2 text-sm font-medium hover:bg-muted"
          >
            Descargar agente
          </Link>
        </div>
      </header>

      {manifestState.status === 'missing' && (
        <section className="rounded-lg border p-4 text-sm text-muted-foreground">
          No hay una release publicada todavia. Cuando se publique una build, aparecera aqui.
        </section>
      )}

      {manifestState.status === 'invalid' && (
        <section className="rounded-lg border p-4 text-sm text-destructive">
          El archivo <code>/public/downloads/voice-agent/latest.json</code> existe pero es invalido.
          Revisa el formato del manifest de release.
        </section>
      )}

      {manifestState.status === 'ok' && (
        <section className="space-y-4">
          <div className="rounded-lg border p-4">
            <p className="text-sm">
              <span className="font-medium">Version:</span> {manifestState.manifest.version}
            </p>
            <p className="text-sm text-muted-foreground">
              Publicada: {new Date(manifestState.manifest.released_at).toLocaleString('es-ES')}
            </p>
            <p className="mt-2 text-sm">{manifestState.manifest.notes}</p>
          </div>

          {publishedAssets.length === 0 && (
            <section className="rounded-lg border p-4 text-sm text-muted-foreground">
              La release existe pero los binarios no estan disponibles en
              <code> /public/downloads/voice-agent/v{manifestState.manifest.version}/</code>.
              Publica el instalador y vuelve a cargar la pagina.
            </section>
          )}

          {publishedAssets.length > 0 && (
            <div className="rounded-lg border">
              <table className="w-full text-sm">
                <thead className="bg-muted/40">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">Plataforma</th>
                    <th className="px-3 py-2 text-left font-medium">Arquitectura</th>
                    <th className="px-3 py-2 text-left font-medium">Archivo</th>
                    <th className="px-3 py-2 text-right font-medium">Descarga</th>
                  </tr>
                </thead>
                <tbody>
                  {publishedAssets.map((asset) => (
                    <tr key={`${asset.platform}-${asset.arch}-${asset.file_name}`} className="border-t">
                      <td className="px-3 py-2">{asset.platform}</td>
                      <td className="px-3 py-2">{asset.arch}</td>
                      <td className="px-3 py-2 font-mono text-xs">{asset.file_name}</td>
                      <td className="px-3 py-2 text-right">
                        <Link className="underline" href={asset.url} download={asset.file_name}>
                          Descargar
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <p className="text-xs text-muted-foreground">
            API de releases: <code>/api/v1/voice-agent/releases/latest</code>
          </p>
        </section>
      )}
    </main>
  );
}
