// Unit tests for the pure CSV parsing and validation behind the
// "Add barcodes from a CSV" upload. Run with: npm test
//
// Every barcode fixture here is a real GS1 number with a correct check digit
// (5702016867473 and 673419320801 are set 40760's EAN and UPC as observed on
// Brickset), so a failing test means the rule changed, not the fixture.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  MAX_CSV_BYTES,
  MAX_CSV_ROWS,
  detectColumns,
  digitsOnly,
  gs1CheckDigitOk,
  parseBarcodeCsv,
  parseCsv,
  validateBarcode,
} from "./barcode-csv.js";
import { mergeBarcodes } from "./barcodes.js";

const EAN_40760 = "5702016867473";
const UPC_40760 = "673419320801";
const EAN8_OK = "96385074"; // classic GS1 example
const GTIN14_OK = "10614141000415"; // GS1 example GTIN-14

/* ---------------- parseCsv ---------------- */

test("parseCsv: plain rows with LF", () => {
  assert.deepEqual(parseCsv("a,b\n1,2\n"), [["a", "b"], ["1", "2"]]);
});

test("parseCsv: CRLF line endings", () => {
  assert.deepEqual(parseCsv("a,b\r\n1,2\r\n3,4"), [["a", "b"], ["1", "2"], ["3", "4"]]);
});

test("parseCsv: lone CR line endings", () => {
  assert.deepEqual(parseCsv("a,b\r1,2"), [["a", "b"], ["1", "2"]]);
});

test("parseCsv: quoted field with comma and doubled quote", () => {
  assert.deepEqual(parseCsv('x,"Hello, ""World""",y'), [["x", 'Hello, "World"', "y"]]);
});

test("parseCsv: quoted field spanning a newline", () => {
  assert.deepEqual(parseCsv('a,"line1\nline2",b'), [["a", "line1\nline2", "b"]]);
});

test("parseCsv: strips a leading UTF-8 BOM", () => {
  assert.deepEqual(parseCsv("\uFEFFSet Number,EAN\n1,2"), [["Set Number", "EAN"], ["1", "2"]]);
});

test("parseCsv: empty cells and trailing comma are kept", () => {
  assert.deepEqual(parseCsv("a,,c,\n"), [["a", "", "c", ""]]);
});

test("parseCsv: mid field quote is a literal", () => {
  assert.deepEqual(parseCsv('12" set,x'), [['12" set', "x"]]);
});

/* ---------------- detectColumns ---------------- */

test("detectColumns: case-insensitive, extra columns ignored, order free", () => {
  const r = detectColumns(["Reason", " ean ", "Product Name", "SET NUMBER", "Upc", "gtin"]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.columns, { setNumber: 3, ean: 1, upc: 4, gtin: 5 });
  assert.deepEqual(r.ignored, ["Reason", "Product Name"]);
});

test("detectColumns: the backfill export header plus EAN and UPC works", () => {
  const r = detectColumns(["Set Number", "Product Name", "Reason", "EAN", "UPC"]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.columns, { setNumber: 0, ean: 3, upc: 4, gtin: -1 });
});

test("detectColumns: missing Set Number is a file error", () => {
  const r = detectColumns(["Product Name", "EAN"]);
  assert.equal(r.ok, false);
  assert.match(r.message, /Set Number/);
});

test("detectColumns: no barcode column at all is a file error", () => {
  const r = detectColumns(["Set Number", "Product Name"]);
  assert.equal(r.ok, false);
  assert.match(r.message, /EAN.*UPC.*GTIN/);
});

test("detectColumns: a repeated header keeps the first and ignores the second", () => {
  const r = detectColumns(["Set Number", "EAN", "EAN"]);
  assert.equal(r.ok, true);
  assert.equal(r.columns.ean, 1);
  assert.deepEqual(r.ignored, ["EAN"]);
});

/* ---------------- digits + check digit ---------------- */

test("digitsOnly strips spaces, hyphens and anything else", () => {
  assert.equal(digitsOnly(" 5702-0168 67473 "), EAN_40760);
  assert.equal(digitsOnly("abc"), "");
  assert.equal(digitsOnly(null), "");
});

test("gs1CheckDigitOk: real numbers pass, one digit off fails", () => {
  assert.equal(gs1CheckDigitOk(EAN_40760), true);
  assert.equal(gs1CheckDigitOk(UPC_40760), true);
  assert.equal(gs1CheckDigitOk(EAN8_OK), true);
  assert.equal(gs1CheckDigitOk(GTIN14_OK), true);
  assert.equal(gs1CheckDigitOk("5702016867474"), false);
  assert.equal(gs1CheckDigitOk("673419320802"), false);
  assert.equal(gs1CheckDigitOk("12345"), false);
});

/* ---------------- validateBarcode ---------------- */

test("validateBarcode: EAN accepts 13 and 8 digits, normalised", () => {
  assert.deepEqual(validateBarcode("EAN", "5702-0168-67473"), { ok: true, value: EAN_40760 });
  assert.deepEqual(validateBarcode("EAN", EAN8_OK), { ok: true, value: EAN8_OK });
});

test("validateBarcode: UPC needs 12, GTIN needs 14", () => {
  assert.deepEqual(validateBarcode("UPC", UPC_40760), { ok: true, value: UPC_40760 });
  assert.deepEqual(validateBarcode("GTIN", GTIN14_OK), { ok: true, value: GTIN14_OK });
  const bad = validateBarcode("UPC", EAN_40760);
  assert.equal(bad.ok, false);
  assert.match(bad.message, /13 digits, expected 12 digits/);
  const badGtin = validateBarcode("GTIN", EAN_40760);
  assert.equal(badGtin.ok, false);
  assert.match(badGtin.message, /expected 14 digits/);
});

test("validateBarcode: wrong length EAN is a row error with the count", () => {
  const r = validateBarcode("EAN", "12345");
  assert.equal(r.ok, false);
  assert.match(r.message, /5 digits, expected 13 or 8 digits/);
});

test("validateBarcode: wrong check digit is rejected", () => {
  const r = validateBarcode("EAN", "5702016867474");
  assert.equal(r.ok, false);
  assert.match(r.message, /check digit/);
});

test("validateBarcode: spreadsheet scientific notation is rejected, not shortened", () => {
  // "5.70202E+12" reduced to digits would be 8 digits and pass as an EAN-8.
  const r = validateBarcode("EAN", "5.70202E+12");
  assert.equal(r.ok, false);
  assert.match(r.message, /scientific/);
});

test("validateBarcode: no digits at all", () => {
  const r = validateBarcode("EAN", "n/a");
  assert.equal(r.ok, false);
  assert.match(r.message, /no digits/);
});

/* ---------------- parseBarcodeCsv ---------------- */

const HEADER = "Set Number,Product Name,Reason,EAN,UPC";

test("parseBarcodeCsv: the filled-in backfill export parses with extra columns tolerated", () => {
  const csv = [
    HEADER,
    `40760,"Bunny, Easter | LEGO","No barcode in Brickset, has none",${EAN_40760},${UPC_40760}`,
    `75192,Millennium Falcon,Not found on Brickset,${EAN_40760},`,
  ].join("\r\n");
  const r = parseBarcodeCsv(csv);
  assert.equal(r.ok, true);
  assert.deepEqual(r.ignoredColumns, ["Product Name", "Reason"]);
  assert.equal(r.rows.length, 2);

  assert.equal(r.rows[0].line, 2);
  assert.equal(r.rows[0].setNumber, "40760");
  assert.deepEqual(r.rows[0].barcodes, [
    { value: EAN_40760, type: "EAN" },
    { value: UPC_40760, type: "UPC" },
  ]);
  assert.deepEqual(r.rows[0].errors, []);

  assert.equal(r.rows[1].setNumber, "75192");
  assert.deepEqual(r.rows[1].barcodes, [{ value: EAN_40760, type: "EAN" }]);
  assert.deepEqual(r.rows[1].errors, []);
});

test("parseBarcodeCsv: GTIN column is optional and typed GTIN when present", () => {
  const r = parseBarcodeCsv(`Set Number,GTIN\n40760,${GTIN14_OK}`);
  assert.equal(r.ok, true);
  assert.deepEqual(r.rows[0].barcodes, [{ value: GTIN14_OK, type: "GTIN" }]);
});

test("parseBarcodeCsv: a bad value is a row error, the other rows still parse", () => {
  const csv = `Set Number,EAN\n40760,12345\n75192,${EAN_40760}`;
  const r = parseBarcodeCsv(csv);
  assert.equal(r.ok, true);
  assert.equal(r.rows[0].errors.length, 1);
  assert.match(r.rows[0].errors[0], /5 digits/);
  assert.deepEqual(r.rows[0].barcodes, []);
  assert.deepEqual(r.rows[1].errors, []);
  assert.equal(r.rows[1].barcodes.length, 1);
});

test("parseBarcodeCsv: a row with one good and one bad cell keeps the good barcode but is still an error row", () => {
  const r = parseBarcodeCsv(`Set Number,EAN,UPC\n40760,${EAN_40760},999`);
  assert.equal(r.ok, true);
  assert.equal(r.rows[0].errors.length, 1);
  assert.deepEqual(r.rows[0].barcodes, [{ value: EAN_40760, type: "EAN" }]);
});

test("parseBarcodeCsv: blank lines skipped, row with no barcode is an error, row with no set number is an error", () => {
  const csv = `Set Number,EAN,UPC\n\n40760,,\n,${EAN_40760},\n\n`;
  const r = parseBarcodeCsv(csv);
  assert.equal(r.ok, true);
  assert.equal(r.rows.length, 2);
  assert.match(r.rows[0].errors[0], /No EAN, UPC or GTIN/);
  assert.match(r.rows[1].errors[0], /No set number/);
});

test("parseBarcodeCsv: duplicate set numbers, last row wins and earlier rows are reported", () => {
  const csv = [
    "Set Number,EAN,UPC",
    `40760,${EAN_40760},`,
    `75192,${EAN_40760},`,
    `40760,,${UPC_40760}`,
  ].join("\n");
  const r = parseBarcodeCsv(csv);
  assert.equal(r.ok, true);
  assert.equal(r.rows[0].duplicateOfLine, 4);
  assert.match(r.rows[0].errors[0], /appears again on line 4/);
  assert.equal(r.rows[1].duplicateOfLine, null);
  assert.equal(r.rows[2].duplicateOfLine, null);
  assert.deepEqual(r.rows[2].errors, []);
  assert.deepEqual(r.rows[2].barcodes, [{ value: UPC_40760, type: "UPC" }]);
});

test("parseBarcodeCsv: duplicate detection ignores case and spaces around the set number", () => {
  const r = parseBarcodeCsv(`Set Number,EAN\n sw0197 ,${EAN_40760}\nSW0197,${EAN_40760}`);
  assert.equal(r.rows[0].duplicateOfLine, 3);
});

test("parseBarcodeCsv: file level errors", () => {
  assert.deepEqual(parseBarcodeCsv(""), { ok: false, message: "The file is empty." });
  assert.deepEqual(parseBarcodeCsv("\n\n  \n"), { ok: false, message: "The file is empty." });
  assert.match(parseBarcodeCsv("Set Number,EAN\n").message, /no data rows/);
  assert.match(parseBarcodeCsv("Product Name,EAN\n1,2").message, /Set Number/);
});

test("parseBarcodeCsv: row limit", () => {
  const lines = ["Set Number,EAN"];
  for (let i = 0; i < 3; i++) lines.push(`${40000 + i},${EAN_40760}`);
  const r = parseBarcodeCsv(lines.join("\n"), { maxRows: 2 });
  assert.equal(r.ok, false);
  assert.match(r.message, /3 data rows; the limit is 2/);
  assert.equal(parseBarcodeCsv(lines.join("\n"), { maxRows: 3 }).ok, true);
  assert.equal(MAX_CSV_ROWS, 2000);
});

test("parseBarcodeCsv: byte limit", () => {
  const r = parseBarcodeCsv("Set Number,EAN\n40760,5702016867473", { maxBytes: 10 });
  assert.equal(r.ok, false);
  assert.match(r.message, /limit is/);
  assert.equal(MAX_CSV_BYTES, 1024 * 1024);
});

/* ---------------- merge with explicit candidates (used by the CSV apply) ---------------- */

test("mergeBarcodes: candidates add typed rows, keep existing, skip present values", () => {
  const m = mergeBarcodes({
    existing: [{ value: EAN_40760, type: "EAN" }],
    candidates: [
      { value: EAN_40760, type: "EAN" },
      { value: UPC_40760, type: "UPC" },
      { value: GTIN14_OK, type: "GTIN" },
    ],
  });
  assert.equal(m.changed, true);
  assert.deepEqual(m.barcodes, [
    { value: EAN_40760, type: "EAN" },
    { value: UPC_40760, type: "UPC" },
    { value: GTIN14_OK, type: "GTIN" },
  ]);
  assert.deepEqual(m.added, [
    { value: UPC_40760, type: "UPC" },
    { value: GTIN14_OK, type: "GTIN" },
  ]);
});

test("mergeBarcodes: candidates give an untyped existing row its type, no duplicate", () => {
  const m = mergeBarcodes({
    existing: [{ value: EAN_40760, type: null }],
    candidates: [{ value: EAN_40760, type: "EAN" }],
  });
  assert.equal(m.changed, true);
  assert.deepEqual(m.barcodes, [{ value: EAN_40760, type: "EAN" }]);
  assert.deepEqual(m.retyped, [{ value: EAN_40760, type: "EAN" }]);
  assert.deepEqual(m.added, []);
});

test("mergeBarcodes: everything already present means no write", () => {
  const m = mergeBarcodes({
    existing: [
      { value: EAN_40760, type: "EAN" },
      { value: UPC_40760, type: "UPC" },
    ],
    candidates: [
      { value: EAN_40760, type: "EAN" },
      { value: UPC_40760, type: "UPC" },
    ],
  });
  assert.equal(m.changed, false);
  assert.deepEqual(m.added, []);
});

test("mergeBarcodes: an untyped candidate never retypes and never reports a retype", () => {
  const m = mergeBarcodes({
    existing: [{ value: "sw0197", type: null }],
    candidates: [{ value: "sw0197", type: null }],
  });
  assert.equal(m.changed, false);
  assert.deepEqual(m.retyped, []);
});
