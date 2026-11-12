# Tile Cartography

Foundry VTT (v13) module that shows a large scene background as a zoom-level tile pyramid, like a web map. Instead of loading one huge image, it loads a small overview first and streams in detail tiles as you pan and zoom.

Status: **all six roadmap steps done.** It draws the overview level of a scene's tile pyramid over its background, then streams in the tiles on screen at the level that matches the current zoom. It loads ahead of drags and animated pans, fades new tiles in, and frees tiles that are no longer needed.

## Using it

1. Cut the map with `tools/cut-tiles.sh` and upload the output folder to the Forge Assets Library (see below).
2. In the scene's **Configure** sheet (Basics tab), pick the `.dzi` file in **Tile map (.dzi)**.
3. Click **Fit scene to map** to set the scene size to the map's size and the background to the overview image, then save. That background is what players see while tile maps are off.

Each user can turn tile maps off in **Configure Settings → Tile Cartography → Draw tile maps** (for example on a slow machine). It affects only that user.

To see what is loaded (tiles per level, approximate GPU memory), run `game.modules.get("tile-cartography").api.stats()` in the console. You can also set the tile map from the console with `await canvas.scene.setFlag("tile-cartography", "dzi", "<url to .dzi>")`.

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
2. ✅ Draw a single overview image over the scene background.
3. ✅ Load the visible detail tiles at one zoom level.
4. ✅ Switch between zoom levels as you zoom.
5. ✅ Unload tiles that go off screen.
6. ✅ Polish: fade tiles in, add a Tile map field to Scene Configuration, add an off switch with a low-res fallback background.

## Install

Manifest URL (after the first release):
`https://github.com/westhane/tile-cartography/releases/latest/download/module.json`

## Releasing

Bump nothing by hand. Create a GitHub Release tagged `vX.Y.Z`. The workflow writes that version into `module.json` and attaches the zip.
