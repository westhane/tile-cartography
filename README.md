# Tile Cartography

Foundry VTT (v13) module that shows a large scene background as a zoom-level tile pyramid, like a web map. Instead of loading one huge image, it loads a small overview first and streams in detail tiles as you pan and zoom.

Status: **step 1 of 6**. The module loads and logs to the console. Nothing is drawn yet.

## Layout

| Path | Purpose |
|---|---|
| `module.json` | Foundry manifest. Release CI stamps `version`, `manifest` and `download`. |
| `scripts/main.js` | Module entry point. |
| `tools/cut-tiles.sh` | Cuts a map into a WebP tile pyramid with libvips `dzsave`. |
| `.github/workflows/release.yml` | On a published release, builds `module.zip` and attaches it with `module.json`. |

## Cutting tiles

Requires libvips (`sudo apt install libvips-tools`).

Run `tools/cut-tiles.sh` with no arguments (or double-click it) and it asks for the map image. Tab completes paths, and you can drag the file into the terminal. It then lists the WebP quality options and asks for one; press Enter for the default, 75. Or pass everything directly:

```bash
tools/cut-tiles.sh path/to/world-map.png [output-dir] [tile-size] [quality]
```

Output goes to a `<map-name>-tiles/` folder next to the map image, holding `<map-name>.dzi` and `<map-name>_files/`. Tiles are 512 px WebP at maximum compression effort. Zoom levels smaller than one tile are removed, except the largest of them, which serves as the overview. The remaining levels keep standard Deep Zoom numbering, so the overview level is not 0.

Upload the whole output folder to the Forge Assets Library. Map images and tiles are git-ignored and never go into this repo.

## Roadmap

1. ✅ Module loads and logs a message.
2. Draw a single overview image under the scene.
3. Load the visible detail tiles at one zoom level.
4. Switch between zoom levels as you zoom.
5. Unload tiles that go off screen.
6. Polish: fade tiles in, add a settings panel, add an off switch with a low-res fallback background.

## Install

Manifest URL (after the first release):
`https://github.com/westhane/tile-cartography/releases/latest/download/module.json`

## Releasing

Bump nothing by hand. Create a GitHub Release tagged `vX.Y.Z`. The workflow writes that version into `module.json` and attaches the zip.
