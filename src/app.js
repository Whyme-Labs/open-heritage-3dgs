const elements = {
  scenePanel: document.getElementById('scenePanel'),
  sceneList: document.getElementById('sceneList'),
  menuButton: document.getElementById('menuButton'),
  drawerBackdrop: document.getElementById('drawerBackdrop'),
  viewerFrame: document.getElementById('viewerFrame'),
  stageMessage: document.getElementById('stageMessage'),
  messageTitle: document.getElementById('messageTitle'),
  messageBody: document.getElementById('messageBody'),
  messageActions: document.getElementById('messageActions'),
  sceneTitle: document.getElementById('sceneTitle'),
  sceneDescription: document.getElementById('sceneDescription'),
  sceneEyebrow: document.getElementById('sceneEyebrow'),
  sourceLink: document.getElementById('sourceLink'),
  qualitySelect: document.getElementById('qualitySelect'),
  rendererSelect: document.getElementById('rendererSelect'),
  assetStatus: document.getElementById('assetStatus'),
  rendererStatus: document.getElementById('rendererStatus'),
  boundaryStatus: document.getElementById('boundaryStatus'),
  collisionStatus: document.getElementById('collisionStatus'),
  bestFor: document.getElementById('bestFor'),
  licenseText: document.getElementById('licenseText'),
  copyCommand: document.getElementById('copyCommand')
};

const VALID_QUALITIES = new Set(['auto', 'low', 'balanced', 'high']);
const VALID_RENDERERS = new Set(['auto', 'webgl']);

const storedQuality = localStorage.getItem('heritage-quality');
const storedRenderer = localStorage.getItem('heritage-renderer');

const appState = {
  manifest: null,
  scenes: [],
  current: null,
  viewerBuilt: false,
  isMobile: matchMedia('(pointer: coarse)').matches || innerWidth <= 900,
  quality: VALID_QUALITIES.has(storedQuality) ? storedQuality : 'auto',
  renderer: VALID_RENDERERS.has(storedRenderer) ? storedRenderer : 'auto'
};

const formatBytes = (bytes) => {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 || unit === 0 ? 0 : value >= 10 ? 1 : 2)} ${units[unit]}`;
};

const head = async (path) => {
  try {
    const response = await fetch(path, { method: 'HEAD', cache: 'no-store' });
    if (!response.ok) return null;
    return {
      path,
      bytes: Number(response.headers.get('content-length')) || 0,
      contentType: response.headers.get('content-type') ?? ''
    };
  } catch {
    return null;
  }
};

const checkViewerBuild = async () => {
  try {
    const response = await fetch('./viewer/index.html', { cache: 'no-store' });
    if (!response.ok) return false;
    const text = await response.text();
    return text.includes('prototype-controls-module') && text.includes('prototype-controls-style');
  } catch {
    return false;
  }
};

const resolveScene = async (scene) => {
  const assetCandidates = [...scene.assets].sort((a, b) => a.priority - b.priority);
  let asset = null;
  for (const candidate of assetCandidates) {
    const result = await head(`./${candidate.path}`);
    if (result) {
      asset = { ...candidate, ...result };
      break;
    }
  }

  let collision = null;
  for (const candidate of scene.collision ?? []) {
    const result = await head(`./${candidate.path}`);
    if (result) {
      collision = { ...candidate, ...result };
      break;
    }
  }

  return { ...scene, resolved: { asset, collision } };
};

const showMessage = (title, body, actions = []) => {
  elements.messageTitle.textContent = title;
  elements.messageBody.textContent = body;
  elements.messageActions.textContent = '';
  for (const action of actions) {
    const node = action.href ? document.createElement('a') : document.createElement('button');
    node.className = action.primary ? 'primary-button' : 'secondary-button';
    node.textContent = action.label;
    if (action.href) {
      node.href = action.href;
      node.target = action.external ? '_blank' : '_self';
      node.rel = action.external ? 'noopener' : '';
    } else {
      node.type = 'button';
      node.addEventListener('click', action.onClick);
    }
    elements.messageActions.appendChild(node);
  }
  elements.stageMessage.classList.add('is-visible');
};

const hideMessage = () => elements.stageMessage.classList.remove('is-visible');

const getBudget = () => {
  const defaults = appState.manifest.viewer;
  const table = {
    low: 0.45,
    balanced: appState.isMobile ? 0.8 : 1.5,
    high: appState.isMobile ? 1.25 : 3
  };
  if (appState.quality === 'auto') {
    return appState.isMobile ? defaults.mobileBudgetMillions : defaults.desktopBudgetMillions;
  }
  return table[appState.quality];
};

const makeViewerUrl = (scene) => {
  const asset = scene.resolved.asset;
  const collision = scene.resolved.collision;
  const params = new URLSearchParams();

  params.set('content', `../${asset.path.replace(/^\.\//, '')}`);
  params.set('boundary', `../${scene.boundary.path.replace(/^\.\//, '')}`);
  params.set('budget', String(getBudget()));
  params.set('mobileControls', appState.isMobile ? '1' : '0');
  params.set('scene', scene.slug);
  params.append('debug', '');

  if (collision) params.set('collision', `../${collision.path.replace(/^\.\//, '')}`);
  if (appState.renderer === 'webgl') params.append('webgl', '');
  if (appState.quality === 'low') params.append('nofx', '');

  return `./viewer/index.html?${params.toString()}`;
};

const closeDrawer = () => document.body.classList.remove('drawer-open');

const renderSceneList = () => {
  elements.sceneList.textContent = '';
  for (const scene of appState.scenes) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'scene-card';
    button.dataset.slug = scene.slug;
    button.setAttribute('aria-current', String(appState.current?.slug === scene.slug));

    const ready = Boolean(scene.resolved.asset);
    const size = ready ? formatBytes(scene.resolved.asset.bytes) : 'Download required';
    button.innerHTML = `
      <span class="scene-card-status ${ready ? 'is-ready' : 'is-missing'}"></span>
      <span class="scene-card-copy">
        <b>${scene.name}</b>
        <small>${ready ? `${scene.resolved.asset.format}${size ? ` · ${size}` : ''}` : size}</small>
      </span>
      <span class="scene-card-arrow">›</span>
    `;
    button.addEventListener('click', () => {
      selectScene(scene);
      closeDrawer();
    });
    elements.sceneList.appendChild(button);
  }
};

const updateSceneMeta = (scene) => {
  elements.sceneTitle.textContent = scene.name;
  elements.sceneDescription.textContent = scene.description;
  elements.sceneEyebrow.textContent = scene.resolved.asset
    ? `${scene.resolved.asset.format} local asset`
    : 'Scene asset missing';
  elements.sourceLink.href = scene.sourcePage;
  elements.bestFor.textContent = scene.bestFor;
  elements.licenseText.textContent = `${scene.license} by ${scene.creator}`;
  elements.copyCommand.dataset.command = scene.download.command;
};

const selectScene = (scene) => {
  appState.current = scene;
  history.replaceState(null, '', `#${scene.slug}`);
  renderSceneList();
  updateSceneMeta(scene);

  elements.rendererStatus.textContent = 'Renderer: starting';
  elements.boundaryStatus.textContent = 'Boundary: starting';
  elements.collisionStatus.textContent = scene.resolved.collision
    ? `Collision: ${scene.resolved.collision.format}`
    : 'Collision: geofence only';

  if (!appState.viewerBuilt) {
    elements.viewerFrame.removeAttribute('src');
    elements.assetStatus.textContent = scene.resolved.asset
      ? `Asset: ${scene.resolved.asset.format}`
      : 'Asset: missing';
    showMessage(
      'Build the local viewer once',
      'Run ./setup.sh in this folder. It installs the pinned PlayCanvas viewer, builds the WebGPU page, and validates the prototype.',
      [
        {
          label: 'Copy setup command',
          primary: true,
          onClick: () => navigator.clipboard.writeText('./setup.sh')
        }
      ]
    );
    return;
  }

  if (!scene.resolved.asset) {
    elements.viewerFrame.removeAttribute('src');
    elements.assetStatus.textContent = 'Asset: missing';
    const body = scene.download.note
      ? `${scene.download.note} Place the downloaded file in scenes/ using this scene slug.`
      : 'Download this scene, then place it in scenes/ using this scene slug.';
    showMessage(
      'Local scene file required',
      body,
      [
        {
          label: 'Open source page',
          href: scene.sourcePage,
          external: true,
          primary: true
        },
        {
          label: 'Copy command',
          onClick: () => navigator.clipboard.writeText(scene.download.command)
        }
      ]
    );
    return;
  }

  const asset = scene.resolved.asset;
  const size = formatBytes(asset.bytes);
  elements.assetStatus.textContent = `Asset: ${asset.format}${size ? ` · ${size}` : ''}`;
  elements.viewerFrame.src = makeViewerUrl(scene);
  const rendererLabel = appState.renderer === 'webgl' ? 'WebGL2 viewer' : 'WebGPU-first viewer';
  showMessage('Loading local scene', `Opening ${asset.format}${size ? ` (${size})` : ''} with the ${rendererLabel}.`);
};

const refreshAvailability = async () => {
  appState.viewerBuilt = await checkViewerBuild();
  const checked = [];
  for (const scene of appState.manifest.scenes) {
    checked.push(await resolveScene(scene));
  }
  appState.scenes = checked;

  const requestedSlug = location.hash.slice(1);
  const requested = checked.find((scene) => scene.slug === requestedSlug);
  const firstReady = checked.find((scene) => scene.resolved.asset);
  selectScene(requested ?? firstReady ?? checked[0]);
};

elements.viewerFrame.addEventListener('load', () => {
  if (elements.viewerFrame.getAttribute('src')) hideMessage();
});

addEventListener('message', (event) => {
  if (event.origin !== location.origin || event.source !== elements.viewerFrame.contentWindow) return;
  const message = event.data;
  if (!message || message.source !== 'open-heritage-3dgs') return;
  if (message.scene && message.scene !== appState.current?.slug) return;

  if (message.type === 'viewer-ready') {
    elements.rendererStatus.textContent = `Renderer: ${message.renderer}`;
    elements.boundaryStatus.textContent = `Boundary: ${message.boundary}`;
    elements.collisionStatus.textContent = message.collision
      ? 'Collision: active'
      : 'Collision: geofence only';
    hideMessage();
  } else if (message.type === 'viewer-error') {
    elements.boundaryStatus.textContent = 'Boundary: unavailable';
  } else if (message.type === 'boundary-hit') {
    elements.boundaryStatus.classList.add('is-flashing');
    setTimeout(() => elements.boundaryStatus.classList.remove('is-flashing'), 350);
  }
});

elements.qualitySelect.value = appState.quality;
elements.rendererSelect.value = appState.renderer;

elements.qualitySelect.addEventListener('change', () => {
  appState.quality = elements.qualitySelect.value;
  localStorage.setItem('heritage-quality', appState.quality);
  if (appState.current?.resolved.asset) selectScene(appState.current);
});

elements.rendererSelect.addEventListener('change', () => {
  appState.renderer = elements.rendererSelect.value;
  localStorage.setItem('heritage-renderer', appState.renderer);
  if (appState.current?.resolved.asset) selectScene(appState.current);
});

elements.copyCommand.addEventListener('click', async () => {
  const command = elements.copyCommand.dataset.command;
  if (!command) return;
  await navigator.clipboard.writeText(command);
  const original = elements.copyCommand.textContent;
  elements.copyCommand.textContent = 'Copied';
  setTimeout(() => {
    elements.copyCommand.textContent = original;
  }, 1200);
});

elements.menuButton.addEventListener('click', () => document.body.classList.toggle('drawer-open'));
elements.drawerBackdrop.addEventListener('click', closeDrawer);
addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeDrawer();
});

try {
  const response = await fetch('./scenes.json', { cache: 'no-store' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  appState.manifest = await response.json();
  await refreshAvailability();
} catch (error) {
  console.error(error);
  showMessage('Prototype manifest failed to load', 'Start the app with npm run dev instead of opening index.html directly.');
}
