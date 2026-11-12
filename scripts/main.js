// Tile Cartography — step 5: draw the overview level of a Deep Zoom pyramid
// over the scene background, stream in the tiles that are on screen at the
// level that matches the current zoom, and free tiles that are no longer needed.
//
// Per scene, set the .dzi URL with:
//   await canvas.scene.setFlag("tile-cartography", "dzi", "<url to .dzi>");
//
// For a snapshot of what is loaded, run in the console:
//   game.modules.get("tile-cartography").api.stats()
const MODULE_ID = "tile-cartography";

/** How many tile requests run at once. */
const MAX_CONCURRENT_LOADS = 6;

/** Extra margin around the screen to load ahead of panning, in tiles. */
const PREFETCH_TILES = 0.5;

/** While drag-panning, also load where the view will be this far ahead. */
const LOOKAHEAD_MS = 300;

/**
 * Shifts the level choice: 0 aims for about one tile pixel per screen pixel
 * (between 0.7 and 1.4). +1 loads one level sharper (four times the tiles),
 * -1 one level softer.
 */
const DETAIL_BIAS = 0;

/** Tiles within this many screen widths/heights of the view are kept. */
const KEEP_MARGIN = 0.5;

/** Wait this long after the camera stops before freeing tiles. */
const EVICT_DELAY_MS = 750;

/** Hard ceiling on loaded tiles (a 512 px tile is about 1.3 MB of GPU memory). */
const MAX_TILES = 192;

/**
 * @typedef {{x0:number, y0:number, x1:number, y1:number}} Box  A world-space rectangle.
 * @typedef {{mesh: PrimarySpriteMesh, level:number, bounds: Box, bytes:number}} Tile
 */

/**
 * State for the pyramid on the current canvas, or null.
 * @type {null | {
 *   scene: Scene, dzi: object, rect: PIXI.Rectangle, maxLevel: number,
 *   overview: PrimarySpriteMesh|null, overviewLevel: number, detailLevel: number|null,
 *   tiles: Map<string, Tile>,
 *   loading: Map<string, {controller: AbortController, bounds: Box}>,
 *   failed: Set<string>,
 *   queue: Array<{key:string, level:number, col:number, row:number}>,
 *   destination: null | {view: Box, level: number|null, token: object},
 *   motion: {cx:number, cy:number, t:number, vx:number, vy:number} | null,
 *   evictTimer: number|null,
 *   sortBase: {elevation:number, sortLayer:number, sort:number, zIndex:number}|null,
 *   levelSince: number, reported: boolean
 * }}
 */
let state = null;

Hooks.once("init", () => {
  console.log(`${MODULE_ID} | init`);
  const module = game.modules.get(MODULE_ID);
  if (module) module.api = { stats };
});

Hooks.once("ready", () => {
  console.log(`${MODULE_ID} | ready (Foundry ${game.version})`);
  watchAnimatedPans();
});

Hooks.on("canvasReady", (canvas) => {
  setup(canvas).catch((err) => console.error(`${MODULE_ID} | failed to set up`, err));
});

Hooks.on("canvasPan", () => scheduleUpdate());

Hooks.on("canvasTearDown", () => teardown());

// A copy pasted into the console after the game is ready installs the pan watcher itself.
if (globalThis.game?.ready) watchAnimatedPans();

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
/*  Geometry                                     */
/* -------------------------------------------- */

function expand(box, dx, dy) {
  return { x0: box.x0 - dx, y0: box.y0 - dy, x1: box.x1 + dx, y1: box.y1 + dy };
}

function union(a, b) {
  return { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) };
}

function intersects(a, b) {
  return a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
}

function center(box) {
  return { x: (box.x0 + box.x1) / 2, y: (box.y0 + box.y1) / 2 };
}

/** The part of the world that is on screen now. */
function viewRect() {
  const screen = canvas.app.renderer.screen;
  const tl = canvas.stage.toLocal(new PIXI.Point(0, 0));
  const br = canvas.stage.toLocal(new PIXI.Point(screen.width, screen.height));
  return { x0: tl.x, y0: tl.y, x1: br.x, y1: br.y };
}

/** The part of the world that would be on screen centered on (x, y) at a zoom scale. */
function viewAt(x, y, scale) {
  const screen = canvas.app.renderer.screen;
  const hw = screen.width / 2 / scale;
  const hh = screen.height / 2 / scale;
  return { x0: x - hw, y0: y - hh, x1: x + hw, y1: y + hh };
}

/** World size of one tile at a level. */
function tileWorldSize(st, level) {
  const factor = 2 ** (st.maxLevel - level);
  return {
    tw: st.dzi.tileSize * factor * (st.rect.width / st.dzi.width),
    th: st.dzi.tileSize * factor * (st.rect.height / st.dzi.height)
  };
}

/** World bounds of a tile, ignoring overlap. */
function tileBounds(st, level, col, row) {
  const { tw, th } = tileWorldSize(st, level);
  const x0 = st.rect.x + col * tw;
  const y0 = st.rect.y + row * th;
  return {
    x0, y0,
    x1: Math.min(x0 + tw, st.rect.x + st.rect.width),
    y1: Math.min(y0 + th, st.rect.y + st.rect.height)
  };
}

/** Columns and rows of a level's tiles that touch a world box. */
function tileRange(st, level, box) {
  const info = levelInfo(st.dzi, st.maxLevel, level);
  const { tw, th } = tileWorldSize(st, level);
  return {
    c0: Math.max(0, Math.floor((box.x0 - st.rect.x) / tw)),
    c1: Math.min(info.cols - 1, Math.floor((box.x1 - st.rect.x) / tw)),
    r0: Math.max(0, Math.floor((box.y0 - st.rect.y) / th)),
    r1: Math.min(info.rows - 1, Math.floor((box.y1 - st.rect.y) / th))
  };
}

/* -------------------------------------------- */
/*  Setup and teardown                           */
/* -------------------------------------------- */

async function setup(canvas) {
  teardown();
  const scene = canvas.scene;
  // Read the flag directly: getFlag throws when the module is not active (as when testing a pasted copy).
  const url = scene?.flags?.[MODULE_ID]?.dzi;
  if (!url) return;

  const started = performance.now();
  const dzi = await loadDzi(url);
  if (canvas.scene !== scene) return;

  const maxLevel = Math.ceil(Math.log2(Math.max(dzi.width, dzi.height)));
  const level = overviewLevel(dzi);
  const bg = canvas.primary.background;
  state = {
    scene, dzi, maxLevel,
    rect: canvas.dimensions.sceneRect,
    overview: null,
    overviewLevel: level,
    detailLevel: null,
    tiles: new Map(),
    loading: new Map(),
    failed: new Set(),
    queue: [],
    destination: null,
    motion: null,
    evictTimer: null,
    sortBase: bg ? { elevation: bg.elevation, sortLayer: bg.sortLayer, sort: bg.sort, zIndex: bg.zIndex } : null,
    levelSince: started,
    reported: true
  };
  const current = state;

  // Detail tiles can start loading while the overview does.
  scheduleUpdate();

  // The overview is small and never freed, so Foundry's own loader and cache suit it.
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
  const st = state;
  state = null;
  clearTimeout(st.evictTimer);
  for (const { controller } of st.loading.values()) controller.abort();
  for (const tile of st.tiles.values()) freeTile(tile);
  if (st.overview && !st.overview.destroyed) {
    st.overview.parent?.removeChild(st.overview);
    // The overview texture belongs to Foundry's texture cache, so leave it alone.
    st.overview.destroy({ children: true, texture: false, baseTexture: false });
  }
}

/**
 * Add a sprite to the primary canvas group, sorted just above the scene's own
 * background (which stays underneath as a fallback).
 * @param {number} layer  Higher layers draw on top: 1 for the overview, then
 *   2 + level for detail tiles, so sharper levels cover softer ones.
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
/*  Tile textures                                */
/* -------------------------------------------- */

/**
 * Load a tile as a texture this module owns, so it can really be freed later.
 * (Textures from Foundry's loader stay in its cache.) The image is decoded off
 * the main thread by createImageBitmap.
 */
async function fetchTileTexture(url, signal) {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const bitmap = await createImageBitmap(await response.blob(), { premultiplyAlpha: "premultiply" });
  if (signal.aborted) {
    bitmap.close();
    throw new DOMException("Aborted", "AbortError");
  }
  return new PIXI.Texture(new PIXI.BaseTexture(bitmap, { alphaMode: PIXI.ALPHA_MODES.PMA }));
}

function freeTexture(texture) {
  const bitmap = texture.baseTexture?.resource?.source;
  texture.destroy(true);
  if (bitmap instanceof ImageBitmap) bitmap.close();
}

function freeTile(tile) {
  const texture = tile.mesh.texture;
  if (!tile.mesh.destroyed) {
    tile.mesh.parent?.removeChild(tile.mesh);
    tile.mesh.destroy({ children: true, texture: false, baseTexture: false });
  }
  if (texture) freeTexture(texture);
}

/* -------------------------------------------- */
/*  Camera                                       */
/* -------------------------------------------- */

let updateFrame = null;

/** Recompute wanted tiles at most once per animation frame. */
function scheduleUpdate() {
  if (!state || updateFrame !== null) return;
  updateFrame = requestAnimationFrame(() => {
    updateFrame = null;
    updateVisibleTiles();
  });
}

/** Smoothed pan velocity in world units per ms, from successive view centers. */
function trackMotion(st, view) {
  const now = performance.now();
  const { x, y } = center(view);
  const m = st.motion;
  if (m && now - m.t > 0 && now - m.t < 200) {
    const dt = now - m.t;
    st.motion = { cx: x, cy: y, t: now, vx: 0.5 * m.vx + 0.5 * (x - m.cx) / dt, vy: 0.5 * m.vy + 0.5 * (y - m.cy) / dt };
  } else {
    // First sample, or the camera sat still for a while.
    st.motion = { cx: x, cy: y, t: now, vx: 0, vy: 0 };
  }
}

/**
 * Foundry moves the camera smoothly with Canvas#animatePan (the GM pulling
 * everyone's view, edge scrolling while dragging, and so on). Wrap it so the
 * destination's tiles load first and are ready when the camera lands.
 */
function watchAnimatedPans() {
  const proto = canvas?.constructor?.prototype;
  const marker = Symbol.for(`${MODULE_ID}.animatePan`);
  if (!proto?.animatePan || proto.animatePan[marker]) return;
  const original = proto.animatePan;
  const wrapped = function (options = {}, ...rest) {
    const result = original.call(this, options, ...rest);
    try {
      onAnimatedPan(options ?? {}, result);
    } catch (err) {
      console.warn(`${MODULE_ID} | could not prefetch the pan destination`, err);
    }
    return result;
  };
  wrapped[marker] = true;
  proto.animatePan = wrapped;
}

function onAnimatedPan({ x, y, scale }, result) {
  if (!state) return;
  const current = state;
  const s = scale ?? canvas.stage.scale.x;
  const view = viewAt(x ?? canvas.stage.pivot.x, y ?? canvas.stage.pivot.y, s);
  const token = {};
  current.destination = { view, level: chooseLevel(current, s), token };

  // Follow the animation frame by frame, whether or not Foundry emits canvasPan as it goes.
  const follow = () => {
    if (state !== current || current.destination?.token !== token) return;
    scheduleUpdate();
    requestAnimationFrame(follow);
  };
  requestAnimationFrame(follow);

  Promise.resolve(result).finally(() => {
    if (current.destination?.token === token) current.destination = null;
    scheduleUpdate();
  });
}

/* -------------------------------------------- */
/*  Choosing and loading tiles                   */
/* -------------------------------------------- */

/**
 * The level whose pixels best match screen pixels at a zoom scale, or null
 * when the overview is already sharp enough.
 */
function chooseLevel(st, stageScale) {
  const { dzi, rect, maxLevel, overviewLevel } = st;
  const screenPerWorld = stageScale * canvas.app.renderer.resolution;
  const imagePerScreen = (dzi.width / rect.width) / screenPerWorld;
  const halvings = Math.round(Math.log2(imagePerScreen) - DETAIL_BIAS);
  const level = Math.min(maxLevel, maxLevel - Math.max(0, halvings));
  return level > overviewLevel ? level : null;
}

function updateVisibleTiles() {
  const st = state;
  if (!st) return;
  const view = viewRect();
  trackMotion(st, view);
  scheduleEvict();

  const level = chooseLevel(st, canvas.stage.scale.x);
  if (level !== st.detailLevel) {
    st.detailLevel = level;
    st.levelSince = performance.now();
    st.reported = false;
  }

  // Build the queue: the animated-pan destination first (that is where the
  // camera will stop), then the current view plus look-ahead in the direction
  // of a drag. Rebuilding it each time drops tiles scrolled past before their turn.
  const queue = [];
  const seen = new Set();
  const want = (lvl, box, focus) => {
    if (lvl === null) return;
    const { tw, th } = tileWorldSize(st, lvl);
    const r = tileRange(st, lvl, expand(box, PREFETCH_TILES * tw, PREFETCH_TILES * th));
    const group = [];
    for (let row = r.r0; row <= r.r1; row++) {
      for (let col = r.c0; col <= r.c1; col++) {
        const key = `${lvl}/${col}_${row}`;
        if (seen.has(key) || st.tiles.has(key) || st.loading.has(key) || st.failed.has(key)) continue;
        seen.add(key);
        const b = tileBounds(st, lvl, col, row);
        const c = center(b);
        group.push({ key, level: lvl, col, row, d: (c.x - focus.x) ** 2 + (c.y - focus.y) ** 2 });
      }
    }
    group.sort((a, b) => a.d - b.d);
    queue.push(...group);
  };

  if (st.destination) want(st.destination.level, st.destination.view, center(st.destination.view));

  const w = view.x1 - view.x0;
  const h = view.y1 - view.y0;
  const ax = Math.max(-w, Math.min(w, (st.motion?.vx ?? 0) * LOOKAHEAD_MS));
  const ay = Math.max(-h, Math.min(h, (st.motion?.vy ?? 0) * LOOKAHEAD_MS));
  const ahead = { x0: view.x0 + ax, y0: view.y0 + ay, x1: view.x1 + ax, y1: view.y1 + ay };
  want(level, union(view, ahead), center(view));

  st.queue = queue;
  pumpQueue();
}

function pumpQueue() {
  const st = state;
  while (st && st.loading.size < MAX_CONCURRENT_LOADS && st.queue.length) {
    loadTile(st, st.queue.shift());
  }
  if (st && !st.reported && !st.loading.size && !st.queue.length) {
    st.reported = true;
    console.log(
      `${MODULE_ID} | level ${st.detailLevel ?? "overview"} on screen in ` +
      `${Math.round(performance.now() - st.levelSince)} ms (${st.tiles.size} tiles loaded)`
    );
  }
}

async function loadTile(current, { key, level, col, row }) {
  const { dzi, rect, maxLevel } = current;
  const controller = new AbortController();
  current.loading.set(key, { controller, bounds: tileBounds(current, level, col, row) });
  let texture = null;
  let aborted = false;
  try {
    texture = await fetchTileTexture(tileUrl(dzi, level, col, row), controller.signal);
  } catch (err) {
    if (err?.name === "AbortError") aborted = true;
    else console.warn(`${MODULE_ID} | tile ${key} failed`, err);
  }
  current.loading.delete(key);
  if (state !== current) {
    if (texture) freeTexture(texture);
    return;
  }

  if (!texture) {
    if (!aborted) current.failed.add(key);
  } else {
    // Tiles carry `overlap` extra pixels on each side that has a neighbour.
    const info = levelInfo(dzi, maxLevel, level);
    const lx = col * dzi.tileSize - (col > 0 ? dzi.overlap : 0);
    const ly = row * dzi.tileSize - (row > 0 ? dzi.overlap : 0);
    const sx = (rect.width / dzi.width) * info.factor;
    const sy = (rect.height / dzi.height) * info.factor;
    const mesh = addMesh(texture, 2 + level, rect.x + lx * sx, rect.y + ly * sy, texture.width * sx, texture.height * sy);
    current.tiles.set(key, {
      mesh, level,
      bounds: tileBounds(current, level, col, row),
      bytes: Math.round(texture.width * texture.height * 4 * 4 / 3) // RGBA plus mipmaps
    });
    if (current.tiles.size > MAX_TILES) evict(true);
  }
  pumpQueue();
}

/* -------------------------------------------- */
/*  Freeing tiles                                */
/* -------------------------------------------- */

/** Free tiles once the camera has been still for EVICT_DELAY_MS. */
function scheduleEvict() {
  const st = state;
  if (!st) return;
  clearTimeout(st.evictTimer);
  st.evictTimer = setTimeout(() => {
    if (state !== st) return;
    // Mid-animation, wait for the camera to land.
    if (st.destination) return scheduleEvict();
    evict(false);
  }, EVICT_DELAY_MS);
}

/**
 * @param {boolean} capOnly  Only enforce MAX_TILES (used while loading, so a
 *   pan in progress never loses tiles it is about to need).
 */
function evict(capOnly) {
  const st = state;
  if (!st) return;
  const view = viewRect();
  const level = st.detailLevel;
  const onScreenNow = (key, tile) => tile.level === level && intersects(tile.bounds, view);
  const freed = [];
  const free = (key) => {
    freeTile(st.tiles.get(key));
    st.tiles.delete(key);
    freed.push(key);
  };

  if (!capOnly) {
    const w = view.x1 - view.x0;
    const h = view.y1 - view.y0;
    const keep = expand(view, KEEP_MARGIN * w, KEEP_MARGIN * h);

    // Sharper levels left over from zooming in can go once the current level
    // covers the screen, so freeing them never shows a blurrier map.
    let covered = true;
    if (level !== null) {
      const r = tileRange(st, level, view);
      for (let row = r.r0; row <= r.r1 && covered; row++) {
        for (let col = r.c0; col <= r.c1; col++) {
          const key = `${level}/${col}_${row}`;
          if (!st.tiles.has(key) && !st.failed.has(key)) { covered = false; break; }
        }
      }
    }

    for (const [key, tile] of st.tiles) {
      const tooSharp = level === null || tile.level > level;
      if (!intersects(tile.bounds, keep) || (tooSharp && covered)) free(key);
    }

    // Requests for tiles far off screen are no longer worth finishing.
    for (const [key, { controller, bounds }] of st.loading) {
      if (!intersects(bounds, keep)) {
        controller.abort();
        st.loading.delete(key);
      }
    }
  }

  // Over the ceiling: free the tiles farthest from the view, but never ones on screen.
  if (st.tiles.size > MAX_TILES) {
    const c = center(view);
    const candidates = [...st.tiles]
      .filter(([key, tile]) => !onScreenNow(key, tile))
      .map(([key, tile]) => {
        const t = center(tile.bounds);
        return { key, d: (t.x - c.x) ** 2 + (t.y - c.y) ** 2 };
      })
      .sort((a, b) => b.d - a.d);
    for (const { key } of candidates) {
      if (st.tiles.size <= MAX_TILES) break;
      free(key);
    }
  }

  if (freed.length) {
    console.log(`${MODULE_ID} | freed ${freed.length} tiles, ${st.tiles.size} still loaded`);
    pumpQueue();
  }
}

/* -------------------------------------------- */
/*  Diagnostics                                  */
/* -------------------------------------------- */

/** What is loaded right now, for checking memory use from the console. */
function stats() {
  const st = state;
  if (!st) return null;
  const byLevel = {};
  let bytes = 0;
  for (const tile of st.tiles.values()) {
    byLevel[tile.level] = (byLevel[tile.level] ?? 0) + 1;
    bytes += tile.bytes;
  }
  return {
    level: st.detailLevel ?? "overview",
    tiles: st.tiles.size,
    byLevel,
    approxGpuMB: Math.round(bytes / 1048576),
    loading: st.loading.size,
    queued: st.queue.length,
    failed: st.failed.size
  };
}
