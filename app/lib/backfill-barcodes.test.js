// Unit tests for the pure matching helpers in backfill-barcodes.server.js.
// Run with: npm test   (uses Node's built-in test runner, no extra deps)

import { test } from "node:test";
import assert from "node:assert/strict";

import { parseSku, buildEanMap, classifyVariant } from "./backfill-barcodes.server.js";

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

test("buildEanMap: maps clean number to trimmed EAN", () => {
  const map = buildEanMap([
    { number: "40760", barcode: { EAN: " 5702016867473 ", UPC: "673419320801" } },
    { number: "75192", barcode: { EAN: "5702015869935", UPC: "" } },
  ]);
  assert.equal(map.get("40760"), "5702016867473");
  assert.equal(map.get("75192"), "5702015869935");
});

test("buildEanMap: keeps key with empty EAN so 'found but no EAN' is distinguishable", () => {
  const map = buildEanMap([{ number: "12345", barcode: { EAN: "", UPC: "" } }]);
  assert.equal(map.has("12345"), true);
  assert.equal(map.get("12345"), "");
});

test("buildEanMap: handles missing barcode object and numeric number", () => {
  const map = buildEanMap([{ number: 12345 }]);
  assert.equal(map.has("12345"), true);
  assert.equal(map.get("12345"), "");
});

test("buildEanMap: prefers the entry that actually has an EAN on duplicates", () => {
  const map = buildEanMap([
    { number: "40760", barcode: { EAN: "" } },
    { number: "40760", barcode: { EAN: "5702016867473" } },
  ]);
  assert.equal(map.get("40760"), "5702016867473");
});

test("classifyVariant: existing barcode is left untouched (fill-only)", () => {
  const map = buildEanMap([{ number: "40760", barcode: { EAN: "5702016867473" } }]);
  const r = classifyVariant({ barcode: "1234567890123" }, parseSku("40760"), map);
  assert.equal(r.outcome, "alreadySet");
});

test("classifyVariant: fills when an EAN is available", () => {
  const map = buildEanMap([{ number: "40760", barcode: { EAN: "5702016867473" } }]);
  const r = classifyVariant({ barcode: "" }, parseSku("40760"), map);
  assert.deepEqual(r, { outcome: "fill", ean: "5702016867473" });
});

test("classifyVariant: set found but no EAN -> missingEan", () => {
  const map = buildEanMap([{ number: "12345", barcode: { EAN: "" } }]);
  const r = classifyVariant({ barcode: "" }, parseSku("12345"), map);
  assert.equal(r.outcome, "missingEan");
});

test("classifyVariant: set not on Brickset -> notFound", () => {
  const map = buildEanMap([]);
  const r = classifyVariant({ barcode: "" }, parseSku("99999"), map);
  assert.equal(r.outcome, "notFound");
});

test("classifyVariant: non-set SKU with empty barcode -> skipped", () => {
  const map = buildEanMap([]);
  const r = classifyVariant({ barcode: "" }, parseSku("TSHIRT-1"), map);
  assert.equal(r.outcome, "skipped");
});
