#!/usr/bin/env bash
# Cut a large map into a deep-zoom tile pyramid with libvips.
# Usage: tools/cut-tiles.sh <map-image> [output-dir] [tile-size]
# Output: <output-dir>.dzi plus <output-dir>_files/<level>/<col>_<row>.webp
# Upload the result to the Forge Assets Library, not to this repo.
set -euo pipefail

src="${1:?usage: cut-tiles.sh <map-image> [output-dir] [tile-size]}"
out="${2:-tiles/$(basename "${src%.*}")}"
size="${3:-512}"

command -v vips >/dev/null || { echo "vips not found: sudo apt install libvips-tools" >&2; exit 1; }

mkdir -p "$(dirname "$out")"
vips dzsave "$src" "$out" --tile-size "$size" --overlap 0 --suffix .webp[Q=80]
echo "Tiles written to ${out}_files/ (manifest: ${out}.dzi)"
