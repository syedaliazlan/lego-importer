// Regression tests for reading the shop's locations. Run with: npm test
//
// Fixture provenance: every payload below was OBSERVED on the live store
// (e8r0a2-fe) on 2026-11-09 with this app's own offline token, API 2026-10.
// Before this fix the importer asked for `locations { id name }`; the store
// refused it (payload ACCESS_DENIED_PAYLOAD), getActiveLocations returned [],
// and no imported product was stocked beyond the location Shopify created it
// at. Asking for ids only returned IDS_ONLY_PAYLOAD.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  INVENTORY_BULK_TOGGLE_ACTIVATION,
  LOCATIONS_QUERY,
  getActiveLocations,
} from "./shopify-product.server.js";

const ACCESS_DENIED_PAYLOAD = {
  errors: [
    {
      message:
        "Access denied for name field. Required access: `read_locations` access scope or `read_markets_home` access scope.",
      extensions: { code: "ACCESS_DENIED" },
      path: ["locations", "edges", 0, "node", "name"],
    },
  ],
  data: null,
};

const IDS_ONLY_PAYLOAD = {
  data: {
    locations: {
      edges: [
        { node: { id: "gid://shopify/Location/115870531959" } },
        { node: { id: "gid://shopify/Location/115809452407" } },
        { node: { id: "gid://shopify/Location/106650468727" } },
      ],
    },
  },
};

function fakeAdmin(payload) {
  const calls = [];
  return {
    calls,
    graphql: async (query, opts) => {
      calls.push({ query, opts });
      return { json: async () => payload };
    },
  };
}

// The selection inside `location { ... }` or a `node { ... }` of locations.
function selects(doc, field) {
  return new RegExp(`\\b${field}\\b`).test(doc);
}

test("LOCATIONS_QUERY asks for ids only, never the name the app cannot read", () => {
  assert.ok(selects(LOCATIONS_QUERY, "id"));
  assert.ok(!selects(LOCATIONS_QUERY, "name"), "location name needs read_locations; asking fails the whole query");
});

test("the activation mutation does not ask for the location name either", () => {
  const locationSelection = INVENTORY_BULK_TOGGLE_ACTIVATION.match(/location\s*\{([^}]*)\}/);
  assert.ok(locationSelection, "mutation selects the level's location");
  assert.ok(selects(locationSelection[1], "id"));
  assert.ok(!selects(locationSelection[1], "name"));
});

test("getActiveLocations: the live ids-only payload gives all three locations", async () => {
  const admin = fakeAdmin(IDS_ONLY_PAYLOAD);
  const locations = await getActiveLocations(admin);
  assert.deepEqual(
    locations.map((l) => l.id),
    [
      "gid://shopify/Location/115870531959",
      "gid://shopify/Location/115809452407",
      "gid://shopify/Location/106650468727",
    ]
  );
  assert.equal(admin.calls.length, 1);
  assert.equal(admin.calls[0].query, LOCATIONS_QUERY);
});

test("getActiveLocations: the live access-denied payload still fails safe to []", async () => {
  assert.deepEqual(await getActiveLocations(fakeAdmin(ACCESS_DENIED_PAYLOAD)), []);
});
