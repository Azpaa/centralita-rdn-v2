#!/usr/bin/env node
import { promises as fs } from 'fs';
import path from 'path';

const ROOT = process.cwd();
const TAURI_APP_DIR = path.resolve(ROOT, 'apps/voice-agent-tauri');
const TAURI_PACKAGE_PATH = path.resolve(TAURI_APP_DIR, 'package.json');
const BUNDLE_DIR = path.resolve(TAURI_APP_DIR, 'src-tauri/target/release/bundle');
const TAURI_RELEASES_MANIFEST_PATH = path.resolve(TAURI_APP_DIR, 'releases/latest.json');
const PUBLIC_DOWNLOADS_BASE = path.resolve(ROOT, 'public/downloads/voice-agent');
const PUBLIC_LATEST_MANIFEST_PATH = path.resolve(PUBLIC_DOWNLOADS_BASE, 'latest.json');
const APP_ID = 'com.rdn.voiceagent';

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

function inferArch(fileName) {
  const lower = fileName.toLowerCase();
  if (lower.includes('x86_64') || lower.includes('x64') || lower.includes('amd64')) return 'x64';
  if (lower.includes('aarch64') || lower.includes('arm64')) return 'arm64';
  return 'unknown';
}

function toPosixPath(inputPath) {
  return inputPath.replace(/\\/g, '/');
}

function pickPrimaryWindowsInstaller(files) {
  const exeFiles = files.filter((file) => file.toLowerCase().endsWith('.exe'));
  if (exeFiles.length === 0) return null;

  const setupPreferred = exeFiles.filter((file) => {
    const base = path.basename(file).toLowerCase();
    return base.includes('setup') || base.includes('-nsis');
  });

  const candidates = setupPreferred.length > 0 ? setupPreferred : exeFiles;
  candidates.sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
  return candidates[0];
}

function findSignatureForInstaller(installerPath, files) {
  const installerBase = path.basename(installerPath);
  const exactSigName = `${installerBase}.sig`;
  const exact = files.find((file) => path.basename(file) === exactSigName);
  if (exact) return exact;

  const sigFiles = files.filter((file) => file.toLowerCase().endsWith('.sig'));
  if (sigFiles.length === 1) return sigFiles[0];
  return null;
}

async function main() {
  const pkg = await readJson(TAURI_PACKAGE_PATH);
  const version = pkg.version;
  const releasedAt = new Date().toISOString();
  const notes = process.env.VOICE_AGENT_RELEASE_NOTES || `Release ${version}`;

  let files = [];
  try {
    files = await listFilesRecursive(BUNDLE_DIR);
  } catch {
    console.error(`[voice-agent] Bundle directory no encontrado: ${BUNDLE_DIR}`);
    process.exit(1);
  }

  const installerPath = pickPrimaryWindowsInstaller(files);
  if (!installerPath) {
    console.error('[voice-agent] No se encontro instalador .exe en bundle.');
    console.error(`[voice-agent] Revisa que exista build en: ${BUNDLE_DIR}`);
    process.exit(1);
  }

  const signaturePath = findSignatureForInstaller(installerPath, files);
  const installerFileName = path.basename(installerPath);
  const arch = inferArch(installerFileName);
  const versionDir = path.resolve(PUBLIC_DOWNLOADS_BASE, `v${version}`);
  await ensureDir(versionDir);

  const installerTarget = path.resolve(versionDir, installerFileName);
  await fs.copyFile(installerPath, installerTarget);

  let signatureFileName = null;
  if (signaturePath) {
    signatureFileName = path.basename(signaturePath);
    const signatureTarget = path.resolve(versionDir, signatureFileName);
    await fs.copyFile(signaturePath, signatureTarget);
  }

  const manifest = {
    app_id: APP_ID,
    version,
    released_at: releasedAt,
    notes,
    assets: [
      {
        platform: 'windows',
        arch,
        file_name: installerFileName,
        url: toPosixPath(`/downloads/voice-agent/v${version}/${installerFileName}`),
        ...(signatureFileName
          ? {
              signature_url: toPosixPath(`/downloads/voice-agent/v${version}/${signatureFileName}`),
            }
          : {}),
      },
    ],
  };

  await ensureDir(path.dirname(TAURI_RELEASES_MANIFEST_PATH));
  await fs.writeFile(TAURI_RELEASES_MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  await fs.writeFile(PUBLIC_LATEST_MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  console.log(`[voice-agent] Release publicada: ${version}`);
  console.log(`[voice-agent] Instalador: ${installerFileName}`);
  if (signatureFileName) {
    console.log(`[voice-agent] Firma: ${signatureFileName}`);
  } else {
    console.log('[voice-agent] Firma no encontrada (opcional).');
  }
  console.log(`[voice-agent] Manifest actualizado: ${TAURI_RELEASES_MANIFEST_PATH}`);
  console.log(`[voice-agent] Public manifest: ${PUBLIC_LATEST_MANIFEST_PATH}`);
}

main().catch((err) => {
  console.error('[voice-agent] Error publicando release:', err);
  process.exit(1);
});

