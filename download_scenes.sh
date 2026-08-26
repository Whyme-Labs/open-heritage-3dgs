#!/usr/bin/env bash
set -u -o pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUTPUT_DIR="${OUTPUT_DIR:-$ROOT/scenes}"
TOOLS_DIR="${TOOLS_DIR:-$ROOT/.tools}"
TOOL_DIR="${TOOL_DIR:-$TOOLS_DIR/download-splat}"
TOOL_REPO="${TOOL_REPO:-https://github.com/f-g-s/download-splat.git}"
TOOL_COMMIT="${TOOL_COMMIT:-a3102e90efe2c6314a1b3e0d53c23cc1c0e2175d}"
TARGET_SPLATS="${TARGET_SPLATS:-500000}"
FORCE="${FORCE:-0}"

need() {
  command -v "$1" >/dev/null 2>&1 || {
    printf 'Missing required command: %s\n' "$1" >&2
    exit 1
  }
}

need git
need node
need npm

NODE_MAJOR="$(node -p "Number(process.versions.node.split('.')[0])")"
if [ "$NODE_MAJOR" -lt 18 ]; then
  printf 'Node.js 18 or newer is required for the downloader. Found: %s\n' "$(node --version)" >&2
  exit 1
fi

case "$TARGET_SPLATS" in
  ''|*[!0-9]*)
    printf 'TARGET_SPLATS must be a non-negative integer. Found: %s\n' "$TARGET_SPLATS" >&2
    exit 1
    ;;
esac

mkdir -p "$OUTPUT_DIR" "$TOOLS_DIR"

install_tool() {
  if [ ! -d "$TOOL_DIR/.git" ]; then
    git clone --filter=blob:none "$TOOL_REPO" "$TOOL_DIR" || return 1
  fi

  local current=""
  current="$(git -C "$TOOL_DIR" rev-parse HEAD 2>/dev/null || true)"
  if [ "$current" != "$TOOL_COMMIT" ]; then
    git -C "$TOOL_DIR" fetch --depth=1 origin "$TOOL_COMMIT" || return 1
    git -C "$TOOL_DIR" checkout --detach "$TOOL_COMMIT" || return 1
  fi

  if [ ! -f "$TOOL_DIR/dist/cli.mjs" ] || [ ! -d "$TOOL_DIR/node_modules" ]; then
    (
      cd "$TOOL_DIR" || exit 1
      npm ci || exit 1
      npm run build || exit 1
    ) || return 1
  fi
}

checksum() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    printf 'unavailable'
  fi
}

existing_asset() {
  local slug="$1"
  for suffix in ".sog" ".compressed.ply" ".ply"; do
    if [ -s "$OUTPUT_DIR/$slug$suffix" ]; then
      printf '%s' "$OUTPUT_DIR/$slug$suffix"
      return 0
    fi
  done
  return 1
}

append_log() {
  local status="$1"
  local slug="$2"
  local source="$3"
  local output="$4"
  local sha="$5"

  local log="$OUTPUT_DIR/DOWNLOAD_LOG.tsv"
  if [ ! -f "$log" ]; then
    printf 'timestamp_utc\tstatus\tslug\tsource_url\toutput_file\ttarget_splats\tsha256\n' > "$log"
  fi
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    "$status" \
    "$slug" \
    "$source" \
    "$output" \
    "$TARGET_SPLATS" \
    "$sha" >> "$log"
}

manual_download_message() {
  local slug="$1"
  local title="$2"
  local url="$3"

  cat >&2 <<EOF

$title could not be fetched through the command-line downloader.

This usually means the current SuperSplat CDN object requires browser-side
authorization or signed access. It is not a problem with your Pantheon PLY.

Manual fallback:
  1. Open $url
  2. Press Download on the scene page.
  3. Put the downloaded file in:
       $OUTPUT_DIR/
  4. Keep its real format and use one of these names:
       $slug.sog
       $slug.compressed.ply
       $slug.ply

Do not rename a SOG file to PLY or a PLY file to SOG.
EOF
}

download_scene() {
  local slug="$1"
  local id="$2"
  local title="$3"
  local creator="$4"

  local url="https://superspl.at/scene/$id"
  local output="$OUTPUT_DIR/$slug.ply"
  local cli="$TOOL_DIR/bin/cli.mjs"
  local run_log="$OUTPUT_DIR/.$slug.download.log"

  if [ "$FORCE" != "1" ]; then
    local existing=""
    if existing="$(existing_asset "$slug")"; then
      printf '\nSkipping %s\nExisting asset: %s\n' "$title" "$existing"
      append_log "skipped" "$slug" "$url" "$(basename "$existing")" "$(checksum "$existing")"
      return 10
    fi
  fi

  printf '\nDownloading %s\n' "$title"
  printf 'Source: %s\n' "$url"

  rm -f "$output" "$run_log"

  local rc
  if [ "$TARGET_SPLATS" -eq 0 ]; then
    node "$cli" --gpu cpu --overwrite "$url" "$output" 2>&1 | tee "$run_log"
    rc=${PIPESTATUS[0]}
  else
    node "$cli" --gpu cpu --overwrite "$url" -F "$TARGET_SPLATS" "$output" 2>&1 | tee "$run_log"
    rc=${PIPESTATUS[0]}
  fi

  if [ "$rc" -ne 0 ] || [ ! -s "$output" ]; then
    rm -f "$output"
    append_log "failed" "$slug" "$url" "" ""
    if grep -Eqi '403|Forbidden|401|Unauthorized' "$run_log" 2>/dev/null; then
      manual_download_message "$slug" "$title" "$url"
    else
      printf '\nDownload failed for %s. See: %s\n' "$title" "$run_log" >&2
    fi
    return 1
  fi

  local sha
  sha="$(checksum "$output")"

  local modification
  if [ "$TARGET_SPLATS" -eq 0 ]; then
    modification="Converted from the hosted SuperSplat representation to PLY without requested decimation."
  else
    modification="Converted from the hosted SuperSplat representation to PLY and decimated to $TARGET_SPLATS splats."
  fi

  cat > "$output.license.txt" <<EOF
Title: $title
Creator: $creator
Source: $url
License: Creative Commons Attribution 4.0 International
License URL: https://creativecommons.org/licenses/by/4.0/
Modification: $modification
SHA-256: $sha
EOF

  append_log "downloaded" "$slug" "$url" "$(basename "$output")" "$sha"

  printf 'Saved: %s\n' "$output"
  printf 'SHA-256: %s\n' "$sha"
  return 0
}

usage() {
  cat <<'EOF'
Usage:
  ./download_scenes.sh all
  ./download_scenes.sh pantheon-interior
  ./download_scenes.sh saka-shrine
  ./download_scenes.sh christchurch-castle
  ./download_scenes.sh dundurn-castle

Environment:
  TARGET_SPLATS=500000  Number of splats retained per scene. Use 0 for full scene.
  OUTPUT_DIR=...        Output directory.
  FORCE=1               Redownload even when a local asset already exists.

Behavior:
  "all" skips existing files and continues after an individual failure.
  A protected CDN object may require the scene page's Download button.
EOF
}

selection="${1:-all}"
case "$selection" in
  all|pantheon-interior|saka-shrine|christchurch-castle|dundurn-castle) ;;
  -h|--help) usage; exit 0 ;;
  *) usage >&2; exit 2 ;;
esac

if ! install_tool; then
  printf 'Failed to install or build the download helper.\n' >&2
  exit 1
fi

success=0
skipped=0
failed=0

run_one() {
  download_scene "$@"
  local rc=$?
  case "$rc" in
    0) success=$((success + 1)) ;;
    10) skipped=$((skipped + 1)) ;;
    *) failed=$((failed + 1)) ;;
  esac
  return "$rc"
}

case "$selection" in
  all)
    run_one "pantheon-interior" "dac6e508" "The Pantheon Interior" "artfletch" || true
    run_one "saka-shrine" "3f8c617d" "Saka Shrine" "kotohibi" || true
    run_one "christchurch-castle" "de75a082" "Christchurch Castle" "nebulousflynn" || true
    run_one "dundurn-castle" "bd8db7c2" "DUNDURN CASTLE Hamilton ON" "jeastaman" || true
    ;;
  pantheon-interior)
    run_one "pantheon-interior" "dac6e508" "The Pantheon Interior" "artfletch"
    ;;
  saka-shrine)
    run_one "saka-shrine" "3f8c617d" "Saka Shrine" "kotohibi"
    ;;
  christchurch-castle)
    run_one "christchurch-castle" "de75a082" "Christchurch Castle" "nebulousflynn"
    ;;
  dundurn-castle)
    run_one "dundurn-castle" "bd8db7c2" "DUNDURN CASTLE Hamilton ON" "jeastaman"
    ;;
esac

printf '\nDownload summary: %s downloaded, %s skipped, %s failed.\n' "$success" "$skipped" "$failed"

if [ "$selection" = "all" ]; then
  if [ $((success + skipped)) -gt 0 ]; then
    exit 0
  fi
  exit 1
fi

[ "$failed" -eq 0 ]
