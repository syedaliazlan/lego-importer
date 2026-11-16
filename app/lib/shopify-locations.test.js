// Regression tests for reading the shop's locations. Run with: npm test
//
// Fixture provenance: the location ids and the access-denied error below were
// OBSERVED on the live store (e8r0a2-fe) on 2026-11-09 with this app's own
// offline token, API 2026-10; the ids-only query was re-run read-only on
// 2026-11-16 and returned the same three ids. Before the fix the importer
// asked for `locations { id name }`; the store refused it, getActiveLocations
// returned [], and no imported product was stocked beyond the location
// Shopify created it at.
//
// The real admin.graphql THROWS on GraphQL errors (see fake-admin.test-helper.js),
// so the refusal is thrown here, not returned as a reply body.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  INVENTORY_BULK_TOGGLE_ACTIVATION,
  LOCATIONS_QUERY,
  STOCKING_TRIES,
  THROTTLE_RETRIES,
  getActiveLocations,
} from "./shopify-product.server.js";
import {
  THROTTLED,
  fakeAdmin,
  graphqlQueryError,
  httpErrorResponse,
  httpMaxRetriesError,
} from "./fake-admin.test-helper.js";

const ACCESS_DENIED_ERRORS = [
  {
    message:
      "Access denied for name field. Required access: `read_locations` access scope or `read_markets_home` access scope.",
    extensions: { code: "ACCESS_DENIED" },
    path: ["locations", "edges", 0, "node", "name"],
  },
];

const IDS_ONLY_REPLY = {
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

const noWait = async () => {};

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

test("getActiveLocations: the live ids-only reply gives all three locations, named from the known ids", async () => {
  const admin = fakeAdmin(() => IDS_ONLY_REPLY);
  const locations = await getActiveLocations(admin, { wait: noWait });
  assert.deepEqual(locations, [
    { id: "gid://shopify/Location/115870531959", name: "Aylesbury" },
    { id: "gid://shopify/Location/115809452407", name: "Glasgow" },
    { id: "gid://shopify/Location/106650468727", name: "warehouse" },
  ]);
  assert.equal(admin.calls.length, 1);
  assert.equal(admin.calls[0].query, LOCATIONS_QUERY);
  assert.equal(admin.calls[0].options.tries, STOCKING_TRIES);
});

test("getActiveLocations: the live access-denied error, thrown as the library throws it, fails safe to []", async () => {
  const admin = fakeAdmin(() => {
    throw graphqlQueryError(ACCESS_DENIED_ERRORS);
  });
  assert.deepEqual(await getActiveLocations(admin, { wait: noWait }), []);
  assert.equal(admin.calls.length, 1, "ACCESS_DENIED is not retried");
});

test("getActiveLocations: HTTP errors as the library throws them fail safe to []", async () => {
  for (const thrown of [httpMaxRetriesError(), httpErrorResponse(403)]) {
    const admin = fakeAdmin(() => {
      throw thrown;
    });
    assert.deepEqual(await getActiveLocations(admin, { wait: noWait }), []);
  }
});

test("getActiveLocations: THROTTLED is retried after a wait, then the reply is used", async () => {
  const waits = [];
  const admin = fakeAdmin((name, vars, calls) => {
    if (calls.length === 1) throw graphqlQueryError(THROTTLED);
    return IDS_ONLY_REPLY;
  });
  const locations = await getActiveLocations(admin, { wait: async (ms) => waits.push(ms) });
  assert.equal(locations.length, 3);
  assert.equal(admin.calls.length, 2);
  assert.deepEqual(waits, [1000]);
});

test("getActiveLocations: THROTTLED every time gives up after THROTTLE_RETRIES and fails safe", async () => {
  const admin = fakeAdmin(() => {
    throw graphqlQueryError(THROTTLED);
  });
  assert.deepEqual(await getActiveLocations(admin, { wait: noWait }), []);
  assert.equal(admin.calls.length, THROTTLE_RETRIES + 1);
});
