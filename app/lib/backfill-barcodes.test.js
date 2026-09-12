// Unit tests for the pure barcode helpers used by the backfill and importer.
// Run with: npm test   (uses Node's built-in test runner, no extra deps)
//
// Fixture provenance:
//   - Brickset objects ({ number, barcode: { EAN, UPC } }) are OBSERVED from
//     the live Brickset v3 getSets response and can be asserted on.
//   - Shopify `barcodes` rows ({ value, type }) are DERIVED FROM THE
//     shopify.dev 2026-10 DOCS (ProductVariantBarcode: value String!, type
//     BarcodeType), NOT observed from a live call. Every test that builds one
//     asserts only on the pure merge logic, never on a live payload shape.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parseSku,
  buildBarcodeMap,
  classifyVariant,
  existingBarcodes,
} from "./backfill-barcodes.server.js";
import {
  MAX_BARCODES,
  bricksetBarcodes,
  describeBarcodes,
  mergeBarcodes,
  normaliseBarcodeValue,
} from "./barcodes.js";

// Observed Brickset getSets rows (barcode object is top level on the set).
const BRICKSET_40760 = { number: "40760", barcode: { EAN: "5702016867473", UPC: "673419320801" } };
const BRICKSET_75192 = { number: "75192", barcode: { EAN: "5702015869935", UPC: "" } };
const BRICKSET_12345_EMPTY = { number: "12345", barcode: { EAN: "", UPC: "" } };

// Shopify variant node shape below is derived from the 2026-10 docs
// (ProductVariant.barcode, ProductVariant.barcodes { nodes { value type } }),
// not observed from a live call.
function variantNode({ legacy = "", rows = [] } = {}) {
  return { id: "gid://shopify/ProductVariant/1", barcode: legacy, barcodes: { nodes: rows } };
}

/* ---------------- parseSku ---------------- */

test("parseSku: bare numeric SKU assumes variant 1", () => {
  assert.deepEqual(parseSku("40760"), { clean: "40760", query: "40760-1" });
  assert.deepEqual(parseSku("75192"), { clean: "75192", query: "75192-1" });
});

test("parseSku: full set number keeps its explicit variant", () => {
  assert.deepEqual(parseSku("40760-1"), { clean: "40760", query: "40760-1" });
  assert.deepEqual(parseSku("6876-2"), { clean: "6876", query: "6876-2" });
});

test("parseSku: trims surrounding whitespace", () => {
  assert.deepEqual(parseSku("  40760 "), { clean: "40760", query: "40760-1" });
});

test("parseSku: rejects non-set SKUs", () => {
  assert.equal(parseSku(""), null);
  assert.equal(parseSku(null), null);
  assert.equal(parseSku(undefined), null);
  assert.equal(parseSku("TSHIRT-1"), null);
  assert.equal(parseSku("ABC"), null);
  assert.equal(parseSku("40760-X"), null);
});

/* ---------------- buildBarcodeMap ---------------- */

test("buildBarcodeMap: maps clean number to trimmed EAN and UPC", () => {
  const map = buildBarcodeMap([
    { number: "40760", barcode: { EAN: " 5702016867473 ", UPC: " 673419320801 " } },
    BRICKSET_75192,
  ]);
  assert.deepEqual(map.get("40760"), { ean: "5702016867473", upc: "673419320801" });
  assert.deepEqual(map.get("75192"), { ean: "5702015869935", upc: "" });
});

test("buildBarcodeMap: keeps key with empty values so 'found but no barcode' is distinguishable", () => {
  const map = buildBarcodeMap([BRICKSET_12345_EMPTY]);
  assert.equal(map.has("12345"), true);
  assert.deepEqual(map.get("12345"), { ean: "", upc: "" });
});

test("buildBarcodeMap: handles missing barcode object and numeric number", () => {
  const map = buildBarcodeMap([{ number: 12345 }]);
  assert.equal(map.has("12345"), true);
  assert.deepEqual(map.get("12345"), { ean: "", upc: "" });
});

test("buildBarcodeMap: prefers the entry with more barcode data on duplicates", () => {
  const map = buildBarcodeMap([
    { number: "40760", barcode: { EAN: "5702016867473", UPC: "" } },
    BRICKSET_40760,
    { number: "40760", barcode: { EAN: "", UPC: "" } },
  ]);
  assert.deepEqual(map.get("40760"), { ean: "5702016867473", upc: "673419320801" });
});

/* ---------------- normaliseBarcodeValue / bricksetBarcodes ---------------- */

test("normaliseBarcodeValue: ignores whitespace and hyphens, upper-cases, keeps leading zeros", () => {
  assert.equal(normaliseBarcodeValue(" 5702-0168 67473 "), "5702016867473");
  assert.equal(normaliseBarcodeValue("sw0197"), "SW0197");
  assert.equal(normaliseBarcodeValue("0673419320801"), "0673419320801");
  assert.equal(normaliseBarcodeValue(null), "");
});

test("bricksetBarcodes: EAN first as type EAN, UPC as type UPC", () => {
  assert.deepEqual(bricksetBarcodes({ ean: "5702016867473", upc: "673419320801" }), [
    { value: "5702016867473", type: "EAN" },
    { value: "673419320801", type: "UPC" },
  ]);
});

test("bricksetBarcodes: drops empty values and never writes empty strings", () => {
  assert.deepEqual(bricksetBarcodes({ ean: "5702015869935", upc: "" }), [
    { value: "5702015869935", type: "EAN" },
  ]);
  assert.deepEqual(bricksetBarcodes({ ean: "", upc: " 673419320801 " }), [
    { value: "673419320801", type: "UPC" },
  ]);
  assert.deepEqual(bricksetBarcodes({ ean: "", upc: "" }), []);
  assert.deepEqual(bricksetBarcodes({}), []);
  assert.deepEqual(bricksetBarcodes(), []);
});

test("bricksetBarcodes: identical EAN and UPC values produce one row", () => {
  assert.deepEqual(bricksetBarcodes({ ean: "5702016867473", upc: "5702016867473" }), [
    { value: "5702016867473", type: "EAN" },
  ]);
});

/* ---------------- mergeBarcodes ---------------- */

test("mergeBarcodes: empty variant gets both Brickset barcodes, typed", () => {
  const r = mergeBarcodes({ existing: [], legacyBarcode: "", brickset: { ean: "5702016867473", upc: "673419320801" } });
  assert.equal(r.changed, true);
  assert.deepEqual(r.barcodes, [
    { value: "5702016867473", type: "EAN" },
    { value: "673419320801", type: "UPC" },
  ]);
  assert.deepEqual(r.added, r.barcodes);
  assert.deepEqual(r.retyped, []);
  assert.deepEqual(r.notAdded, []);
});

test("mergeBarcodes: variant that already has its typed EAN still gets the missing UPC (merge, not fill)", () => {
  const r = mergeBarcodes({
    existing: [{ value: "5702016867473", type: "EAN" }],
    brickset: { ean: "5702016867473", upc: "673419320801" },
  });
  assert.equal(r.changed, true);
  assert.deepEqual(r.barcodes, [
    { value: "5702016867473", type: "EAN" },
    { value: "673419320801", type: "UPC" },
  ]);
  assert.deepEqual(r.added, [{ value: "673419320801", type: "UPC" }]);
});

test("mergeBarcodes: nothing to add -> changed is false so the caller skips the write", () => {
  const r = mergeBarcodes({
    existing: [
      { value: "5702016867473", type: "EAN" },
      { value: "673419320801", type: "UPC" },
    ],
    brickset: { ean: "5702016867473", upc: "673419320801" },
  });
  assert.equal(r.changed, false);
  assert.deepEqual(r.added, []);
  assert.deepEqual(r.retyped, []);
});

test("mergeBarcodes: existing rows are kept untouched, in order, ahead of the additions", () => {
  const existing = [
    { value: "9780262033848", type: "ISBN" },
    { value: "ABC-123", type: null },
    { value: "00012345678905", type: "GTIN" },
  ];
  const r = mergeBarcodes({ existing, brickset: { ean: "5702016867473", upc: "673419320801" } });
  assert.deepEqual(r.barcodes.slice(0, 3), existing);
  assert.deepEqual(r.barcodes.slice(3), [
    { value: "5702016867473", type: "EAN" },
    { value: "673419320801", type: "UPC" },
  ]);
});

test("mergeBarcodes: a value already present under another type is not duplicated and keeps its type", () => {
  const r = mergeBarcodes({
    existing: [{ value: "5702016867473", type: "GTIN" }],
    brickset: { ean: "5702016867473", upc: "" },
  });
  assert.equal(r.changed, false);
  assert.deepEqual(r.barcodes, [{ value: "5702016867473", type: "GTIN" }]);
});

test("mergeBarcodes: presence is decided on normalised digits, ignoring spaces, hyphens and type", () => {
  const r = mergeBarcodes({
    existing: [{ value: "5702-0168-67473", type: "EAN" }],
    brickset: { ean: " 5702016867473 ", upc: "" },
  });
  assert.equal(r.changed, false);
  assert.deepEqual(r.barcodes, [{ value: "5702-0168-67473", type: "EAN" }]);
});

test("mergeBarcodes: an untyped existing row that matches the Brickset EAN becomes a typed EAN row, not a duplicate", () => {
  // A barcode written through the legacy single `barcode` field has no type;
  // on 2026-10 it is the first entry of `barcodes` with type null.
  const r = mergeBarcodes({
    existing: [{ value: "5702016867473", type: null }],
    legacyBarcode: "5702016867473",
    brickset: { ean: "5702016867473", upc: "673419320801" },
  });
  assert.equal(r.changed, true);
  assert.deepEqual(r.barcodes, [
    { value: "5702016867473", type: "EAN" },
    { value: "673419320801", type: "UPC" },
  ]);
  assert.deepEqual(r.retyped, [{ value: "5702016867473", type: "EAN" }]);
  assert.deepEqual(r.added, [{ value: "673419320801", type: "UPC" }]);
});

test("mergeBarcodes: an untyped existing row that matches the Brickset UPC becomes a typed UPC row", () => {
  const r = mergeBarcodes({
    existing: [{ value: "673419320801", type: null }],
    brickset: { ean: "", upc: "673419320801" },
  });
  assert.equal(r.changed, true);
  assert.deepEqual(r.barcodes, [{ value: "673419320801", type: "UPC" }]);
  assert.deepEqual(r.retyped, [{ value: "673419320801", type: "UPC" }]);
});

test("mergeBarcodes: legacy barcode missing from the list is carried through untyped so the replace-all write cannot drop it", () => {
  const r = mergeBarcodes({
    existing: [],
    legacyBarcode: "SW0197",
    brickset: { ean: "5702016867473", upc: "" },
  });
  assert.deepEqual(r.barcodes, [
    { value: "SW0197", type: null },
    { value: "5702016867473", type: "EAN" },
  ]);
  assert.equal(r.changed, true);
});

test("mergeBarcodes: legacy barcode that already appears in the list is not duplicated", () => {
  const r = mergeBarcodes({
    existing: [{ value: "5702016867473", type: "EAN" }],
    legacyBarcode: "5702016867473",
    brickset: { ean: "5702016867473", upc: "" },
  });
  assert.equal(r.changed, false);
  assert.deepEqual(r.barcodes, [{ value: "5702016867473", type: "EAN" }]);
});

test("mergeBarcodes: untyped existing row that does not match Brickset keeps its null type", () => {
  const r = mergeBarcodes({
    existing: [{ value: "1234567890123", type: null }],
    brickset: { ean: "5702016867473", upc: "" },
  });
  assert.deepEqual(r.barcodes, [
    { value: "1234567890123", type: null },
    { value: "5702016867473", type: "EAN" },
  ]);
  assert.deepEqual(r.retyped, []);
});

test("mergeBarcodes: never exceeds 20 rows and reports what could not be added", () => {
  const existing = Array.from({ length: MAX_BARCODES }, (_, i) => ({
    value: String(1000000000000 + i),
    type: null,
  }));
  const r = mergeBarcodes({ existing, brickset: { ean: "5702016867473", upc: "673419320801" } });
  assert.equal(r.barcodes.length, MAX_BARCODES);
  assert.equal(r.changed, false);
  assert.deepEqual(r.added, []);
  assert.equal(r.notAdded.length, 2);
  assert.equal(r.notAdded[0].value, "5702016867473");
  assert.match(r.notAdded[0].reason, /20 barcodes/);
});

test("mergeBarcodes: with 19 rows only the EAN fits and the UPC is reported", () => {
  const existing = Array.from({ length: MAX_BARCODES - 1 }, (_, i) => ({
    value: String(1000000000000 + i),
    type: null,
  }));
  const r = mergeBarcodes({ existing, brickset: { ean: "5702016867473", upc: "673419320801" } });
  assert.equal(r.barcodes.length, MAX_BARCODES);
  assert.equal(r.changed, true);
  assert.deepEqual(r.added, [{ value: "5702016867473", type: "EAN" }]);
  assert.deepEqual(r.notAdded.map((n) => n.value), ["673419320801"]);
});

test("mergeBarcodes: empty and whitespace values are never written", () => {
  const r = mergeBarcodes({
    existing: [{ value: "", type: null }, { value: "   ", type: "EAN" }],
    legacyBarcode: "  ",
    brickset: { ean: "", upc: "" },
  });
  assert.deepEqual(r.barcodes, []);
  assert.equal(r.changed, false);
});

test("mergeBarcodes: duplicate existing values are collapsed to one row", () => {
  const r = mergeBarcodes({
    existing: [
      { value: "5702016867473", type: "EAN" },
      { value: "5702016867473", type: "EAN" },
    ],
    brickset: { ean: "5702016867473", upc: "" },
  });
  assert.deepEqual(r.barcodes, [{ value: "5702016867473", type: "EAN" }]);
  assert.equal(r.changed, true);
});

test("mergeBarcodes: tolerates missing arguments", () => {
  assert.deepEqual(mergeBarcodes(), { barcodes: [], changed: false, added: [], retyped: [], notAdded: [] });
  assert.deepEqual(mergeBarcodes({ existing: null, brickset: null }).barcodes, []);
});

test("describeBarcodes: readable summary for logs and the import result row", () => {
  assert.equal(
    describeBarcodes([{ value: "5702016867473", type: "EAN" }, { value: "SW0197", type: null }]),
    "EAN 5702016867473, SW0197"
  );
  assert.equal(describeBarcodes([]), "");
});

/* ---------------- existingBarcodes / classifyVariant ---------------- */

test("existingBarcodes: reads nodes, tolerates edges, and copes with a missing connection", () => {
  const rows = [{ value: "5702016867473", type: "EAN" }];
  assert.deepEqual(existingBarcodes({ barcodes: { nodes: rows } }), rows);
  assert.deepEqual(existingBarcodes({ barcodes: { edges: [{ node: rows[0] }] } }), rows);
  assert.deepEqual(existingBarcodes({}), []);
  assert.deepEqual(existingBarcodes(null), []);
});

test("classifyVariant: empty variant with Brickset data -> update with both typed barcodes", () => {
  const map = buildBarcodeMap([BRICKSET_40760]);
  const r = classifyVariant(variantNode(), parseSku("40760"), map);
  assert.equal(r.outcome, "update");
  assert.equal(r.existingCount, 0);
  assert.deepEqual(r.barcodes, [
    { value: "5702016867473", type: "EAN" },
    { value: "673419320801", type: "UPC" },
  ]);
});

test("classifyVariant: variant with only its EAN -> update adds the UPC (no longer fill-only)", () => {
  const map = buildBarcodeMap([BRICKSET_40760]);
  const node = variantNode({ legacy: "5702016867473", rows: [{ value: "5702016867473", type: "EAN" }] });
  const r = classifyVariant(node, parseSku("40760"), map);
  assert.equal(r.outcome, "update");
  assert.equal(r.existingCount, 1);
  assert.deepEqual(r.added, [{ value: "673419320801", type: "UPC" }]);
});

test("classifyVariant: variant already complete -> unchanged", () => {
  const map = buildBarcodeMap([BRICKSET_40760]);
  const node = variantNode({
    legacy: "5702016867473",
    rows: [
      { value: "5702016867473", type: "EAN" },
      { value: "673419320801", type: "UPC" },
    ],
  });
  const r = classifyVariant(node, parseSku("40760"), map);
  assert.deepEqual(r, { outcome: "unchanged", existingCount: 2 });
});

test("classifyVariant: legacy untyped EAN only -> update that retypes it and adds the UPC", () => {
  const map = buildBarcodeMap([BRICKSET_40760]);
  const node = variantNode({ legacy: "5702016867473", rows: [{ value: "5702016867473", type: null }] });
  const r = classifyVariant(node, parseSku("40760"), map);
  assert.equal(r.outcome, "update");
  assert.deepEqual(r.retyped, [{ value: "5702016867473", type: "EAN" }]);
  assert.deepEqual(r.barcodes, [
    { value: "5702016867473", type: "EAN" },
    { value: "673419320801", type: "UPC" },
  ]);
});

test("classifyVariant: legacy barcode with an empty barcodes list is still counted as existing", () => {
  const map = buildBarcodeMap([BRICKSET_75192]);
  const node = variantNode({ legacy: "5702015869935", rows: [] });
  const r = classifyVariant(node, parseSku("75192"), map);
  assert.equal(r.existingCount, 1);
  // The row is carried through and gains its type; no duplicate.
  assert.equal(r.outcome, "update");
  assert.deepEqual(r.barcodes, [{ value: "5702015869935", type: "EAN" }]);
});

test("classifyVariant: set found but no EAN and no UPC -> noBricksetData", () => {
  const map = buildBarcodeMap([BRICKSET_12345_EMPTY]);
  const r = classifyVariant(variantNode(), parseSku("12345"), map);
  assert.deepEqual(r, { outcome: "noBricksetData", existingCount: 0 });
});

test("classifyVariant: set not on Brickset -> notFound, reporting how many barcodes it already has", () => {
  const map = buildBarcodeMap([]);
  const node = variantNode({ rows: [{ value: "1234567890123", type: null }] });
  const r = classifyVariant(node, parseSku("99999"), map);
  assert.deepEqual(r, { outcome: "notFound", existingCount: 1 });
});

test("classifyVariant: non-set SKU -> skipped", () => {
  const map = buildBarcodeMap([BRICKSET_40760]);
  const r = classifyVariant(variantNode(), parseSku("TSHIRT-1"), map);
  assert.deepEqual(r, { outcome: "skipped", existingCount: 0 });
});
