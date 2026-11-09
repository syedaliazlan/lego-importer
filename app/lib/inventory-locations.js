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
// have (the store answers "Access denied for name field"), so locations
// normally arrive with the id standing in for the name. A real name is one
// that is set and is not just the id.
function hasRealName(loc) {
  const name = String(loc?.name ?? "").trim();
  return name !== "" && name !== loc?.id;
}

function locationsWord(n) {
  return n === 1 ? "1 location" : `${n} locations`;
}

/**
 * Short label for one location: its name when known, otherwise
 * "location 115809452407" (the numeric part of the gid).
 * @param {{id?: string, name?: string}} loc
 */
export function locationLabel(loc) {
  if (hasRealName(loc)) return String(loc.name).trim();
  const numeric = String(loc?.id ?? "").split("/").pop();
  return numeric ? `location ${numeric}` : "unknown location";
}

/**
 * What the result row shows after "Stocked at": the location names when every
 * one is known, otherwise a count, e.g. ["all 3 locations"].
 * @param {{activated?: Array<{id: string, name?: string}>, alreadyActive?: Array<{id: string, name?: string}>}} r
 * @returns {string[]}
 */
export function stockedAtLabels(r = {}) {
  const all = [...(r.activated || []), ...(r.alreadyActive || [])];
  if (!all.length) return [];
  if (all.every(hasRealName)) return all.map((l) => String(l.name).trim());
  return [all.length === 1 ? "1 location" : `all ${all.length} locations`];
}

/**
 * One line for the import result row, e.g.
 *   "stocked at 2 locations (Aylesbury, Warehouse)"
 *   "already stocked at Aylesbury; stocked at Warehouse"
 * or, when the location names are not readable:
 *   "stocked at all 3 locations (2 added)"
 * @param {{activated?: Array<{id?: string, name: string}>, alreadyActive?: Array<{id?: string, name: string}>}} r
 */
export function describeStocking(r = {}) {
  const all = [...(r.activated || []), ...(r.alreadyActive || [])];
  if (all.length && !all.every(hasRealName)) {
    const added = (r.activated || []).length;
    const total = all.length;
    const where = total === 1 ? "1 location" : `all ${total} locations`;
    return added ? `stocked at ${where} (${added} added)` : `already stocked at ${where}`;
  }

  const activated = (r.activated || []).map((l) => l.name);
  const already = (r.alreadyActive || []).map((l) => l.name);
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
