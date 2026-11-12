// Tile Cartography — step 2: draw the overview level of a Deep Zoom pyramid
// over the scene background.
//
// Per scene, set the .dzi URL with:
//   await canvas.scene.setFlag("tile-cartography", "dzi", "<url to .dzi>");
const MODULE_ID = "tile-cartography";

/** The overview mesh currently on the canvas, if any. */
let overview = null;

Hooks.once("init", () => {
  console.log(`${MODULE_ID} | init`);
});

Hooks.once("ready", () => {
  console.log(`${MODULE_ID} | ready (Foundry ${game.version})`);
});

Hooks.on("canvasReady", (canvas) => {
  drawOverview(canvas).catch((err) => console.error(`${MODULE_ID} | failed to draw overview`, err));
});

Hooks.on("canvasTearDown", () => removeOverview());

/**
 * Read a .dzi descriptor.
 * @param {string} url
 * @returns {Promise<{width:number, height:number, tileSize:number, overlap:number, format:string, filesUrl:string}>}
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

async function drawOverview(canvas) {
  removeOverview();
  const scene = canvas.scene;
  const url = scene?.getFlag(MODULE_ID, "dzi");
  if (!url) return;

  const dzi = await loadDzi(url);
  const level = overviewLevel(dzi);
  const tileUrl = `${dzi.filesUrl}${level}/0_0.${dzi.format}`;
  const texture = await foundry.canvas.loadTexture(tileUrl);
  if (!texture) throw new Error(`could not load ${tileUrl}`);

  // The scene may have changed while we were loading.
  if (canvas.scene !== scene || !canvas.primary) return;

  const mesh = new foundry.canvas.primary.PrimarySpriteMesh({ name: `${MODULE_ID}-overview`, texture });
  const bg = canvas.primary.background;
  const rect = canvas.dimensions.sceneRect;

  // Sort just above the scene's own background, which stays underneath as a fallback.
  if (bg) {
    mesh.elevation = bg.elevation;
    mesh.sortLayer = bg.sortLayer;
    mesh.sort = bg.sort;
    mesh.zIndex = bg.zIndex + 1;
  }
  mesh.position.set(rect.x, rect.y);
  mesh.width = rect.width;
  mesh.height = rect.height;

  canvas.primary.addChild(mesh);
  canvas.primary.sortDirty = true;
  overview = mesh;

  console.log(
    `${MODULE_ID} | overview level ${level} (${texture.width}×${texture.height}) ` +
    `of ${dzi.width}×${dzi.height} drawn over ${rect.width}×${rect.height}`
  );
}

function removeOverview() {
  if (overview && !overview.destroyed) {
    overview.parent?.removeChild(overview);
    // The texture is in Foundry's texture cache, so leave it alone.
    overview.destroy({ children: true, texture: false, baseTexture: false });
  }
  overview = null;
}
