// Tests for setting up a new product's variant and stocking it at every
// location. Run with: npm test
//
// Fixture provenance: reply shapes follow the shopify.dev 2026-10 docs for
// productVariantsBulkUpdate, InventoryItem.inventoryLevels and
// inventoryBulkToggleActivation (payload fields inventoryItem, inventoryLevels
// "The activated inventory levels.", userErrors { field message code }).
// The scenarios that combine them (a userError next to a partial list of
// levels, a reply lost after the change was applied) are HYPOTHETICAL, built
// to check how this code reports them, not observed live. Errors are thrown
// the way the real admin.graphql throws them (fake-admin.test-helper.js).

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  STOCKING_TRIES,
  THROTTLE_RETRIES,
  describeClientError,
  getFirstVariant,
  leftoverDraftMessage,
  setUpNewVariant,
  stockAtAllLocations,
} from "./shopify-product.server.js";
import {
  THROTTLED,
  fakeAdmin,
  graphqlQueryError,
  httpErrorResponse,
  httpMaxRetriesError,
} from "./fake-admin.test-helper.js";

const AYL = { id: "gid://shopify/Location/115870531959", name: "Aylesbury" };
const GLA = { id: "gid://shopify/Location/115809452407", name: "Glasgow" };
const WEB = { id: "gid://shopify/Location/106650468727", name: "warehouse" };
const LOCATIONS = [AYL, GLA, WEB];
const PRODUCT = "gid://shopify/Product/1";
const VARIANT = "gid://shopify/ProductVariant/1";
const ITEM = "gid://shopify/InventoryItem/1";
const noWait = async () => {};

const levelsReply = (locs) => ({
  data: { inventoryItem: { id: ITEM, inventoryLevels: { edges: locs.map((l) => ({ node: { location: { id: l.id } } })) } } },
});
const activationReply = (locs, userErrors = []) => ({
  data: {
    inventoryBulkToggleActivation: {
      inventoryItem: { id: ITEM },
      inventoryLevels: locs.map((l) => ({
        id: `gid://shopify/InventoryLevel/${l.id.split("/").pop()}?inventory_item_id=1`,
        location: { id: l.id },
        quantities: [{ name: "available", quantity: 0 }],
      })),
      userErrors,
    },
  },
});

/**
 * A small fake store for one new product: the variant starts with no SKU,
 * untracked, stocked only at the warehouse (where Shopify creates it).
 * Activation refuses with MISSING_SKU while the variant has no SKU, which is
 * what the 2026-10 InventoryBulkToggleActivationUserErrorCode allows.
 */
function fakeStore({ skuEcho = true, trackedEcho = true, activation } = {}) {
  const state = { sku: "", tracked: false, stocked: new Set([WEB.id]) };
  const steps = [];
  const admin = fakeAdmin((name, vars) => {
    if (name === "getProduct") {
      steps.push("read variant");
      return { data: { product: { variants: { edges: [{ node: { id: VARIANT, sku: state.sku, inventoryItem: { id: ITEM, tracked: state.tracked } } }] } } } };
    }
    if (name === "productVariantsBulkUpdate") {
      const input = vars.variants[0];
      if (input.inventoryItem?.sku !== undefined) {
        steps.push("sku");
        if (skuEcho) state.sku = input.inventoryItem.sku;
      } else if (input.inventoryItem?.tracked !== undefined) {
        steps.push("tracking");
        if (trackedEcho) state.tracked = true;
      } else {
        steps.push("barcodes");
      }
      return {
        data: {
          productVariantsBulkUpdate: {
            productVariants: [{ id: VARIANT, sku: state.sku, inventoryPolicy: "DENY", barcodes: { nodes: [] }, inventoryItem: { id: ITEM, tracked: state.tracked } }],
            userErrors: [],
          },
        },
      };
    }
    if (name === "ImportInventoryLevels") {
      steps.push("read levels");
      return levelsReply(LOCATIONS.filter((l) => state.stocked.has(l.id)));
    }
    if (name === "ImportStockAtLocations") {
      steps.push("activate");
      if (activation) return activation(vars, state);
      if (!state.sku) {
        return activationReply([], [{ field: ["inventoryItemUpdates"], message: "Cannot stock this inventory item at this location because the variant is missing a SKU.", code: "MISSING_SKU" }]);
      }
      const added = vars.inventoryItemUpdates.map((u) => LOCATIONS.find((l) => l.id === u.locationId));
      added.forEach((l) => state.stocked.add(l.id));
      return activationReply(added);
    }
    throw new Error(`unexpected operation ${name}`);
  });
  return { admin, state, steps };
}

/* ---------- 1. SKU before stocking ---------- */

test("setUpNewVariant: SKU is written before the item is stocked, so MISSING_SKU cannot happen", async () => {
  const { admin, steps, state } = fakeStore();
  const r = await setUpNewVariant(admin, { productId: PRODUCT, sku: "75192", barcodes: [], locations: LOCATIONS, wait: noWait });

  assert.deepEqual(steps, ["read variant", "barcodes", "sku", "tracking", "read levels", "activate"]);
  assert.ok(steps.indexOf("sku") < steps.indexOf("activate"));
  assert.equal(r.ok, true);
  assert.equal(r.skuSet, true);
  assert.equal(r.tracked, true);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.stocking.ok, true);
  assert.deepEqual(r.stocking.activated.map((l) => l.name), ["Aylesbury", "Glasgow"]);
  assert.deepEqual(r.stocking.alreadyActive.map((l) => l.name), ["warehouse"]);
  assert.deepEqual([...state.stocked].sort(), LOCATIONS.map((l) => l.id).sort());
});

test("both importers set up the variant through setUpNewVariant and never stock or set the SKU themselves", () => {
  for (const file of ["import-products.server.js", "import-minifigs.server.js"]) {
    const src = fs.readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
    assert.match(src, /await setUpNewVariant\(admin, \{/, `${file} calls setUpNewVariant`);
    for (const direct of ["stockAtAllLocations(", "setVariantSku(", "enableInventoryTracking(", "getFirstVariant(", "updateVariantFields("]) {
      assert.ok(!src.includes(direct), `${file} must not call ${direct} directly`);
    }
  }
});

/* ---------- 2. retries ---------- */

test("stocking path: every read and the activation ask the library for STOCKING_TRIES (network, 429, 503)", async () => {
  const { admin } = fakeStore();
  await setUpNewVariant(admin, { productId: PRODUCT, sku: "75192", barcodes: [], locations: LOCATIONS, wait: noWait });
  const stockingCalls = admin.calls.filter((c) => ["getProduct", "ImportInventoryLevels", "ImportStockAtLocations"].includes(c.name));
  assert.equal(stockingCalls.length, 3);
  for (const c of stockingCalls) assert.equal(c.options.tries, STOCKING_TRIES, c.name);
  // @shopify/graphql-client MAX_RETRIES is 3 and admin.graphql passes tries - 1.
  assert.ok(STOCKING_TRIES - 1 >= 1 && STOCKING_TRIES - 1 <= 3);
});

test("activation: THROTTLED is retried after a 1 s wait and then succeeds", async () => {
  const waits = [];
  let attempts = 0;
  const { admin } = fakeStore({
    activation: (vars, state) => {
      attempts += 1;
      if (attempts === 1) throw graphqlQueryError(THROTTLED);
      vars.inventoryItemUpdates.forEach((u) => state.stocked.add(u.locationId));
      return activationReply(LOCATIONS.filter((l) => vars.inventoryItemUpdates.some((u) => u.locationId === l.id)));
    },
  });
  const r = await stockAtAllLocations(admin, { inventoryItemId: ITEM, locations: LOCATIONS, wait: async (ms) => waits.push(ms) });
  assert.equal(r.ok, true);
  assert.equal(attempts, 2);
  assert.deepEqual(waits, [1000]);
});

test("activation: a GraphQL error that is not THROTTLED is not retried", async () => {
  let attempts = 0;
  const { admin } = fakeStore({
    activation: () => {
      attempts += 1;
      throw graphqlQueryError([{ message: "Internal error", extensions: { code: "INTERNAL_SERVER_ERROR" } }]);
    },
  });
  const r = await stockAtAllLocations(admin, { inventoryItemId: ITEM, locations: LOCATIONS, wait: noWait });
  assert.equal(attempts, 1);
  assert.equal(r.ok, false);
});

test("activation: THROTTLED every time stops after THROTTLE_RETRIES and reports it", async () => {
  let attempts = 0;
  const { admin } = fakeStore({
    activation: () => {
      attempts += 1;
      throw graphqlQueryError(THROTTLED);
    },
  });
  const r = await stockAtAllLocations(admin, { inventoryItemId: ITEM, locations: LOCATIONS, wait: noWait });
  assert.equal(attempts, THROTTLE_RETRIES + 1);
  assert.equal(r.ok, false);
  assert.equal(r.message, "stocked at warehouse; NOT stocked at Aylesbury, Glasgow (Shopify said: Throttled)");
});

test("activation: only ever activate:true for the missing locations, never a quantity", async () => {
  const { admin } = fakeStore();
  await setUpNewVariant(admin, { productId: PRODUCT, sku: "75192", barcodes: [], locations: LOCATIONS, wait: noWait });
  const activation = admin.calls.find((c) => c.name === "ImportStockAtLocations");
  assert.deepEqual(activation.variables, {
    inventoryItemId: ITEM,
    inventoryItemUpdates: [
      { locationId: AYL.id, activate: true },
      { locationId: GLA.id, activate: true },
    ],
  });
  assert.doesNotMatch(activation.query, /available\s*:|onHand|inventorySetQuantities|inventoryAdjustQuantities/);
});

/* ---------- 3. row messages name what took and what did not ---------- */

test("partial activation: the row names the locations that took and the one that did not", async () => {
  const { admin } = fakeStore({
    activation: (vars, state) => {
      state.stocked.add(AYL.id);
      return activationReply([AYL], [{ field: ["inventoryItemUpdates", "1", "locationId"], message: "Failed to stock this inventory item at this location.", code: "FAILED_TO_STOCK_AT_LOCATION" }]);
    },
  });
  const r = await stockAtAllLocations(admin, { inventoryItemId: ITEM, locations: LOCATIONS, wait: noWait });
  assert.equal(r.ok, false);
  assert.deepEqual(r.activated.map((l) => l.name), ["Aylesbury"]);
  assert.deepEqual(r.failed.map((l) => l.name), ["Glasgow"]);
  assert.equal(
    r.message,
    "stocked at warehouse, Aylesbury; NOT stocked at Glasgow (Shopify said: Failed to stock this inventory item at this location.)"
  );
});

test("reply lost after the change was applied: the re-read finds every location stocked, so it is ok", async () => {
  const { admin } = fakeStore({
    activation: (vars, state) => {
      vars.inventoryItemUpdates.forEach((u) => state.stocked.add(u.locationId));
      throw new Error("Http request error, no response available: fetch failed");
    },
  });
  const r = await stockAtAllLocations(admin, { inventoryItemId: ITEM, locations: LOCATIONS, wait: noWait });
  assert.equal(r.ok, true);
  assert.deepEqual(r.activated.map((l) => l.name), ["Aylesbury", "Glasgow"]);
  assert.equal(admin.calls.filter((c) => c.name === "ImportInventoryLevels").length, 2);
});

test("5xx after the library's retries, nothing applied: the row names every missing location", async () => {
  const { admin } = fakeStore({
    activation: () => {
      throw httpMaxRetriesError();
    },
  });
  const r = await stockAtAllLocations(admin, { inventoryItemId: ITEM, locations: LOCATIONS, wait: noWait });
  assert.equal(r.ok, false);
  assert.equal(
    r.message,
    "stocked at warehouse; NOT stocked at Aylesbury, Glasgow (Shopify said: Attempted the maximum number of retries for HTTP request.)"
  );
});

test("4xx rethrown as a Response: the row gives the status", async () => {
  const { admin } = fakeStore({
    activation: () => {
      throw httpErrorResponse(423);
    },
  });
  const r = await stockAtAllLocations(admin, { inventoryItemId: ITEM, locations: LOCATIONS, wait: noWait });
  assert.equal(r.ok, false);
  assert.equal(r.message, "stocked at warehouse; NOT stocked at Aylesbury, Glasgow (Shopify said: Shopify replied HTTP 423)");
});

test("payload leaves a location out with no userError: the re-read decides, and the row names it", async () => {
  const { admin } = fakeStore({
    activation: (vars, state) => {
      state.stocked.add(AYL.id);
      return activationReply([AYL]);
    },
  });
  const r = await stockAtAllLocations(admin, { inventoryItemId: ITEM, locations: LOCATIONS, wait: noWait });
  assert.equal(r.ok, false);
  assert.equal(r.message, "stocked at warehouse, Aylesbury; NOT stocked at Glasgow");
});

test("levels cannot be read: nothing is activated and the row says why", async () => {
  const admin = fakeAdmin(() => {
    throw graphqlQueryError([{ message: "Internal error", extensions: { code: "INTERNAL_SERVER_ERROR" } }]);
  });
  const r = await stockAtAllLocations(admin, { inventoryItemId: ITEM, locations: LOCATIONS, wait: noWait });
  assert.equal(r.ok, false);
  assert.equal(r.message, "could not check where it is already stocked, so no location was added (Internal error)");
  assert.ok(!admin.calls.some((c) => c.name === "ImportStockAtLocations"));
});

test("already stocked everywhere: no activation is sent", async () => {
  const admin = fakeAdmin((name) => {
    if (name === "ImportInventoryLevels") return levelsReply(LOCATIONS);
    throw new Error(`unexpected ${name}`);
  });
  const r = await stockAtAllLocations(admin, { inventoryItemId: ITEM, locations: LOCATIONS, wait: noWait });
  assert.equal(r.ok, true);
  assert.equal(admin.calls.length, 1);
});

/* ---------- 4. variant read failure, SKU and tracking results ---------- */

test("getFirstVariant: a thrown error comes back as ok:false, never thrown", async () => {
  const admin = fakeAdmin(() => {
    throw graphqlQueryError([{ message: "Internal error", extensions: { code: "INTERNAL_SERVER_ERROR" } }]);
  });
  const r = await getFirstVariant(admin, PRODUCT, "t", { wait: noWait });
  assert.deepEqual(r, { ok: false, errorCode: "VARIANT_QUERY_ERROR", message: "could not read its variant (Internal error)" });
});

test("setUpNewVariant: variant read failure stops before any write", async () => {
  const admin = fakeAdmin((name) => {
    if (name === "getProduct") throw httpMaxRetriesError();
    throw new Error(`unexpected ${name}`);
  });
  const r = await setUpNewVariant(admin, { productId: PRODUCT, sku: "75192", barcodes: [], locations: LOCATIONS, wait: noWait });
  assert.equal(r.ok, false);
  assert.equal(r.errorCode, "VARIANT_QUERY_ERROR");
  assert.equal(r.message, "could not read its variant (Attempted the maximum number of retries for HTTP request.)");
  assert.equal(admin.calls.length, 1);
});

test("leftoverDraftMessage: names the draft, its admin id and what to do", () => {
  const text = leftoverDraftMessage({
    title: "Millennium Falcon 75192 | Star Wars | LEGO",
    productId: PRODUCT,
    importId: "75192-1",
    reason: "could not read its variant (Internal error)",
  });
  assert.match(text, /^Created draft "Millennium Falcon 75192 \| Star Wars \| LEGO" \(gid:\/\/shopify\/Product\/1\) but could not read its variant \(Internal error\)\./);
  assert.match(text, /Delete that draft in Shopify, then import 75192-1 again\.$/);
  assert.match(text, /re-import cannot see it and would make a duplicate/);
});

test("setUpNewVariant: SKU and tracking that did not take are returned as row warnings", async () => {
  const { admin } = fakeStore({ skuEcho: false, trackedEcho: false });
  const r = await setUpNewVariant(admin, { productId: PRODUCT, sku: "75192", barcodes: [], locations: LOCATIONS, wait: noWait });
  assert.equal(r.ok, true);
  assert.equal(r.skuSet, false);
  assert.equal(r.tracked, false);
  assert.deepEqual(r.warnings, [
    "SKU not set: set it to 75192 in Shopify, otherwise a re-import cannot see this product and will make a duplicate",
    "inventory tracking is off: open the variant in Shopify and tick Track quantity",
  ]);
  // With no SKU the fake store refuses with MISSING_SKU, and the row says so.
  assert.equal(r.stocking.ok, false);
  assert.match(r.stocking.message, /NOT stocked at Aylesbury, Glasgow \(Shopify said: Cannot stock .* missing a SKU\.\)/);
});

/* ---------- 5. errors as the real library throws them ---------- */

test("describeClientError: GraphqlQueryError message, HttpMaxRetriesError, Response status, plain errors", () => {
  assert.equal(describeClientError(graphqlQueryError(THROTTLED)), "Throttled");
  assert.equal(describeClientError(httpMaxRetriesError()), "Attempted the maximum number of retries for HTTP request.");
  assert.equal(describeClientError(httpErrorResponse(404)), "Shopify replied HTTP 404");
  assert.equal(describeClientError(new Error("fetch failed")), "fetch failed");
  assert.equal(describeClientError(undefined), "Unknown error");
  assert.equal(describeClientError({}), "Unknown error");
});
