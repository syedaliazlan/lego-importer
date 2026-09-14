// Unit tests for the pure variant-selection rules behind the CSV upload.
// Run with: npm test
//
// Variant fixtures are shaped like the backfill's page query
// ({ id, sku, barcode, barcodes: { nodes } , product }), derived from the
// shopify.dev 2026-10 docs, and only the SKU matching logic is asserted here.

import { test } from "node:test";
import assert from "node:assert/strict";

import { pickVariantForSetNumber, skuSearchQuery, CSV_CHUNK_ROWS } from "./barcode-csv-apply.server.js";

const v = (id, sku) => ({ id: `gid://shopify/ProductVariant/${id}`, sku, product: { id: `gid://shopify/Product/${id}`, title: `Set ${sku}` } });

test("skuSearchQuery: plain set numbers search by the clean number", () => {
  assert.equal(skuSearchQuery("40760"), "sku:40760");
  assert.equal(skuSearchQuery("40760-1"), "sku:40760");
  assert.equal(skuSearchQuery("40760-2"), "sku:40760");
  assert.equal(skuSearchQuery(" sw0197 "), "sku:sw0197");
});

test("skuSearchQuery: odd characters are quoted for the search syntax", () => {
  assert.equal(skuSearchQuery('T "shirt" L'), 'sku:"T \\"shirt\\" L"');
});

test("pickVariantForSetNumber: exact SKU wins over a set number match", () => {
  const list = [v(1, "40760"), v(2, "40760-2")];
  assert.equal(pickVariantForSetNumber("40760-2", list).variant.id, v(2).id);
  assert.equal(pickVariantForSetNumber("40760", list).variant.id, v(1).id);
});

test("pickVariantForSetNumber: exact match is case-insensitive and trimmed", () => {
  const list = [v(1, "sw0197")];
  assert.equal(pickVariantForSetNumber(" SW0197 ", list).variant.id, v(1).id);
});

test("pickVariantForSetNumber: 40760-1 in the file finds SKU 40760, and the other way round", () => {
  assert.equal(pickVariantForSetNumber("40760-1", [v(1, "40760")]).variant.id, v(1).id);
  assert.equal(pickVariantForSetNumber("40760", [v(1, "40760-1")]).variant.id, v(1).id);
});

test("pickVariantForSetNumber: only one variant of the set exists, so the clean number finds it", () => {
  assert.equal(pickVariantForSetNumber("40760", [v(2, "40760-2")]).variant.id, v(2).id);
});

test("pickVariantForSetNumber: several variants of the set and no exact SKU is ambiguous", () => {
  const r = pickVariantForSetNumber("40760", [v(2, "40760-2"), v(3, "40760-3")]);
  assert.equal(r.variant, null);
  assert.equal(r.ambiguous, true);
  assert.match(r.message, /40760-2, 40760-3/);
  assert.match(r.message, /exact SKU/);
});

test("pickVariantForSetNumber: two products with the same exact SKU is ambiguous, not a silent pick", () => {
  const r = pickVariantForSetNumber("40760", [v(1, "40760"), v(9, "40760")]);
  assert.equal(r.variant, null);
  assert.equal(r.ambiguous, true);
});

test("pickVariantForSetNumber: unrelated search hits are not matched", () => {
  const r = pickVariantForSetNumber("40760", [v(5, "407601"), v(6, "TSHIRT-40760")]);
  assert.equal(r.variant, null);
  assert.equal(r.ambiguous, false);
  assert.match(r.message, /No product with SKU 40760/);
});

test("pickVariantForSetNumber: empty list and blank set number", () => {
  assert.equal(pickVariantForSetNumber("40760", []).variant, null);
  assert.match(pickVariantForSetNumber("", [v(1, "")]).message, /blank/);
});

test("CSV_CHUNK_ROWS is small enough for one request", () => {
  assert.ok(CSV_CHUNK_ROWS >= 10 && CSV_CHUNK_ROWS <= 50);
});
