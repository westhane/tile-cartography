// Tile Cartography — step 1: prove the module loads.
const MODULE_ID = "tile-cartography";

Hooks.once("init", () => {
  console.log(`${MODULE_ID} | init`);
});

Hooks.once("ready", () => {
  console.log(`${MODULE_ID} | ready (Foundry ${game.version})`);
});
