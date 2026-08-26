#!/usr/bin/env node

import { readdir, stat } from 'node:fs/promises';
import { extname, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const remote = process.argv.includes('--remote');
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const scenesDir = join(root, 'scenes');
const bucket = process.env.R2_BUCKET ?? 'open-heritage-scenes';

const MIME = new Map([
  ['.ply', 'application/octet-stream'],
  ['.sog', 'application/octet-stream'],
  ['.spz', 'application/octet-stream'],
  ['.bin', 'application/octet-stream'],
  ['.glb', 'model/gltf-binary'],
  ['.txt', 'text/plain; charset=utf-8']
]);

const SKIP = new Set(['.DS_Store', 'DOWNLOAD_LOG.tsv']);

let files;
try {
  const entries = await readdir(scenesDir, { withFileTypes: true });
  files = entries
    .filter((entry) => entry.isFile() && !entry.name.startsWith('.') && !SKIP.has(entry.name))
    .map((entry) => entry.name);
} catch {
  console.error(`scenes/ directory not found at ${scenesDir}`);
  process.exit(1);
}

if (files.length === 0) {
  console.log('No scene files to sync. Run ./download_scenes.sh all first.');
  process.exit(0);
}

console.log(`Syncing ${files.length} file(s) from scenes/ to R2 bucket "${bucket}" (${remote ? 'remote' : 'local'}).`);

let failed = 0;
for (const name of files) {
  const filePath = join(scenesDir, name);
  const info = await stat(filePath);
  const key = `scenes/${name}`;
  const contentType = MIME.get(extname(name).toLowerCase()) ?? 'application/octet-stream';

  const args = [
    'r2', 'object', 'put', `${bucket}/${key}`,
    '--file', filePath,
    '--content-type', contentType,
    remote ? '--remote' : '--local'
  ];

  const result = spawnSync('npx', ['wrangler', ...args], {
    stdio: ['ignore', 'pipe', 'inherit'],
    encoding: 'utf8',
    cwd: root
  });

  if (result.status !== 0) {
    failed += 1;
    console.error(`Failed: ${key}`);
    if (result.stdout) console.error(result.stdout);
  } else {
    console.log(`Uploaded: ${key} (${(info.size / 1024 / 1024).toFixed(1)} MB)`);
  }
}

if (failed > 0) {
  console.error(`\n${failed} file(s) failed to upload.`);
  process.exit(1);
}

console.log('\nScene sync complete.');
