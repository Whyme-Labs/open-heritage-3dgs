#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

SLUG="${1:-}"
SCENE_TYPE="${2:-auto}"

if [ -z "$SLUG" ]; then
  cat >&2 <<'EOF'
Usage:
  npm run prepare:scene -- <slug> [auto|interior|exterior]

Examples:
  npm run prepare:scene -- pantheon-interior interior
  npm run prepare:scene -- christchurch-castle exterior

Environment:
  INPUT=path/to/source.ply
  VOXEL_SIZE=0.08
  VOXEL_OPACITY=0.12
  SEED_POS=x,y,z
  SKIP_COLLISION=1
  FORCE_CPU=1
EOF
  exit 2
fi

TOOL="$ROOT/node_modules/.bin/splat-transform"
if [ ! -x "$TOOL" ]; then
  printf 'SplatTransform is not installed. Run ./setup.sh first.\n' >&2
  exit 1
fi

INPUT="${INPUT:-$ROOT/scenes/$SLUG.ply}"
if [ ! -f "$INPUT" ]; then
  printf 'Input not found: %s\n' "$INPUT" >&2
  exit 1
fi

SOG="$ROOT/scenes/$SLUG.sog"
VOXEL="$ROOT/scenes/$SLUG.voxel.json"
COLLISION="$ROOT/scenes/$SLUG.collision.glb"
VOXEL_SIZE="${VOXEL_SIZE:-0.08}"
VOXEL_OPACITY="${VOXEL_OPACITY:-0.12}"
SEED_POS="${SEED_POS:-}"
SKIP_COLLISION="${SKIP_COLLISION:-0}"
FORCE_CPU="${FORCE_CPU:-0}"

printf '\n[1/2] Converting to bundled SOG for web delivery\n'
if [ "$FORCE_CPU" = "1" ]; then
  "$TOOL" -w -g cpu "$INPUT" "$SOG"
else
  if ! "$TOOL" -w "$INPUT" "$SOG"; then
    printf '\nGPU SOG conversion failed. Retrying on CPU.\n' >&2
    "$TOOL" -w -g cpu "$INPUT" "$SOG"
  fi
fi

if [ "$SKIP_COLLISION" = "1" ]; then
  printf '\n[2/2] Collision generation skipped by SKIP_COLLISION=1\n'
  exit 0
fi

printf '\n[2/2] Generating voxel collision and GLB collision mesh\n'
ARGS=(
  -w
  --voxel-size "$VOXEL_SIZE"
  --voxel-opacity "$VOXEL_OPACITY"
  --collision-mesh smooth
)

case "$SCENE_TYPE" in
  interior)
    if [ -z "$SEED_POS" ]; then
      cat >&2 <<EOF

Interior collision needs a seed point that is visibly inside navigable space.
No SEED_POS was supplied, so I will generate a basic voxel collision without
external fill or carving. For a better result, inspect the camera position in
the viewer and rerun:

  SEED_POS=x,y,z npm run prepare:scene -- $SLUG interior
EOF
    else
      ARGS+=(--seed-pos "$SEED_POS" --voxel-external-fill --voxel-carve)
    fi
    ;;
  exterior)
    ARGS+=(--voxel-floor-fill)
    ;;
  auto)
    ;;
  *)
    printf 'Unknown scene type: %s\n' "$SCENE_TYPE" >&2
    exit 2
    ;;
esac

if ! "$TOOL" "${ARGS[@]}" "$INPUT" "$VOXEL"; then
  cat >&2 <<EOF

Collision generation failed. This step is GPU-only in current SplatTransform.
The SOG file is still valid and the runtime camera boundary will still work.

You can retry on a machine with WebGPU/Vulkan support, or keep using the scene
without a collision file.
EOF
  exit 0
fi

printf '\nPrepared scene assets:\n'
printf '  %s\n' "$SOG"
printf '  %s\n' "$VOXEL"
if [ -f "$COLLISION" ]; then
  printf '  %s\n' "$COLLISION"
fi
