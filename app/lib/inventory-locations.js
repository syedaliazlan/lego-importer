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

/**
 * One line for the import result row, e.g.
 *   "stocked at 2 locations (Aylesbury, Warehouse)"
 *   "already stocked at Aylesbury; stocked at Warehouse"
 * @param {{activated?: Array<{name: string}>, alreadyActive?: Array<{name: string}>}} r
 */
export function describeStocking(r = {}) {
  const activated = (r.activated || []).map((l) => l.name);
  const already = (r.alreadyActive || []).map((l) => l.name);
  const parts = [];
  if (already.length) parts.push(`already stocked at ${already.join(", ")}`);
  if (activated.length) {
    parts.push(
      activated.length === 1
        ? `stocked at ${activated[0]}`
        : `stocked at ${activated.length} locations (${activated.join(", ")})`
    );
  }
  return parts.join("; ") || "no locations";
}
