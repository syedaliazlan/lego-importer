// app/lib/inventory-locations.js
//
// Pure helpers for stocking a newly imported product at every location. No
// I/O, so the "which locations still need activating" rule is unit tested.
//
// Why this exists: a product Shopify creates through the API is stocked at
// one location only. When staff at the Aylesbury shop scan a product that was
// never stocked there, the POS asks "stock at this location?" for every one.
// The shop wants every product stocked at every location, at zero, from the
// moment it is created, so that pop-up never appears.

/**
 * Location ids where an inventory item already has an inventory level.
 * Accepts the InventoryItem node as read from the Admin API:
 *   inventoryLevels { edges { node { location { id } } } }  or  { nodes }
 * @param {object} inventoryItem
 * @returns {Set<string>}
 */
export function activeLocationIdsFromLevels(inventoryItem) {
  const conn = inventoryItem?.inventoryLevels;
  let nodes = [];
  if (Array.isArray(conn?.nodes)) nodes = conn.nodes;
  else if (Array.isArray(conn?.edges)) nodes = conn.edges.map((e) => e?.node);
  const ids = new Set();
  for (const n of nodes) {
    const id = n?.location?.id;
    if (id) ids.add(id);
  }
  return ids;
}

/**
 * Split the shop's active locations into the ones that still need this
 * inventory item activated and the ones that already have it.
 * Locations without an id are ignored; duplicates are collapsed.
 * @param {object} args
 * @param {Array<{id: string, name?: string}>} args.locations every active location on the shop
 * @param {Set<string>|Array<string>} [args.activeLocationIds] ids where the item already has a level
 * @returns {{toActivate: Array<{id: string, name: string}>, alreadyActive: Array<{id: string, name: string}>}}
 */
export function locationsToActivate({ locations, activeLocationIds } = {}) {
  const active = new Set(activeLocationIds instanceof Set ? activeLocationIds : activeLocationIds || []);
  const seen = new Set();
  const toActivate = [];
  const alreadyActive = [];
  for (const loc of Array.isArray(locations) ? locations : []) {
    const id = loc?.id;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const entry = { id, name: String(loc.name ?? "").trim() || id };
    if (active.has(id)) alreadyActive.push(entry);
    else toActivate.push(entry);
  }
  return { toActivate, alreadyActive };
}

/**
 * Build the `inventoryItemUpdates` argument for inventoryBulkToggleActivation.
 * Shape per the 2026-10 docs: [{ locationId: ID!, activate: Boolean! }].
 *   https://shopify.dev/docs/api/admin-graphql/2026-10/input-objects/InventoryBulkToggleActivationInput
 * @param {Array<{id: string}>} locations
 */
export function activationUpdates(locations) {
  return (locations || []).filter((l) => l?.id).map((l) => ({ locationId: l.id, activate: true }));
}

/**
 * Levels that came back from the activation with a non-zero available
 * quantity. A fresh activation starts at zero, so anything else is reported
 * rather than silently accepted.
 * @param {Array<object>} inventoryLevels payload rows with quantities(names:["available"]) and location
 * @returns {Array<{locationId: string, quantity: number}>}
 */
export function nonZeroAvailable(inventoryLevels) {
  const out = [];
  for (const level of inventoryLevels || []) {
    const available = (level?.quantities || []).find((q) => q?.name === "available");
    const qty = Number(available?.quantity ?? 0);
    if (qty !== 0) out.push({ locationId: level?.location?.id || "", quantity: qty });
  }
  return out;
}

// Location names need the read_locations scope, which this app does not
// have (the live store answers "Access denied for name field"), so the app
// cannot ask Shopify for them. These are the store's three locations by id
// (ids confirmed live 2026-11-16 with the app's own token). Any other
// location is shown by its numeric id.
export const KNOWN_LOCATION_NAMES = Object.freeze({
  "gid://shopify/Location/115870531959": "Aylesbury",
  "gid://shopify/Location/115809452407": "Glasgow",
  "gid://shopify/Location/106650468727": "warehouse",
});

/**
 * Name for a location id: the known name, otherwise "location 115809452407"
 * (the numeric part of the gid).
 * @param {string} id
 */
export function locationName(id) {
  const known = KNOWN_LOCATION_NAMES[id];
  if (known) return known;
  const numeric = String(id ?? "").split("/").pop();
  return numeric ? `location ${numeric}` : "unknown location";
}

// A real name is one that is set and is not just the id standing in for it.
function hasRealName(loc) {
  const name = String(loc?.name ?? "").trim();
  return name !== "" && name !== loc?.id;
}

function locationsWord(n) {
  return n === 1 ? "1 location" : `${n} locations`;
}

/**
 * Short label for one location: its name when set, otherwise the known name
 * for its id, otherwise "location 115809452407".
 * @param {{id?: string, name?: string}} loc
 */
export function locationLabel(loc) {
  if (hasRealName(loc)) return String(loc.name).trim();
  return locationName(loc?.id);
}

/**
 * What the result row shows after "Stocked at", e.g.
 * ["Aylesbury", "Glasgow", "warehouse"].
 * @param {{activated?: Array<{id: string, name?: string}>, alreadyActive?: Array<{id: string, name?: string}>}} r
 * @returns {string[]}
 */
export function stockedAtLabels(r = {}) {
  return [...(r.activated || []), ...(r.alreadyActive || [])].map(locationLabel);
}

/**
 * One line for the import result row, e.g.
 *   "already stocked at warehouse; stocked at 2 locations (Aylesbury, Glasgow)"
 * @param {{activated?: Array<{id?: string, name?: string}>, alreadyActive?: Array<{id?: string, name?: string}>}} r
 */
export function describeStocking(r = {}) {
  const activated = (r.activated || []).map(locationLabel);
  const already = (r.alreadyActive || []).map(locationLabel);
  const parts = [];
  if (already.length) parts.push(`already stocked at ${already.join(", ")}`);
  if (activated.length) {
    parts.push(
      activated.length === 1
        ? `stocked at ${activated[0]}`
        : `stocked at ${locationsWord(activated.length)} (${activated.join(", ")})`
    );
  }
  return parts.join("; ") || "no locations";
}

/**
 * The row text when the item is not stocked everywhere: which locations it IS
 * stocked at, which it is NOT, and what Shopify said, e.g.
 *   "stocked at warehouse, Aylesbury; NOT stocked at Glasgow (Shopify said: ...)"
 * @param {{activated?: Array<object>, alreadyActive?: Array<object>, failed?: Array<object>, problem?: string|null}} r
 */
export function describeStockingFailure({ activated = [], alreadyActive = [], failed = [], problem = null } = {}) {
  const stocked = [...alreadyActive, ...activated].map(locationLabel);
  const missing = failed.map(locationLabel);
  const parts = [stocked.length ? `stocked at ${stocked.join(", ")}` : "not stocked at any location"];
  if (missing.length) parts.push(`NOT stocked at ${missing.join(", ")}`);
  const text = parts.join("; ");
  return problem ? `${text} (Shopify said: ${problem})` : text;
}
