#!/usr/bin/env bash
# Cut a large map into a deep-zoom tile pyramid with libvips.
#
# Usage: tools/cut-tiles.sh [map-image] [output-dir] [tile-size] [quality]
#   No map-image given: asks for one (Tab completes paths; drag-and-drop works).
#   No quality given and run in a terminal: shows the options and asks (Enter = 75).
#   output-dir defaults to <map-name>-tiles/ next to the map; tile-size defaults to 512;
#   quality defaults to 75.
# Output: <output-dir>/<map-name>.dzi plus <output-dir>/<map-name>_files/<level>/<col>_<row>.webp
#   Levels too small to need more than one tile are removed, except the largest of them
#   (the overview); remaining levels keep standard Deep Zoom numbering.
# Upload the output folder to the Forge Assets Library, not to this repo.
set -uo pipefail

DEFAULT_QUALITY=75

self="$(readlink -f "${BASH_SOURCE[0]}")"
interactive=false

# Launched without a terminal (double-click, Run button)? Reopen in one.
if [[ ! -t 0 && -z "${CUT_TILES_IN_TERMINAL:-}" && -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]]; then
  export CUT_TILES_IN_TERMINAL=1
  if command -v gnome-terminal >/dev/null; then
    exec gnome-terminal --title="Cut map tiles" -- bash "$self" "$@"
  elif command -v x-terminal-emulator >/dev/null; then
    exec x-terminal-emulator -e bash "$self" "$@"
  fi
fi
[[ -n "${CUT_TILES_IN_TERMINAL:-}" ]] && interactive=true

# Keep the window open when launched by double-click / Run button.
finish() {
  local code=$1
  if $interactive && [[ -t 0 ]]; then
    read -rp "Press Enter to close..." _
  fi
  exit "$code"
}
fail() { echo "Error: $*" >&2; finish 1; }

src="${1:-}"
if [[ -z "$src" ]]; then
  interactive=true
  [[ -t 0 ]] || fail "no map image given (usage: cut-tiles.sh <map-image> [output-dir] [tile-size] [quality])"
  read -erp "Path to map image: " src
  # Strip quotes added by drag-and-drop, surrounding whitespace, and expand ~
  src="${src#"${src%%[![:space:]]*}"}"; src="${src%"${src##*[![:space:]]}"}"
  src="${src#[\'\"]}"; src="${src%[\'\"]}"
  [[ "$src" == "~"* ]] && src="${HOME}${src:1}"
fi

[[ -n "$src" ]] || fail "no map image given"
[[ -f "$src" ]] || fail "file not found: $src"
command -v vips >/dev/null || fail "vips not found. Install it with: sudo apt install libvips-tools"

src="$(readlink -f "$src")"
name="$(basename "${src%.*}")"
out_dir="${2:-$(dirname "$src")/$name-tiles}"
out="$out_dir/$name"
size="${3:-512}"
[[ "$size" =~ ^[0-9]+$ ]] || fail "tile size must be a number, got: $size"

quality="${4:-}"
if [[ -z "$quality" && -t 0 ]]; then
  cat <<EOF

WebP quality (1-100). Lower = smaller tiles, faster loading in Foundry:
  90  Near-lossless. Largest files; for art with fine linework or small text.
  80  High. Artifacts very hard to spot.
  75  Balanced (default). About 20% smaller than 80; fine for most maps.
  60  Small. Some blurring of fine detail and text when zoomed in.
  50  Smallest. Visible artifacts; only for very large, simple maps.
EOF
  while :; do
    read -rp "Quality [${DEFAULT_QUALITY}]: " quality
    quality="${quality//[[:space:]]/}"
    quality="${quality:-$DEFAULT_QUALITY}"
    [[ "$quality" =~ ^[0-9]+$ ]] && (( quality >= 1 && quality <= 100 )) && break
    echo "Enter a whole number from 1 to 100, or press Enter for ${DEFAULT_QUALITY}."
  done
  echo
fi
quality="${quality:-$DEFAULT_QUALITY}"
[[ "$quality" =~ ^[0-9]+$ ]] && (( quality >= 1 && quality <= 100 )) \
  || fail "quality must be a whole number from 1 to 100, got: $quality"

[[ -e "${out}.dzi" ]] && fail "tiles already exist in $out_dir (delete or move them first)"
mkdir -p "$out_dir" || fail "cannot create $out_dir"
echo "Cutting $src into ${size}px tiles at quality ${quality}..."
# effort=6: slowest, smallest WebP encoding; no visual cost. --keep none: drop metadata.
vips dzsave "$src" "$out" --tile-size "$size" --overlap 0 --keep none \
  --suffix ".webp[Q=${quality},effort=6]" \
  || fail "vips dzsave failed"

# Remove pyramid levels Foundry never shows: keep only the largest single-tile level
# (the overview) and everything above it. Also drop vips' own metadata file.
files_dir="${out}_files"
rm -f "$files_dir/vips-properties.xml"
overview=""
for level in $(ls "$files_dir" | sort -n); do
  [[ $(ls "$files_dir/$level" | wc -l) -eq 1 ]] && overview=$level
done
removed=0
for level in $(ls "$files_dir" | sort -n); do
  (( level < overview )) || break
  rm -rf "${files_dir:?}/$level"; removed=$((removed + 1))
done

count=$(find "$files_dir" -type f | wc -l)
bytes=$(du -sb "$out_dir" | cut -f1)
echo "Done: $count tiles, $(numfmt --to=iec --suffix=B "$bytes") total (removed $removed unused tiny levels)."
echo "Output folder: $out_dir/"
echo "  ${name}.dzi"
echo "  ${name}_files/   (levels ${overview}-$(ls "$files_dir" | sort -n | tail -1); level ${overview} is the overview)"
echo "Upload the whole folder to the Forge Assets Library."
finish 0
