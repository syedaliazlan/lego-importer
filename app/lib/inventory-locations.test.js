// Unit tests for the pure "stock at every location" helpers. Run with: npm test
//
// Fixture provenance: the inventoryLevels / location / quantities shapes are
// DERIVED FROM THE shopify.dev 2026-10 DOCS (InventoryItem.inventoryLevels,
// InventoryBulkToggleActivationPayload.inventoryLevels), not observed live.
// Only the pure selection logic is asserted, never a live payload.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  KNOWN_LOCATION_NAMES,
  activationUpdates,
  activeLocationIdsFromLevels,
  describeStocking,
  describeStockingFailure,
  describeStockingUnknown,
  locationLabel,
  locationName,
  locationsToActivate,
  nonZeroAvailable,
  stockedAtLabels,
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

// The store's three real location ids with the id standing in for the name,
// which is what a location looks like when the name is not readable (no
// read_locations scope).
const AYL_ID = { id: "gid://shopify/Location/115870531959", name: "gid://shopify/Location/115870531959" };
const GLA_ID = { id: "gid://shopify/Location/115809452407", name: "gid://shopify/Location/115809452407" };
const WEB_ID = { id: "gid://shopify/Location/106650468727", name: "gid://shopify/Location/106650468727" };
const OTHER_ID = { id: "gid://shopify/Location/42", name: "gid://shopify/Location/42" };

test("KNOWN_LOCATION_NAMES: the store's three locations by id", () => {
  assert.deepEqual(KNOWN_LOCATION_NAMES, {
    "gid://shopify/Location/115870531959": "Aylesbury",
    "gid://shopify/Location/115809452407": "Glasgow",
    "gid://shopify/Location/106650468727": "warehouse",
  });
  assert.ok(Object.isFrozen(KNOWN_LOCATION_NAMES));
});

test("locationName: known name for the three store ids, numeric id for any other", () => {
  assert.equal(locationName(AYL_ID.id), "Aylesbury");
  assert.equal(locationName(GLA_ID.id), "Glasgow");
  assert.equal(locationName(WEB_ID.id), "warehouse");
  assert.equal(locationName(OTHER_ID.id), "location 42");
  assert.equal(locationName(undefined), "unknown location");
});

test("describeStocking: unreadable names fall back to the known names, never a gid", () => {
  assert.equal(
    describeStocking({ activated: [AYL_ID, GLA_ID], alreadyActive: [WEB_ID] }),
    "already stocked at warehouse; stocked at 2 locations (Aylesbury, Glasgow)"
  );
  assert.equal(describeStocking({ alreadyActive: [AYL_ID, GLA_ID, WEB_ID] }), "already stocked at Aylesbury, Glasgow, warehouse");
  assert.equal(describeStocking({ activated: [OTHER_ID] }), "stocked at location 42");
  assert.doesNotMatch(describeStocking({ activated: [AYL_ID, GLA_ID, OTHER_ID], alreadyActive: [WEB_ID] }), /gid:/);
});

test("stockedAtLabels: one label per location, empty when nothing", () => {
  assert.deepEqual(stockedAtLabels({ activated: [AYLESBURY], alreadyActive: [WAREHOUSE] }), ["Aylesbury", "Warehouse"]);
  assert.deepEqual(stockedAtLabels({ activated: [AYL_ID, GLA_ID], alreadyActive: [WEB_ID] }), ["Aylesbury", "Glasgow", "warehouse"]);
  assert.deepEqual(stockedAtLabels({ activated: [OTHER_ID] }), ["location 42"]);
  assert.deepEqual(stockedAtLabels({}), []);
});

test("locationLabel: name when set, known name for the id, numeric id otherwise", () => {
  assert.equal(locationLabel(AYLESBURY), "Aylesbury");
  assert.equal(locationLabel(GLA_ID), "Glasgow");
  assert.equal(locationLabel({ id: "gid://shopify/Location/7", name: "  " }), "location 7");
  assert.equal(locationLabel({}), "unknown location");
});

test("describeStockingFailure: names what took, what did not, and what Shopify said", () => {
  assert.equal(
    describeStockingFailure({
      alreadyActive: [WEB_ID],
      activated: [AYL_ID],
      failed: [GLA_ID],
      problem: "Failed to stock this inventory item at this location.",
    }),
    "stocked at warehouse, Aylesbury; NOT stocked at Glasgow (Shopify said: Failed to stock this inventory item at this location.)"
  );
  assert.equal(
    describeStockingFailure({ alreadyActive: [WEB_ID], failed: [AYL_ID, OTHER_ID] }),
    "stocked at warehouse; NOT stocked at Aylesbury, location 42"
  );
  assert.equal(
    describeStockingFailure({ failed: [GLA_ID], problem: "Shopify replied HTTP 503" }),
    "not stocked at any location; NOT stocked at Glasgow (Shopify said: Shopify replied HTTP 503)"
  );
});

test("describeStockingUnknown: unconfirmed locations are UNKNOWN with a check-in-Shopify note, never NOT stocked", () => {
  const text = describeStockingUnknown({
    alreadyActive: [WEB_ID],
    activated: [AYL_ID],
    unknown: [GLA_ID, OTHER_ID],
    problem: "fetch failed",
    recheckError: "Throttled",
  });
  assert.equal(
    text,
    "stocked at warehouse, Aylesbury; UNKNOWN at Glasgow, location 42, check them in Shopify (Shopify said: fetch failed; re-check failed: Throttled)"
  );
  assert.doesNotMatch(text, /NOT stocked/);
  assert.equal(
    describeStockingUnknown({ unknown: [AYL_ID], recheckError: "Throttled" }),
    "UNKNOWN at Aylesbury, check them in Shopify (re-check failed: Throttled)"
  );
});
