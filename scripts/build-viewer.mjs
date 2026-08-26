import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { html, css, js } from '@playcanvas/supersplat-viewer';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const viewerDir = resolve(root, 'public', 'viewer');

await mkdir(viewerDir, { recursive: true });

const settings = {
  version: 2,
  tonemapping: 'neutral',
  highPrecisionRendering: false,
  background: {
    color: [0.025, 0.03, 0.04]
  },
  postEffectSettings: {
    sharpness: { enabled: true, amount: 0.18 },
    bloom: { enabled: false, intensity: 0.1, blurLevel: 2 },
    grading: {
      enabled: true,
      brightness: 1,
      contrast: 1.02,
      saturation: 1,
      tint: [1, 1, 1]
    },
    vignette: { enabled: false, intensity: 0.5, inner: 0.3, outer: 0.75, curvature: 1 },
    fringing: { enabled: false, intensity: 0.5 }
  },
  animTracks: [],
  cameras: [
    {
      initial: {
        position: [0, 2, 0],
        target: [2, 2, 0],
        fov: 85
      }
    }
  ],
  annotations: [],
  startMode: 'default'
};

const controlsCss = await readFile(resolve(root, 'scripts/viewer-controls.css'), 'utf8');
const controlsJs = await readFile(resolve(root, 'scripts/viewer-controls.js'), 'utf8');

const headInjection = [
  '<style id="prototype-controls-style">',
  controlsCss.replace(/<\/style/gi, '<\\/style'),
  '</style>',
  '<style>#sse-debug-panel { display: none !important; }</style>'
].join('\n');

const bodyInjection = [
  '<script type="module" id="prototype-controls-module">',
  controlsJs.replace(/<\/script/gi, '<\\/script'),
  '</script>'
].join('\n');

if (!html.includes('</head>') || !/<body\b[^>]*>/i.test(html)) {
  throw new Error('The viewer HTML template changed and no longer exposes the expected injection points.');
}

const document = html
  .replace('</head>', `${headInjection}\n</head>`)
  .replace(/<body\b([^>]*)>/i, (tag) => `${tag}\n${bodyInjection}`);

await Promise.all([
  writeFile(resolve(viewerDir, 'index.html'), document),
  writeFile(resolve(viewerDir, 'index.css'), css),
  writeFile(resolve(viewerDir, 'index.js'), js),
  writeFile(resolve(viewerDir, 'settings.json'), `${JSON.stringify(settings, null, 2)}\n`)
]);

console.log('Built local viewer:');
console.log(`  ${resolve(viewerDir, 'index.html')}`);
console.log(`  ${resolve(viewerDir, 'index.css')}`);
console.log(`  ${resolve(viewerDir, 'index.js')}`);
console.log(`  ${resolve(viewerDir, 'settings.json')}`);
