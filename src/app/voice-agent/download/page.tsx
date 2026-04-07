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

const RELEASE_MANIFEST_PATH = path.resolve(
  process.cwd(),
  'apps/voice-agent-tauri/releases/latest.json'
);

async function getReleaseManifest(): Promise<VoiceAgentReleaseManifest | null> {
  try {
    const raw = await fs.readFile(RELEASE_MANIFEST_PATH, 'utf8');
    return JSON.parse(raw) as VoiceAgentReleaseManifest;
  } catch {
    return null;
  }
}

export default async function VoiceAgentDownloadPage() {
  const manifest = await getReleaseManifest();

  return (
    <main className="mx-auto w-full max-w-3xl px-6 py-10 space-y-6">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold">RDN Voice Agent Desktop</h1>
        <p className="text-sm text-muted-foreground">
          Descarga oficial del cliente Tauri de voz para Centralita.
        </p>
      </header>

      {!manifest && (
        <section className="rounded-lg border p-4 text-sm text-muted-foreground">
          No hay una release publicada todavía. Cuando se publique una build, aparecerá aquí.
        </section>
      )}

      {manifest && (
        <section className="space-y-4">
          <div className="rounded-lg border p-4">
            <p className="text-sm">
              <span className="font-medium">Versión:</span> {manifest.version}
            </p>
            <p className="text-sm text-muted-foreground">
              Publicada: {new Date(manifest.released_at).toLocaleString('es-ES')}
            </p>
            <p className="mt-2 text-sm">{manifest.notes}</p>
          </div>

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
                {manifest.assets.map((asset) => (
                  <tr key={`${asset.platform}-${asset.arch}-${asset.file_name}`} className="border-t">
                    <td className="px-3 py-2">{asset.platform}</td>
                    <td className="px-3 py-2">{asset.arch}</td>
                    <td className="px-3 py-2 font-mono text-xs">{asset.file_name}</td>
                    <td className="px-3 py-2 text-right">
                      <Link className="underline" href={asset.url}>
                        Descargar
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="text-xs text-muted-foreground">
            API de releases: <code>/api/v1/voice-agent/releases/latest</code>
          </p>
        </section>
      )}
    </main>
  );
}
