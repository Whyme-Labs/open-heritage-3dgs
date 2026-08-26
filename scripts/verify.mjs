import { access, readFile, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const required = [
  'index.html',
  'src/app.js',
  'src/styles.css',
  'public/scenes.json',
  'package.json',
  'setup.sh',
  'download_scenes.sh',
  'vite.config.ts',
  'wrangler.jsonc',
  'worker/index.ts',
  'README.md',
  'ATTRIBUTION.md',
  'SOURCE_REVIEW.md',
  'THIRD_PARTY.md',
  'VALIDATION.md',
  'scripts/build-viewer.mjs',
  'scripts/sync-scenes-r2.mjs',
  'scripts/prepare-scene.sh',
  'scripts/viewer-controls.js',
  'scripts/viewer-controls.css'
];

const failures = [];
const readText = (path) => readFile(resolve(root, path), 'utf8');

for (const file of required) {
  try {
    await access(resolve(root, file), constants.R_OK);
  } catch {
    failures.push(`Missing: ${file}`);
  }
}

let manifest;
try {
  manifest = JSON.parse(await readText('public/scenes.json'));
} catch (error) {
  failures.push(`Invalid public/scenes.json: ${error.message}`);
}

if (manifest) {
  if (manifest.version !== 2) failures.push(`Expected scenes.json version 2, got ${manifest.version}`);
  if (!Array.isArray(manifest.scenes) || manifest.scenes.length < 1) failures.push('No scenes in scenes.json');

  const slugs = new Set();
  for (const scene of manifest.scenes ?? []) {
    if (!scene.slug || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(scene.slug)) {
      failures.push(`Invalid scene slug: ${scene.slug ?? '(missing)'}`);
    }
    if (slugs.has(scene.slug)) failures.push(`Duplicate slug: ${scene.slug}`);
    slugs.add(scene.slug);

    if (!Array.isArray(scene.assets) || scene.assets.length < 1) {
      failures.push(`No assets for ${scene.slug}`);
    } else {
      for (const asset of scene.assets) {
        if (typeof asset.path !== 'string' || !asset.path.startsWith(`scenes/${scene.slug}.`)) {
          failures.push(`Unexpected asset path for ${scene.slug}: ${asset.path}`);
        }
      }
    }

    for (const collision of scene.collision ?? []) {
      if (typeof collision.path !== 'string' || !collision.path.startsWith(`scenes/${scene.slug}.`)) {
        failures.push(`Unexpected collision path for ${scene.slug}: ${collision.path}`);
      }
    }

    const boundaryPath = scene.boundary?.path;
    if (!boundaryPath?.startsWith('boundaries/')) {
      failures.push(`Invalid boundary path for ${scene.slug}: ${boundaryPath}`);
      continue;
    }

    try {
      const boundary = JSON.parse(await readText(`public/${boundaryPath}`));
      if (boundary.version !== 1) failures.push(`Boundary version must be 1 for ${scene.slug}`);
      if (!['auto', 'box', 'polygon'].includes(boundary.type)) {
        failures.push(`Unsupported boundary type for ${scene.slug}: ${boundary.type}`);
      }
      for (const key of ['padding', 'verticalPadding']) {
        if (boundary[key] !== undefined && (!Number.isFinite(boundary[key]) || boundary[key] < 0 || boundary[key] >= 0.5)) {
          failures.push(`${key} must be in [0, 0.5) for ${scene.slug}`);
        }
      }
      if (boundary.type === 'box') {
        if (!Array.isArray(boundary.min) || !Array.isArray(boundary.max) || boundary.min.length !== 3 || boundary.max.length !== 3) {
          failures.push(`Manual box is malformed for ${scene.slug}`);
        }
      }
      if (boundary.type === 'polygon' && (!Array.isArray(boundary.points) || boundary.points.length < 3)) {
        failures.push(`Manual polygon needs at least three points for ${scene.slug}`);
      }
    } catch (error) {
      failures.push(`Invalid boundary file for ${scene.slug}: ${error.message}`);
    }
  }
}

try {
  const packageJson = JSON.parse(await readText('package.json'));
  const expected = {
    '@playcanvas/splat-transform': '3.3.0',
    '@playcanvas/supersplat-viewer': '1.29.3',
    playcanvas: '2.21.4'
  };
  for (const [name, version] of Object.entries(expected)) {
    if (packageJson.dependencies?.[name] !== version) {
      failures.push(`Expected ${name}@${version}, got ${packageJson.dependencies?.[name] ?? '(missing)'}`);
    }
  }
  for (const name of ['vite', '@cloudflare/vite-plugin', 'wrangler', '@cloudflare/workers-types']) {
    if (!packageJson.devDependencies?.[name]) {
      failures.push(`Missing devDependency: ${name}`);
    }
  }
} catch (error) {
  failures.push(`Invalid package.json: ${error.message}`);
}

try {
  const worker = await readText('worker/index.ts');
  for (const token of ['SCENES', 'Accept-Ranges', '206', 'head(key)']) {
    if (!worker.includes(token)) failures.push(`Scene worker missing expected token: ${token}`);
  }
  const wrangler = await readText('wrangler.jsonc');
  for (const token of ['"run_worker_first"', '/scenes/*', '"SCENES"', 'r2_buckets']) {
    if (!wrangler.includes(token)) failures.push(`wrangler.jsonc missing expected token: ${token}`);
  }
} catch (error) {
  failures.push(`Could not inspect worker sources: ${error.message}`);
}

try {
  const app = await readText('src/app.js');
  for (const token of ['budget', 'boundary', 'collision', 'scene', 'webgl']) {
    if (!app.includes(token)) failures.push(`Main app missing expected viewer parameter token: ${token}`);
  }
  const controls = await readText('scripts/viewer-controls.js');
  for (const token of ['insetBox', 'expandBox', 'nearestPointOnPolygon', 'collisionAvailable', 'KeyW']) {
    if (!controls.includes(token)) failures.push(`Viewer controls missing expected implementation token: ${token}`);
  }
} catch (error) {
  failures.push(`Could not inspect application sources: ${error.message}`);
}

try {
  await access(resolve(root, 'public/viewer/index.html'), constants.R_OK);
  const viewerHtml = await readText('public/viewer/index.html');
  for (const token of ['prototype-controls-module', 'prototype-controls-style']) {
    if (!viewerHtml.includes(token)) failures.push(`Built viewer missing ${token}`);
  }
  for (const file of ['public/viewer/index.css', 'public/viewer/index.js', 'public/viewer/settings.json']) {
    const info = await stat(resolve(root, file));
    if (!info.isFile() || info.size === 0) failures.push(`Built viewer file is empty: ${file}`);
  }
  console.log('Viewer bundle: built');
} catch {
  console.log('Viewer bundle: not built yet, run ./setup.sh');
}

if (failures.length) {
  console.error('\nValidation failed:');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exitCode = 1;
} else {
  console.log('Prototype validation passed.');
  console.log(`Scenes: ${manifest.scenes.length}`);
}
