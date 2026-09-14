// app/lib/barcode-csv.js
//
// Pure parsing and validation for the "Add barcodes from a CSV" upload on the
// backfill page. No I/O and no Shopify, so every rule here is unit tested.
//
// The contract the shop is told:
//   - First row is the header. Column names are matched ignoring case and
//     surrounding spaces: "Set Number" is required, and at least one of
//     "EAN", "UPC", "GTIN" must be present. Every other column ("Product
//     Name", "Reason", anything else) is ignored, so the flagged-list export
//     from the backfill can be filled in and uploaded as it is.
//   - Quoted fields, commas inside quotes, doubled quotes, CRLF line endings
//     and a UTF-8 BOM are all handled.
//   - Barcode cells are reduced to their digits, so "5702-0168-67473" and
//     "5702016867473 " are the same value.
//   - Lengths: EAN 13 or 8 digits, UPC 12, GTIN 14, and the GS1 check digit
//     must be right. A bad value makes that ROW an error; the rest of the file
//     still goes through. Nothing from an error row is written.
//   - A row with no set number, or with no barcode in any column, is an
//     error row. Blank lines are skipped.
//   - A cell like "5.70202E+12" is rejected: that is a spreadsheet showing a
//     long number in scientific form, and the digits are gone. Format the
//     column as Text and paste the full number.
//   - If a set number appears more than once, the LAST row wins and the
//     earlier rows are reported as duplicates. Rows are never merged.
//   - Limits: 1 MB and 2,000 data rows per file.

/** Largest file accepted, in bytes. */
export const MAX_CSV_BYTES = 1024 * 1024;

/** Most data rows (excluding the header) accepted in one file. */
export const MAX_CSV_ROWS = 2000;

/** Digit counts accepted per column, longest first for the error text. */
export const BARCODE_LENGTHS = {
  EAN: [13, 8],
  UPC: [12],
  GTIN: [14],
};

const COLUMN_ALIASES = {
  setNumber: ["set number", "set no", "set no.", "set_number", "setnumber", "set", "sku"],
  ean: ["ean", "ean-13", "ean13", "ean 13"],
  upc: ["upc", "upc-a", "upca", "upc a"],
  gtin: ["gtin", "gtin-14", "gtin14", "gtin 14"],
};

/**
 * Bytes a string takes as UTF-8. TextEncoder exists in browsers and Node.
 * @param {string} text
 */
export function utf8ByteLength(text) {
  return new TextEncoder().encode(String(text ?? "")).length;
}

/**
 * Minimal RFC 4180 style parser. Handles quoted fields, "" escapes inside
 * quotes, commas inside quotes, LF, CRLF and lone CR line endings, and a
 * leading BOM. A quote that appears mid field is kept as a literal.
 * @param {string} text
 * @returns {string[][]} rows of cells, untrimmed
 */
export function parseCsv(text) {
  const s = String(text ?? "").replace(/^\uFEFF/, "");
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  let fieldStarted = false; // whether any character has been seen in this field

  const endField = () => {
    row.push(field);
    field = "";
    fieldStarted = false;
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];

    if (inQuotes) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"' && !fieldStarted) {
      inQuotes = true;
      fieldStarted = true;
      continue;
    }
    if (ch === ",") {
      endField();
      continue;
    }
    if (ch === "\r") {
      if (s[i + 1] === "\n") i++;
      endRow();
      continue;
    }
    if (ch === "\n") {
      endRow();
      continue;
    }
    field += ch;
    fieldStarted = true;
  }

  // Flush a final line that has no trailing newline.
  if (field.length || fieldStarted || row.length) endRow();

  return rows;
}

function normaliseHeader(cell) {
  return String(cell ?? "")
    .replace(/^\uFEFF/, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

/**
 * Work out which column index holds what.
 * @param {string[]} headerRow
 * @returns {{ok: true, columns: {setNumber: number, ean: number, upc: number, gtin: number}, ignored: string[]} | {ok: false, message: string}}
 */
export function detectColumns(headerRow) {
  const cells = (headerRow || []).map(normaliseHeader);
  const columns = { setNumber: -1, ean: -1, upc: -1, gtin: -1 };
  const ignored = [];

  cells.forEach((name, idx) => {
    if (!name) return;
    const hit = Object.keys(COLUMN_ALIASES).find((k) => COLUMN_ALIASES[k].includes(name));
    if (hit && columns[hit] === -1) {
      columns[hit] = idx;
    } else {
      ignored.push(String(headerRow[idx]).trim());
    }
  });

  if (columns.setNumber === -1) {
    return {
      ok: false,
      message: `No "Set Number" column found in the header row (found: ${
        cells.filter(Boolean).join(", ") || "nothing"
      }).`,
    };
  }
  if (columns.ean === -1 && columns.upc === -1 && columns.gtin === -1) {
    return {
      ok: false,
      message: 'No "EAN", "UPC" or "GTIN" column found in the header row. Add at least one.',
    };
  }
  return { ok: true, columns, ignored };
}

/**
 * Keep only the digits of a cell.
 * @param {unknown} value
 */
export function digitsOnly(value) {
  return String(value ?? "").replace(/\D/g, "");
}

/**
 * GS1 modulo 10 check digit test. Works for EAN-8, UPC-A (12), EAN-13 and
 * GTIN-14: weights 3,1,3,1,... from the digit just left of the check digit.
 * @param {string} digits
 */
export function gs1CheckDigitOk(digits) {
  const d = String(digits ?? "");
  if (!/^\d{8}$|^\d{12,14}$/.test(d)) return false;
  let sum = 0;
  let weight = 3;
  for (let i = d.length - 2; i >= 0; i--) {
    sum += Number(d[i]) * weight;
    weight = weight === 3 ? 1 : 3;
  }
  const expected = (10 - (sum % 10)) % 10;
  return expected === Number(d[d.length - 1]);
}

const SCIENTIFIC_NOTATION = /^\s*[+-]?\d+(?:[.,]\d+)?e[+-]?\d+\s*$/i;

/**
 * Validate one non-blank barcode cell for its column.
 * @param {"EAN"|"UPC"|"GTIN"} type
 * @param {string} raw the cell as typed
 * @returns {{ok: true, value: string} | {ok: false, message: string}}
 */
export function validateBarcode(type, raw) {
  const text = String(raw ?? "").trim();
  if (SCIENTIFIC_NOTATION.test(text)) {
    return {
      ok: false,
      message: `${type} "${text}" is a spreadsheet number in scientific form, so digits are missing. Format the column as Text and paste the full number.`,
    };
  }
  const digits = digitsOnly(text);
  if (!digits) {
    return { ok: false, message: `${type} "${text}" has no digits.` };
  }
  const lengths = BARCODE_LENGTHS[type];
  if (!lengths) {
    return { ok: false, message: `Unknown barcode type ${type}.` };
  }
  if (!lengths.includes(digits.length)) {
    const want = lengths.length === 1 ? `${lengths[0]} digits` : `${lengths.join(" or ")} digits`;
    return { ok: false, message: `${type} "${text}" has ${digits.length} digits, expected ${want}.` };
  }
  if (!gs1CheckDigitOk(digits)) {
    return { ok: false, message: `${type} "${text}" has a wrong check digit (last digit), so it would never scan.` };
  }
  return { ok: true, value: digits };
}

/**
 * Turn one data row into a normalised row object. Pure.
 * @param {{line: number, cells: string[]}} r
 * @param {{setNumber: number, ean: number, upc: number, gtin: number}} columns
 */
function normaliseRow(r, columns) {
  const cell = (idx) => (idx >= 0 ? String(r.cells[idx] ?? "").trim() : "");
  const setNumber = cell(columns.setNumber);
  const raw = { ean: cell(columns.ean), upc: cell(columns.upc), gtin: cell(columns.gtin) };

  const row = {
    line: r.line,
    setNumber,
    key: setNumber.toUpperCase(),
    raw,
    barcodes: [],
    errors: [],
    duplicateOfLine: null,
  };

  if (!setNumber) row.errors.push("No set number on this row.");

  let anyBarcodeCell = false;
  for (const [field, type] of [
    ["ean", "EAN"],
    ["upc", "UPC"],
    ["gtin", "GTIN"],
  ]) {
    const value = raw[field];
    if (!value) continue;
    anyBarcodeCell = true;
    const v = validateBarcode(type, value);
    if (v.ok) row.barcodes.push({ value: v.value, type });
    else row.errors.push(v.message);
  }
  if (!anyBarcodeCell) row.errors.push("No EAN, UPC or GTIN on this row.");

  return row;
}

/**
 * Parse and validate a whole file.
 *
 * @param {string} text the CSV text
 * @param {{maxRows?: number, maxBytes?: number}} [opts]
 * @returns {{
 *   ok: true,
 *   columns: {setNumber: number, ean: number, upc: number, gtin: number},
 *   ignoredColumns: string[],
 *   rows: Array<{
 *     line: number,
 *     setNumber: string,
 *     key: string,
 *     raw: {ean: string, upc: string, gtin: string},
 *     barcodes: Array<{value: string, type: string}>,
 *     errors: string[],
 *     duplicateOfLine: number|null,
 *   }>,
 * } | {ok: false, message: string}}
 */
export function parseBarcodeCsv(text, opts = {}) {
  const maxRows = Number.isFinite(opts.maxRows) ? opts.maxRows : MAX_CSV_ROWS;
  const maxBytes = Number.isFinite(opts.maxBytes) ? opts.maxBytes : MAX_CSV_BYTES;

  const bytes = utf8ByteLength(text);
  if (bytes > maxBytes) {
    return {
      ok: false,
      message: `The file is ${Math.ceil(bytes / 1024)} KB; the limit is ${Math.round(maxBytes / 1024)} KB.`,
    };
  }

  const table = parseCsv(text);
  const nonBlank = table
    .map((cells, i) => ({ line: i + 1, cells }))
    .filter((r) => r.cells.some((c) => String(c ?? "").trim()));

  if (!nonBlank.length) return { ok: false, message: "The file is empty." };

  const header = detectColumns(nonBlank[0].cells);
  if (!header.ok) return header;

  const dataRows = nonBlank.slice(1);
  if (!dataRows.length) return { ok: false, message: "The file has a header row but no data rows." };
  if (dataRows.length > maxRows) {
    return { ok: false, message: `The file has ${dataRows.length} data rows; the limit is ${maxRows}.` };
  }

  const rows = dataRows.map((r) => normaliseRow(r, header.columns));

  // Duplicates: last row for a set number wins, earlier rows are reported.
  const lastLine = new Map();
  for (const row of rows) if (row.key) lastLine.set(row.key, row.line);
  for (const row of rows) {
    if (!row.key) continue;
    const winner = lastLine.get(row.key);
    if (winner !== row.line) {
      row.duplicateOfLine = winner;
      row.errors.push(`Set number ${row.setNumber} appears again on line ${winner}; that row is used and this one is ignored.`);
    }
  }

  return { ok: true, columns: header.columns, ignoredColumns: header.ignored, rows };
}
