// Tile Cartography — step 3: draw the overview level of a Deep Zoom pyramid
// over the scene background, then stream in the full-resolution tiles that
// are on screen as you pan and zoom.
//
// Per scene, set the .dzi URL with:
//   await canvas.scene.setFlag("tile-cartography", "dzi", "<url to .dzi>");
const MODULE_ID = "tile-cartography";

/** How many tile requests run at once. */
const MAX_CONCURRENT_LOADS = 6;

/** Extra margin around the screen to load ahead of panning, in tiles. */
const PREFETCH_TILES = 0.5;

/**
 * State for the pyramid on the current canvas, or null.
 * @type {null | {
 *   scene: Scene, dzi: object, rect: PIXI.Rectangle, maxLevel: number,
 *   overview: PrimarySpriteMesh|null, detailLevel: number,
 *   tiles: Map<string, PrimarySpriteMesh>, loading: Set<string>, failed: Set<string>,
 *   queue: Array<{key:string, col:number, row:number}>,
 *   sortBase: {elevation:number, sortLayer:number, sort:number, zIndex:number}|null,
 *   started: number, reported: boolean
 * }}
 */
let state = null;

Hooks.once("init", () => {
  console.log(`${MODULE_ID} | init`);
});

Hooks.once("ready", () => {
  console.log(`${MODULE_ID} | ready (Foundry ${game.version})`);
});

Hooks.on("canvasReady", (canvas) => {
  setup(canvas).catch((err) => console.error(`${MODULE_ID} | failed to set up`, err));
});

Hooks.on("canvasPan", () => scheduleUpdate());

Hooks.on("canvasTearDown", () => teardown());

/* -------------------------------------------- */
/*  Deep Zoom descriptor                         */
/* -------------------------------------------- */

/**
 * Read a .dzi descriptor.
 * @param {string} url
 */
async function loadDzi(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  const xml = new DOMParser().parseFromString(await response.text(), "application/xml");
  const image = xml.querySelector("Image");
  const size = xml.querySelector("Size");
  if (!image || !size) throw new Error(`${url} is not a Deep Zoom descriptor`);
  return {
    width: Number(size.getAttribute("Width")),
    height: Number(size.getAttribute("Height")),
    tileSize: Number(image.getAttribute("TileSize")),
    overlap: Number(image.getAttribute("Overlap") ?? 0),
    format: image.getAttribute("Format") ?? "webp",
    // "<dir>/<name>.dzi" -> "<dir>/<name>_files/"
    filesUrl: url.replace(/\.dzi(\?.*)?$/i, "_files/")
  };
}

/**
 * Deep Zoom levels: the top level is ceil(log2(max dimension)) at full size, and
 * each level below halves it. The overview is the largest level that fits in one tile.
 * Levels keep their standard numbers, so the overview is usually not level 0.
 */
function overviewLevel({ width, height, tileSize }) {
  const maxDim = Math.max(width, height);
  const maxLevel = Math.ceil(Math.log2(maxDim));
  const halvings = Math.max(0, Math.ceil(Math.log2(maxDim / tileSize)));
  return Math.max(0, maxLevel - halvings);
}

/** Size of a level in its own pixels, and how many full-size pixels one of them covers. */
function levelInfo(dzi, maxLevel, level) {
  const factor = 2 ** (maxLevel - level);
  const width = Math.ceil(dzi.width / factor);
  const height = Math.ceil(dzi.height / factor);
  return {
    factor, width, height,
    cols: Math.ceil(width / dzi.tileSize),
    rows: Math.ceil(height / dzi.tileSize)
  };
}

function tileUrl(dzi, level, col, row) {
  return `${dzi.filesUrl}${level}/${col}_${row}.${dzi.format}`;
}

/* -------------------------------------------- */
/*  Setup and teardown                           */
/* -------------------------------------------- */

async function setup(canvas) {
  teardown();
  const scene = canvas.scene;
  const url = scene?.getFlag(MODULE_ID, "dzi");
  if (!url) return;

  const started = performance.now();
  const dzi = await loadDzi(url);
  if (canvas.scene !== scene) return;

  const maxLevel = Math.ceil(Math.log2(Math.max(dzi.width, dzi.height)));
  const bg = canvas.primary.background;
  state = {
    scene, dzi, maxLevel,
    rect: canvas.dimensions.sceneRect,
    overview: null,
    detailLevel: maxLevel,
    tiles: new Map(),
    loading: new Set(),
    failed: new Set(),
    queue: [],
    sortBase: bg ? { elevation: bg.elevation, sortLayer: bg.sortLayer, sort: bg.sort, zIndex: bg.zIndex } : null,
    started,
    reported: false
  };
  const current = state;

  // Detail tiles can start loading while the overview does.
  scheduleUpdate();

  const level = overviewLevel(dzi);
  const texture = await foundry.canvas.loadTexture(tileUrl(dzi, level, 0, 0));
  if (state !== current) return;
  if (!texture) throw new Error(`could not load the overview, level ${level}`);
  current.overview = addMesh(texture, 1, current.rect.x, current.rect.y, current.rect.width, current.rect.height);
  console.log(
    `${MODULE_ID} | overview level ${level} (${texture.width}×${texture.height}) of ` +
    `${dzi.width}×${dzi.height} in ${Math.round(performance.now() - started)} ms`
  );
}

function teardown() {
  if (!state) return;
  const meshes = [state.overview, ...state.tiles.values()];
  state = null;
  for (const mesh of meshes) {
    if (!mesh || mesh.destroyed) continue;
    mesh.parent?.removeChild(mesh);
    // Textures stay in Foundry's texture cache, so leave them alone.
    mesh.destroy({ children: true, texture: false, baseTexture: false });
  }
}

/**
 * Add a sprite to the primary canvas group, sorted just above the scene's own
 * background (which stays underneath as a fallback).
 * @param {number} layer  1 for the overview, 2 for detail tiles.
 */
function addMesh(texture, layer, x, y, width, height) {
  const mesh = new foundry.canvas.primary.PrimarySpriteMesh({ name: `${MODULE_ID}-${layer}`, texture });
  const base = state.sortBase;
  if (base) {
    mesh.elevation = base.elevation;
    mesh.sortLayer = base.sortLayer;
    mesh.sort = Number.isFinite(base.sort) ? base.sort + layer : base.sort;
    mesh.zIndex = base.zIndex + layer;
  }
  mesh.position.set(x, y);
  mesh.width = width;
  mesh.height = height;
  canvas.primary.addChild(mesh);
  canvas.primary.sortDirty = true;
  return mesh;
}

/* -------------------------------------------- */
/*  Visible tiles                                */
/* -------------------------------------------- */

let updateFrame = null;

/** Recompute visible tiles at most once per animation frame. */
function scheduleUpdate() {
  if (!state || updateFrame !== null) return;
  updateFrame = requestAnimationFrame(() => {
    updateFrame = null;
    updateVisibleTiles();
  });
}

/** The part of the world that is on screen. */
function viewRect() {
  const screen = canvas.app.renderer.screen;
  const tl = canvas.stage.toLocal(new PIXI.Point(0, 0));
  const br = canvas.stage.toLocal(new PIXI.Point(screen.width, screen.height));
  return { x0: tl.x, y0: tl.y, x1: br.x, y1: br.y };
}

function updateVisibleTiles() {
  if (!state) return;
  const { dzi, rect, maxLevel, detailLevel } = state;
  const info = levelInfo(dzi, maxLevel, detailLevel);

  // World units -> this level's pixels.
  const toLevelX = (dzi.width / rect.width) / info.factor;
  const toLevelY = (dzi.height / rect.height) / info.factor;
  const view = viewRect();
  const margin = PREFETCH_TILES * dzi.tileSize;
  const lx0 = (view.x0 - rect.x) * toLevelX - margin;
  const lx1 = (view.x1 - rect.x) * toLevelX + margin;
  const ly0 = (view.y0 - rect.y) * toLevelY - margin;
  const ly1 = (view.y1 - rect.y) * toLevelY + margin;

  const c0 = Math.max(0, Math.floor(lx0 / dzi.tileSize));
  const c1 = Math.min(info.cols - 1, Math.floor(lx1 / dzi.tileSize));
  const r0 = Math.max(0, Math.floor(ly0 / dzi.tileSize));
  const r1 = Math.min(info.rows - 1, Math.floor(ly1 / dzi.tileSize));

  // Queue what's missing, nearest the screen center first. Rebuilding the
  // queue drops tiles that scrolled away before their turn came.
  const cx = (lx0 + lx1) / 2 / dzi.tileSize - 0.5;
  const cy = (ly0 + ly1) / 2 / dzi.tileSize - 0.5;
  const queue = [];
  for (let row = r0; row <= r1; row++) {
    for (let col = c0; col <= c1; col++) {
      const key = `${detailLevel}/${col}_${row}`;
      if (state.tiles.has(key) || state.loading.has(key) || state.failed.has(key)) continue;
      queue.push({ key, col, row, d: (col - cx) ** 2 + (row - cy) ** 2 });
    }
  }
  queue.sort((a, b) => a.d - b.d);
  state.queue = queue;
  pumpQueue();
}

function pumpQueue() {
  while (state && state.loading.size < MAX_CONCURRENT_LOADS && state.queue.length) {
    loadTile(state, state.queue.shift());
  }
  if (state && !state.reported && !state.loading.size && !state.queue.length && state.tiles.size) {
    state.reported = true;
    console.log(
      `${MODULE_ID} | ${state.tiles.size} detail tiles (level ${state.detailLevel}) on screen ` +
      `${Math.round(performance.now() - state.started)} ms after the scene loaded`
    );
  }
}

async function loadTile(current, { key, col, row }) {
  const { dzi, rect, maxLevel, detailLevel } = current;
  current.loading.add(key);
  let texture = null;
  try {
    texture = await foundry.canvas.loadTexture(tileUrl(dzi, detailLevel, col, row));
  } catch (err) {
    console.warn(`${MODULE_ID} | tile ${key} failed`, err);
  }
  current.loading.delete(key);
  if (state !== current) return;

  if (!texture) {
    current.failed.add(key);
  } else {
    // Tiles carry `overlap` extra pixels on each side that has a neighbour.
    const info = levelInfo(dzi, maxLevel, detailLevel);
    const lx = col * dzi.tileSize - (col > 0 ? dzi.overlap : 0);
    const ly = row * dzi.tileSize - (row > 0 ? dzi.overlap : 0);
    const sx = (rect.width / dzi.width) * info.factor;
    const sy = (rect.height / dzi.height) * info.factor;
    current.tiles.set(key, addMesh(texture, 2, rect.x + lx * sx, rect.y + ly * sy, texture.width * sx, texture.height * sy));
  }
  pumpQueue();
}
