#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

need() {
  command -v "$1" >/dev/null 2>&1 || {
    printf 'Missing required command: %s\n' "$1" >&2
    exit 1
  }
}

need node
need npm

NODE_MAJOR="$(node -p "Number(process.versions.node.split('.')[0])")"
if [ "$NODE_MAJOR" -lt 22 ]; then
  cat >&2 <<EOF
Node.js 22 or newer is required by the current SplatTransform release.
Found: $(node --version)

With nvm:
  nvm install 22
  nvm use 22
EOF
  exit 1
fi

printf '\nInstalling pinned viewer and conversion dependencies...\n'
npm install --no-audit --no-fund

printf '\nBuilding the local SuperSplat viewer...\n'
npm run build:viewer

printf '\nValidating the prototype...\n'
npm run verify

cat <<'EOF'

Setup complete.

Seed the local R2 bucket with your scene files, then start the dev server:
  npm run sync:r2
  npm run dev

Then open:
  http://localhost:5173

The app will use scenes/<slug>.sog first, then compressed PLY, then PLY.
Scene binaries are served from the R2 binding ("SCENES"), not from public/.
EOF
