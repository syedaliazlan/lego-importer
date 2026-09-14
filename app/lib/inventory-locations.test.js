// Unit tests for the pure "stock at every location" helpers. Run with: npm test
//
// Fixture provenance: the inventoryLevels / location / quantities shapes are
// DERIVED FROM THE shopify.dev 2026-10 DOCS (InventoryItem.inventoryLevels,
// InventoryBulkToggleActivationPayload.inventoryLevels), not observed live.
// Only the pure selection logic is asserted, never a live payload.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  activationUpdates,
  activeLocationIdsFromLevels,
  describeStocking,
  locationsToActivate,
  nonZeroAvailable,
} from "./inventory-locations.js";

const AYLESBURY = { id: "gid://shopify/Location/1", name: "Aylesbury" };
const WAREHOUSE = { id: "gid://shopify/Location/2", name: "Warehouse" };
const ONLINE = { id: "gid://shopify/Location/3", name: "Online" };

test("activeLocationIdsFromLevels: edges shape", () => {
  const item = { inventoryLevels: { edges: [{ node: { location: { id: WAREHOUSE.id } } }] } };
  assert.deepEqual([...activeLocationIdsFromLevels(item)], [WAREHOUSE.id]);
});

test("activeLocationIdsFromLevels: nodes shape, missing bits tolerated", () => {
  const item = { inventoryLevels: { nodes: [{ location: { id: AYLESBURY.id } }, { location: null }, null] } };
  assert.deepEqual([...activeLocationIdsFromLevels(item)], [AYLESBURY.id]);
  assert.deepEqual([...activeLocationIdsFromLevels(null)], []);
  assert.deepEqual([...activeLocationIdsFromLevels({})], []);
});

test("locationsToActivate: skips the location the item is already stocked at", () => {
  const r = locationsToActivate({
    locations: [AYLESBURY, WAREHOUSE, ONLINE],
    activeLocationIds: new Set([WAREHOUSE.id]),
  });
  assert.deepEqual(r.toActivate, [AYLESBURY, ONLINE]);
  assert.deepEqual(r.alreadyActive, [WAREHOUSE]);
});

test("locationsToActivate: nothing to do when every location is active", () => {
  const r = locationsToActivate({
    locations: [AYLESBURY, WAREHOUSE],
    activeLocationIds: [AYLESBURY.id, WAREHOUSE.id],
  });
  assert.deepEqual(r.toActivate, []);
  assert.equal(r.alreadyActive.length, 2);
});

test("locationsToActivate: no levels yet means every location is activated", () => {
  const r = locationsToActivate({ locations: [AYLESBURY, WAREHOUSE] });
  assert.deepEqual(r.toActivate, [AYLESBURY, WAREHOUSE]);
  assert.deepEqual(r.alreadyActive, []);
});

test("locationsToActivate: no locations known means nothing to activate", () => {
  assert.deepEqual(locationsToActivate({ locations: [] }), { toActivate: [], alreadyActive: [] });
  assert.deepEqual(locationsToActivate({}), { toActivate: [], alreadyActive: [] });
});

test("locationsToActivate: duplicate and id-less locations are dropped, blank name falls back to id", () => {
  const r = locationsToActivate({
    locations: [AYLESBURY, AYLESBURY, { name: "ghost" }, { id: "gid://shopify/Location/9", name: "  " }],
  });
  assert.deepEqual(r.toActivate, [AYLESBURY, { id: "gid://shopify/Location/9", name: "gid://shopify/Location/9" }]);
});

test("activationUpdates: builds the 2026-10 input rows with activate true", () => {
  assert.deepEqual(activationUpdates([AYLESBURY, { name: "no id" }, WAREHOUSE]), [
    { locationId: AYLESBURY.id, activate: true },
    { locationId: WAREHOUSE.id, activate: true },
  ]);
  assert.deepEqual(activationUpdates(undefined), []);
});

test("nonZeroAvailable: zero levels pass, anything else is reported with its location", () => {
  const levels = [
    { location: { id: AYLESBURY.id }, quantities: [{ name: "available", quantity: 0 }] },
    { location: { id: WAREHOUSE.id }, quantities: [{ name: "available", quantity: 3 }] },
    { location: { id: ONLINE.id }, quantities: [] },
  ];
  assert.deepEqual(nonZeroAvailable(levels), [{ locationId: WAREHOUSE.id, quantity: 3 }]);
  assert.deepEqual(nonZeroAvailable(undefined), []);
});

test("describeStocking: readable one-liner for the result row", () => {
  assert.equal(describeStocking({ activated: [AYLESBURY] }), "stocked at Aylesbury");
  assert.equal(
    describeStocking({ activated: [AYLESBURY, ONLINE], alreadyActive: [WAREHOUSE] }),
    "already stocked at Warehouse; stocked at 2 locations (Aylesbury, Online)"
  );
  assert.equal(describeStocking({}), "no locations");
});
