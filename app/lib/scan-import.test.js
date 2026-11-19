import test from "node:test";
import assert from "node:assert/strict";
import { MIN_SECRET_LENGTH, parseScanSetNumber, scanImportConfigured, secretMatches } from "./scan-import.js";

const SECRET = "a".repeat(MIN_SECRET_LENGTH);

test("scanImportConfigured: only a long enough secret counts", () => {
  assert.equal(scanImportConfigured(undefined), false);
  assert.equal(scanImportConfigured(""), false);
  assert.equal(scanImportConfigured("short"), false);
  assert.equal(scanImportConfigured("a".repeat(MIN_SECRET_LENGTH - 1)), false);
  assert.equal(scanImportConfigured(SECRET), true);
});

test("secretMatches: the exact Bearer secret only", () => {
  assert.equal(secretMatches(`Bearer ${SECRET}`, SECRET), true);
  assert.equal(secretMatches(`  Bearer ${SECRET}  `, SECRET), true);
  assert.equal(secretMatches(`Bearer ${SECRET}x`, SECRET), false);
  assert.equal(secretMatches(`bearer ${SECRET}`, SECRET), false);
  assert.equal(secretMatches(SECRET, SECRET), false);
  assert.equal(secretMatches(null, SECRET), false);
  assert.equal(secretMatches("Bearer ", SECRET), false);
});

test("secretMatches: an unset or short secret opens nothing, even when the header matches it", () => {
  assert.equal(secretMatches("Bearer ", ""), false);
  assert.equal(secretMatches("Bearer short", "short"), false);
  assert.equal(secretMatches("Bearer undefined", undefined), false);
});

test("parseScanSetNumber: set numbers only", () => {
  assert.equal(parseScanSetNumber({ setNumber: "75313" }), "75313");
  assert.equal(parseScanSetNumber({ setNumber: " 75313-1 " }), "75313-1");
  assert.equal(parseScanSetNumber({ setNumber: "910001" }), "910001");
  assert.equal(parseScanSetNumber({ setNumber: "75313U" }), null);
  assert.equal(parseScanSetNumber({ setNumber: "75313, 10305" }), null);
  assert.equal(parseScanSetNumber({ setNumber: "sw0001" }), null);
  assert.equal(parseScanSetNumber({ setNumber: "12" }), null);
  assert.equal(parseScanSetNumber({ setNumber: 75313 }), null);
  assert.equal(parseScanSetNumber({}), null);
  assert.equal(parseScanSetNumber(null), null);
});
