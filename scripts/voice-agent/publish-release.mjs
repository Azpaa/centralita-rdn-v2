#!/usr/bin/env node
import { promises as fs } from 'fs';
import path from 'path';

const ROOT = process.cwd();
const TAURI_APP_DIR = path.resolve(ROOT, 'apps/voice-agent-tauri');
const TAURI_PACKAGE_PATH = path.resolve(TAURI_APP_DIR, 'package.json');
const BUNDLE_DIR = path.resolve(TAURI_APP_DIR, 'src-tauri/target/release/bundle');
const RELEASES_MANIFEST_PATH = path.resolve(TAURI_APP_DIR, 'releases/latest.json');
const PUBLIC_DOWNLOADS_BASE = path.resolve(ROOT, 'public/downloads/voice-agent');
const PUBLIC_LATEST_MANIFEST_PATH = path.resolve(PUBLIC_DOWNLOADS_BASE, 'latest.json');

const ACCEPTED_EXTENSIONS = [
  '.exe',
  '.msi',
  '.dmg',
  '.appimage',
  '.deb',
  '.rpm',
  '.app.tar.gz',
  '.nsis.zip',
  '.sig',
];

async function readJson(filePath) {
  const raw = await fs.readFile(filePath, 'utf8');
  return JSON.parse(raw);
}

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

async function listFilesRecursive(rootDir) {
  const entries = await fs.readdir(rootDir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const full = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFilesRecursive(full)));
    } else {
      files.push(full);
    }
  }

  return files;
}

function fileExtMatches(fileName) {
  const lower = fileName.toLowerCase();
  return ACCEPTED_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

function inferPlatform(filePath) {
  const lower = filePath.toLowerCase();
  if (lower.includes('windows')) return 'windows';
  if (lower.includes('linux')) return 'linux';
  if (lower.includes('macos') || lower.includes('darwin')) return 'macos';
  return 'unknown';
}

function inferArch(fileName) {
  const lower = fileName.toLowerCase();
  if (lower.includes('x86_64') || lower.includes('x64') || lower.includes('amd64')) return 'x64';
  if (lower.includes('aarch64') || lower.includes('arm64')) return 'arm64';
  return 'unknown';
}

async function main() {
  const pkg = await readJson(TAURI_PACKAGE_PATH);
  const version = pkg.version;
  const releasedAt = new Date().toISOString();
  const notes = process.env.VOICE_AGENT_RELEASE_NOTES || `Voice Agent release ${version}`;

  const versionDir = path.resolve(PUBLIC_DOWNLOADS_BASE, `v${version}`);
  await ensureDir(versionDir);

  let files = [];
  try {
    files = await listFilesRecursive(BUNDLE_DIR);
  } catch {
    console.error(`[voice-agent] No se encontró bundle dir: ${BUNDLE_DIR}`);
    process.exit(1);
  }

  const artifactFiles = files.filter((file) => fileExtMatches(path.basename(file)));
  if (artifactFiles.length === 0) {
    console.error('[voice-agent] No se encontraron artefactos de build para publicar.');
    process.exit(1);
  }

  const copied = [];
  for (const sourceFile of artifactFiles) {
    const fileName = path.basename(sourceFile);
    const targetFile = path.resolve(versionDir, fileName);
    await fs.copyFile(sourceFile, targetFile);
    copied.push({
      sourceFile,
      fileName,
      targetFile,
    });
  }

  const mainAssets = copied
    .filter((asset) => !asset.fileName.toLowerCase().endsWith('.sig'))
    .map((asset) => {
      const sigFileName = `${asset.fileName}.sig`;
      const hasSig = copied.some((candidate) => candidate.fileName === sigFileName);
      return {
        platform: inferPlatform(asset.sourceFile),
        arch: inferArch(asset.fileName),
        file_name: asset.fileName,
        url: `/downloads/voice-agent/v${version}/${asset.fileName}`,
        signature_url: hasSig ? `/downloads/voice-agent/v${version}/${sigFileName}` : null,
        sha256: null,
      };
    });

  const manifest = {
    app_id: 'com.rdn.voice_agent',
    version,
    released_at: releasedAt,
    notes,
    assets: mainAssets,
  };

  await ensureDir(path.dirname(RELEASES_MANIFEST_PATH));
  await fs.writeFile(RELEASES_MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  await fs.writeFile(PUBLIC_LATEST_MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  console.log(`[voice-agent] Publicada release ${version}`);
  console.log(`[voice-agent] Assets: ${mainAssets.length}`);
  console.log(`[voice-agent] Manifest: ${RELEASES_MANIFEST_PATH}`);
}

main().catch((err) => {
  console.error('[voice-agent] Error publicando release:', err);
  process.exit(1);
});
