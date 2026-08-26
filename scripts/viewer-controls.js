const query = new URLSearchParams(location.search);
const boundaryUrl = query.get('boundary');
const collisionRequested = query.has('collision') || query.has('voxel');
const sceneId = query.get('scene') ?? '';
const forceMobile = query.get('mobileControls') === '1';
const coarsePointer = matchMedia('(pointer: coarse)').matches;
const mobileUiEnabled = forceMobile || coarsePointer || innerWidth <= 900;

const DEFAULT_BOUNDARY = Object.freeze({
  version: 1,
  enabled: true,
  type: 'auto',
  padding: 0.06,
  verticalPadding: 0.1,
  orbitPadding: 0.55,
  maxOrbitDistanceScale: 1.8,
  minOrbitDistanceScale: 0.005,
  boundaryHaptics: true
});

const runtime = {
  ready: false,
  config: { ...DEFAULT_BOUNDARY },
  rawBox: null,
  firstPersonBox: null,
  orbitBox: null,
  polygon: null,
  initialCamera: null,
  lastCameraMode: '',
  lastBoundaryNotice: 0,
  lookDelta: { x: 0, y: 0 },
  heldKeys: new Set(),
  speedMode: 1,
  joystickActive: false,
  collisionAvailable: false,
  status: {
    renderer: 'Starting',
    boundary: 'Waiting'
  }
};

const cloneCamera = (camera) => ({
  position: [...camera.position],
  angles: [...camera.angles],
  distance: camera.distance,
  fov: camera.fov,
  mode: camera.mode
});

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const length3 = (v) => Math.hypot(v[0], v[1], v[2]);

const root = document.createElement('div');
root.id = 'prototype-controls';
root.innerHTML = `
  <div class="prototype-status" role="status" aria-live="polite">
    <span class="prototype-chip" data-role="renderer"><i></i><b>Renderer</b><span>Starting</span></span>
    <span class="prototype-chip" data-role="boundary"><i></i><b>Boundary</b><span>Waiting</span></span>
    <button type="button" class="prototype-compact-button" data-action="copy-position" aria-label="Copy current camera coordinates">XYZ</button>
  </div>

  <div class="prototype-mobile ${mobileUiEnabled ? 'is-enabled' : ''}" aria-label="Mobile scene controls">
    <div class="prototype-mobile-actions">
      <button type="button" data-action="mode">Orbit</button>
      <button type="button" data-action="speed">Normal</button>
      <button type="button" data-action="reset">Reset</button>
      <button type="button" data-action="fullscreen" aria-label="Toggle fullscreen">Full</button>
    </div>

    <div class="prototype-stick" data-control="move" aria-label="Movement joystick">
      <div class="prototype-stick-ring"></div>
      <div class="prototype-stick-knob"></div>
      <span>Move</span>
    </div>

    <div class="prototype-look-pad" data-control="look" aria-label="Look around">
      <span>Look</span>
    </div>

    <div class="prototype-vertical">
      <button type="button" data-action="up" aria-label="Move up or jump">▲</button>
      <button type="button" data-action="down" aria-label="Move down">▼</button>
    </div>
  </div>

  <div class="prototype-toast" role="status" aria-live="assertive"></div>
`;
document.documentElement.classList.toggle('prototype-mobile-enabled', mobileUiEnabled);
document.body.appendChild(root);

const rendererChip = root.querySelector('[data-role="renderer"] span');
const boundaryChip = root.querySelector('[data-role="boundary"] span');
const rendererDot = root.querySelector('[data-role="renderer"] i');
const boundaryDot = root.querySelector('[data-role="boundary"] i');
const modeButton = root.querySelector('[data-action="mode"]');
const speedButton = root.querySelector('[data-action="speed"]');
const toastElement = root.querySelector('.prototype-toast');

const notifyParent = (payload) => {
  try {
    parent.postMessage({ source: 'open-heritage-3dgs', scene: sceneId, ...payload }, location.origin);
  } catch {
    // Same-origin parent messaging is optional.
  }
};

const showToast = (text, duration = 1500) => {
  toastElement.textContent = text;
  toastElement.classList.add('is-visible');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toastElement.classList.remove('is-visible'), duration);
};

const updateStatus = () => {
  rendererChip.textContent = runtime.status.renderer;
  boundaryChip.textContent = runtime.status.boundary;
  rendererDot.dataset.state = runtime.status.renderer.toLowerCase().includes('webgpu') ? 'good' : 'fallback';
  boundaryDot.dataset.state = runtime.ready && runtime.config.enabled ? 'good' : 'fallback';
};

const waitFor = async (predicate, timeoutMs = 60000, intervalMs = 100) => {
  const start = performance.now();
  while (performance.now() - start < timeoutMs) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error('Timed out while waiting for the viewer');
};

const transformPoint = (matrix, point) => {
  const [x, y, z] = point;
  return [
    matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12],
    matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13],
    matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14]
  ];
};

const deriveSceneBox = () => {
  const app = window.app;
  const entity = app?.root?.findByName?.('gsplat');
  const aabb = entity?.gsplat?.customAabb;
  const center = aabb?.center;
  const half = aabb?.halfExtents;
  if (!entity || !center || !half) return null;
  if (![center.x, center.y, center.z, half.x, half.y, half.z].every(Number.isFinite)) return null;
  if (half.x <= 0 && half.y <= 0 && half.z <= 0) return null;

  const matrix = entity.getWorldTransform().data;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];

  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const local = [
          center.x + sx * half.x,
          center.y + sy * half.y,
          center.z + sz * half.z
        ];
        const world = transformPoint(matrix, local);
        for (let axis = 0; axis < 3; axis += 1) {
          min[axis] = Math.min(min[axis], world[axis]);
          max[axis] = Math.max(max[axis], world[axis]);
        }
      }
    }
  }

  return { min, max };
};

const expandBox = (box, horizontalFraction, verticalFraction = horizontalFraction) => {
  const size = box.max.map((value, axis) => Math.max(1e-5, value - box.min[axis]));
  const horizontalPad = [
    Math.max(size[0] * horizontalFraction, 0.02),
    Math.max(size[1] * verticalFraction, 0.02),
    Math.max(size[2] * horizontalFraction, 0.02)
  ];
  return {
    min: box.min.map((value, axis) => value - horizontalPad[axis]),
    max: box.max.map((value, axis) => value + horizontalPad[axis])
  };
};

const insetBox = (box, horizontalFraction, verticalFraction = horizontalFraction) => {
  const size = box.max.map((value, axis) => Math.max(1e-5, value - box.min[axis]));
  const hf = clamp(Number(horizontalFraction) || 0, 0, 0.45);
  const vf = clamp(Number(verticalFraction) || 0, 0, 0.45);
  const inset = [size[0] * hf, size[1] * vf, size[2] * hf];
  return {
    min: box.min.map((value, axis) => value + inset[axis]),
    max: box.max.map((value, axis) => value - inset[axis])
  };
};

const normalizeBox = (candidate) => {
  if (!candidate || !Array.isArray(candidate.min) || !Array.isArray(candidate.max)) return null;
  if (candidate.min.length !== 3 || candidate.max.length !== 3) return null;
  const min = candidate.min.map(Number);
  const max = candidate.max.map(Number);
  if (![...min, ...max].every(Number.isFinite)) return null;
  for (let axis = 0; axis < 3; axis += 1) {
    if (max[axis] <= min[axis]) return null;
  }
  return { min, max };
};

const loadBoundaryConfig = async () => {
  if (!boundaryUrl) return { ...DEFAULT_BOUNDARY };
  try {
    const response = await fetch(boundaryUrl, { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const custom = await response.json();
    return { ...DEFAULT_BOUNDARY, ...custom };
  } catch (error) {
    console.warn('Boundary config could not be loaded. Falling back to automatic bounds.', error);
    return { ...DEFAULT_BOUNDARY };
  }
};

const configureBoundary = async () => {
  runtime.config = await loadBoundaryConfig();

  let rawBox = null;
  if (runtime.config.type === 'box') rawBox = normalizeBox(runtime.config);
  if (!rawBox) {
    rawBox = await waitFor(deriveSceneBox, 60000, 125);
  }
  runtime.rawBox = rawBox;

  runtime.firstPersonBox = insetBox(
    rawBox,
    Number(runtime.config.padding) || 0,
    Number(runtime.config.verticalPadding) || 0
  );
  runtime.orbitBox = expandBox(
    rawBox,
    Number(runtime.config.orbitPadding) || 0,
    Number(runtime.config.orbitPadding) || 0
  );

  if (runtime.config.type === 'polygon' && Array.isArray(runtime.config.points) && runtime.config.points.length >= 3) {
    const points = runtime.config.points
      .map((point) => [Number(point[0]), Number(point[1])])
      .filter((point) => point.every(Number.isFinite));
    if (points.length >= 3) {
      runtime.polygon = points;
      if (Number.isFinite(runtime.config.minY)) runtime.firstPersonBox.min[1] = Number(runtime.config.minY);
      if (Number.isFinite(runtime.config.maxY)) runtime.firstPersonBox.max[1] = Number(runtime.config.maxY);
    }
  }

  const size = rawBox.max.map((value, axis) => value - rawBox.min[axis]);
  runtime.diagonal = Math.max(0.01, length3(size));
  runtime.status.boundary = runtime.config.enabled
    ? `${runtime.config.type === 'auto' ? 'Auto' : 'Manual'} geofence`
    : 'Disabled';
};

const pointInPolygon = (x, z, polygon) => {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, zi] = polygon[i];
    const [xj, zj] = polygon[j];
    const intersect = zi > z !== zj > z &&
      x < ((xj - xi) * (z - zi)) / ((zj - zi) || Number.EPSILON) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
};

const nearestPointOnPolygon = (x, z, polygon) => {
  let best = [x, z];
  let bestDistanceSq = Infinity;
  for (let i = 0; i < polygon.length; i += 1) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const lengthSq = dx * dx + dz * dz;
    const t = lengthSq > 0
      ? clamp(((x - a[0]) * dx + (z - a[1]) * dz) / lengthSq, 0, 1)
      : 0;
    const px = a[0] + t * dx;
    const pz = a[1] + t * dz;
    const distanceSq = (x - px) ** 2 + (z - pz) ** 2;
    if (distanceSq < bestDistanceSq) {
      bestDistanceSq = distanceSq;
      best = [px, pz];
    }
  }
  return best;
};

const boundaryNotice = () => {
  const now = performance.now();
  if (now - runtime.lastBoundaryNotice < 700) return;
  runtime.lastBoundaryNotice = now;
  showToast('Boundary reached');
  if (runtime.config.boundaryHaptics && navigator.vibrate) navigator.vibrate(18);
  notifyParent({ type: 'boundary-hit' });
};

const enforceBoundary = (snapshot, notify = true) => {
  if (!runtime.ready || !runtime.config.enabled || !runtime.firstPersonBox || !runtime.orbitBox) {
    return { snapshot, changed: false };
  }

  const next = cloneCamera(snapshot);
  const firstPerson = next.mode === 'walk' || next.mode === 'fly';
  const box = firstPerson ? runtime.firstPersonBox : runtime.orbitBox;
  let changed = false;

  for (let axis = 0; axis < 3; axis += 1) {
    const clamped = clamp(next.position[axis], box.min[axis], box.max[axis]);
    if (Math.abs(clamped - next.position[axis]) > 1e-5) {
      next.position[axis] = clamped;
      changed = true;
    }
  }

  if (firstPerson && runtime.polygon && !pointInPolygon(next.position[0], next.position[2], runtime.polygon)) {
    const [x, z] = nearestPointOnPolygon(next.position[0], next.position[2], runtime.polygon);
    next.position[0] = x;
    next.position[2] = z;
    changed = true;
  }

  if (!firstPerson) {
    const minDistance = runtime.diagonal * Number(runtime.config.minOrbitDistanceScale || 0);
    const maxDistance = runtime.diagonal * Number(runtime.config.maxOrbitDistanceScale || 1.8);
    const distance = clamp(next.distance, minDistance, maxDistance);
    if (Math.abs(distance - next.distance) > 1e-5) {
      next.distance = distance;
      changed = true;
    }
  }

  if (changed && notify) boundaryNotice();
  return { snapshot: next, changed };
};

const KEY_NAMES = new Map([
  ['KeyW', 'w'],
  ['KeyA', 'a'],
  ['KeyS', 's'],
  ['KeyD', 'd'],
  ['KeyQ', 'q'],
  ['KeyE', 'e'],
  ['Space', ' '],
  ['ShiftLeft', 'Shift'],
  ['ControlLeft', 'Control'],
  ['Digit1', '1'],
  ['Digit2', '2'],
  ['Digit3', '3']
]);

const dispatchKey = (code, isDown) => {
  const event = new KeyboardEvent(isDown ? 'keydown' : 'keyup', {
    code,
    key: KEY_NAMES.get(code) ?? '',
    bubbles: true,
    cancelable: true
  });
  window.dispatchEvent(event);
};

const setHeldKey = (code, shouldHold) => {
  const isHeld = runtime.heldKeys.has(code);
  if (shouldHold === isHeld) return;
  if (shouldHold) runtime.heldKeys.add(code);
  else runtime.heldKeys.delete(code);
  dispatchKey(code, shouldHold);
};

const releaseMovementKeys = () => {
  for (const code of [...runtime.heldKeys]) {
    setHeldKey(code, false);
  }
};

const syncSpeedModifier = () => {
  setHeldKey('ControlLeft', runtime.joystickActive && runtime.speedMode === 0);
  setHeldKey('ShiftLeft', runtime.joystickActive && runtime.speedMode === 2);
};

const syncMoveKeys = (x, y) => {
  const deadzone = 0.18;
  runtime.joystickActive = Math.abs(x) > deadzone || Math.abs(y) > deadzone;
  setHeldKey('KeyW', y > deadzone);
  setHeldKey('KeyS', y < -deadzone);
  setHeldKey('KeyD', x > deadzone);
  setHeldKey('KeyA', x < -deadzone);
  syncSpeedModifier();
};

const bindJoystick = () => {
  const pad = root.querySelector('[data-control="move"]');
  const knob = pad.querySelector('.prototype-stick-knob');
  let pointerId = null;

  const update = (event) => {
    const rect = pad.getBoundingClientRect();
    const radius = Math.max(1, Math.min(rect.width, rect.height) * 0.34);
    let x = (event.clientX - (rect.left + rect.width / 2)) / radius;
    let y = ((rect.top + rect.height / 2) - event.clientY) / radius;
    const magnitude = Math.hypot(x, y);
    if (magnitude > 1) {
      x /= magnitude;
      y /= magnitude;
    }
    knob.style.transform = `translate(calc(-50% + ${x * radius}px), calc(-50% + ${-y * radius}px))`;
    syncMoveKeys(x, y);
  };

  const end = (event) => {
    if (pointerId !== null && event.pointerId !== pointerId) return;
    pointerId = null;
    knob.style.transform = 'translate(-50%, -50%)';
    syncMoveKeys(0, 0);
  };

  pad.addEventListener('pointerdown', (event) => {
    pointerId = event.pointerId;
    pad.setPointerCapture(event.pointerId);
    update(event);
  });
  pad.addEventListener('pointermove', (event) => {
    if (event.pointerId === pointerId) update(event);
  });
  pad.addEventListener('pointerup', end);
  pad.addEventListener('pointercancel', end);
  pad.addEventListener('lostpointercapture', end);
};

const bindLookPad = () => {
  const pad = root.querySelector('[data-control="look"]');
  let pointerId = null;
  let previous = null;

  const end = (event) => {
    if (pointerId !== null && event.pointerId !== pointerId) return;
    pointerId = null;
    previous = null;
    pad.classList.remove('is-active');
  };

  pad.addEventListener('pointerdown', (event) => {
    pointerId = event.pointerId;
    previous = [event.clientX, event.clientY];
    pad.setPointerCapture(event.pointerId);
    pad.classList.add('is-active');
  });
  pad.addEventListener('pointermove', (event) => {
    if (event.pointerId !== pointerId || !previous) return;
    runtime.lookDelta.x += event.clientX - previous[0];
    runtime.lookDelta.y += event.clientY - previous[1];
    previous = [event.clientX, event.clientY];
  });
  pad.addEventListener('pointerup', end);
  pad.addEventListener('pointercancel', end);
  pad.addEventListener('lostpointercapture', end);
};

const pulseKey = (code) => {
  dispatchKey(code, true);
  requestAnimationFrame(() => dispatchKey(code, false));
};

const cycleMode = () => {
  if (!window.getCameraState || !window.setCameraState) return;
  const current = window.getCameraState();
  const modes = runtime.collisionAvailable ? ['orbit', 'fly', 'walk'] : ['orbit', 'fly'];
  const index = modes.indexOf(current.mode);
  current.mode = modes[(index + 1 + modes.length) % modes.length];
  window.setCameraState(current);
};

const bindButtons = () => {
  root.querySelector('[data-action="mode"]').addEventListener('click', cycleMode);

  root.querySelector('[data-action="speed"]').addEventListener('click', () => {
    runtime.speedMode = (runtime.speedMode + 1) % 3;
    const labels = ['Slow', 'Normal', 'Fast'];
    speedButton.textContent = labels[runtime.speedMode];
    syncSpeedModifier();
  });

  root.querySelector('[data-action="reset"]').addEventListener('click', () => {
    if (!runtime.initialCamera || !window.setCameraState) return;
    releaseMovementKeys();
    window.setCameraState(cloneCamera(runtime.initialCamera));
    showToast('Camera reset');
  });

  root.querySelector('[data-action="fullscreen"]').addEventListener('click', async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch (error) {
      console.warn('Fullscreen request failed', error);
    }
  });

  root.querySelector('[data-action="copy-position"]').addEventListener('click', async () => {
    if (!window.getCameraState) return;
    const cameraState = window.getCameraState();
    const [x, y, z] = cameraState.position;
    const text = `${x.toFixed(4)},${y.toFixed(4)},${z.toFixed(4)}`;
    try {
      await navigator.clipboard.writeText(text);
      showToast(cameraState.mode === 'orbit' ? `Copied camera position. Use Fly/Walk for SEED_POS: ${text}` : `Copied SEED_POS=${text}`, 2600);
    } catch {
      showToast(cameraState.mode === 'orbit' ? `Use Fly/Walk for SEED_POS: ${text}` : `SEED_POS=${text}`, 3000);
    }
  });

  const up = root.querySelector('[data-action="up"]');
  const down = root.querySelector('[data-action="down"]');

  const startVertical = (direction) => {
    const mode = window.getCameraState?.().mode;
    if (direction === 'up') setHeldKey(mode === 'walk' ? 'Space' : 'KeyE', true);
    else if (mode !== 'walk') setHeldKey('KeyQ', true);
  };
  const stopVertical = () => {
    setHeldKey('Space', false);
    setHeldKey('KeyE', false);
    setHeldKey('KeyQ', false);
  };

  for (const [button, direction] of [[up, 'up'], [down, 'down']]) {
    button.addEventListener('pointerdown', (event) => {
      button.setPointerCapture(event.pointerId);
      startVertical(direction);
    });
    button.addEventListener('pointerup', stopVertical);
    button.addEventListener('pointercancel', stopVertical);
    button.addEventListener('lostpointercapture', stopVertical);
  }
};

const updateLook = () => {
  if (!window.getCameraState || !window.setCameraState) return;
  const dx = runtime.lookDelta.x;
  const dy = runtime.lookDelta.y;
  if (Math.abs(dx) < 0.001 && Math.abs(dy) < 0.001) return;
  runtime.lookDelta.x = 0;
  runtime.lookDelta.y = 0;

  const camera = window.getCameraState();
  if (camera.mode === 'orbit') camera.mode = runtime.collisionAvailable ? 'walk' : 'fly';
  camera.angles[1] -= dx * 0.13;
  camera.angles[0] = clamp(camera.angles[0] - dy * 0.13, -88, 88);
  const bounded = enforceBoundary(camera, false);
  window.setCameraState(bounded.snapshot);
};

const frame = () => {
  if (runtime.ready && window.getCameraState && window.setCameraState) {
    updateLook();

    const current = window.getCameraState();
    if (current.mode !== runtime.lastCameraMode) {
      runtime.lastCameraMode = current.mode;
      modeButton.textContent = current.mode[0].toUpperCase() + current.mode.slice(1);
    }

    const bounded = enforceBoundary(current, true);
    if (bounded.changed) window.setCameraState(bounded.snapshot);
  }
  requestAnimationFrame(frame);
};

const init = async () => {
  try {
    await waitFor(() => window.app && window.getCameraState && window.setCameraState, 60000, 100);
    runtime.initialCamera = cloneCamera(window.getCameraState());
    const walkButton = document.getElementById('fpsCamera');
    runtime.collisionAvailable = Boolean(
      collisionRequested && walkButton && !walkButton.classList.contains('hidden')
    );

    const deviceType = window.app?.graphicsDevice?.deviceType;
    runtime.status.renderer = deviceType === 'webgpu' ? 'WebGPU active' : 'WebGL2 fallback';

    await configureBoundary();
    runtime.ready = true;
    updateStatus();

    const initialBounded = enforceBoundary(window.getCameraState(), false);
    if (initialBounded.changed) window.setCameraState(initialBounded.snapshot);

    notifyParent({
      type: 'viewer-ready',
      renderer: runtime.status.renderer,
      boundary: runtime.status.boundary,
      collision: runtime.collisionAvailable,
      collisionRequested
    });
  } catch (error) {
    console.error('Prototype controls failed to initialize', error);
    runtime.status.boundary = 'Unavailable';
    updateStatus();
    notifyParent({ type: 'viewer-error', message: String(error) });
  }
};

bindJoystick();
bindLookPad();
bindButtons();
updateStatus();
requestAnimationFrame(frame);
init();

addEventListener('blur', releaseMovementKeys);
addEventListener('pagehide', releaseMovementKeys);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) releaseMovementKeys();
});
