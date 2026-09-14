// app/lib/barcodes.js
//
// Pure barcode helpers shared by the set importer and the backfill. No I/O.
//
// From Admin API 2026-10 a variant carries a LIST of barcodes, each with an
// optional type, instead of one untyped `barcode` string:
//
//   ProductVariant.barcodes: ProductVariantBarcodeConnection!  (up to 20)
//     ProductVariantBarcode { value: String!, type: BarcodeType }
//   ProductVariantsBulkInput.barcodes: [BarcodeInput!]
//     BarcodeInput { value: String!, type: BarcodeType }
//   BarcodeType: ASIN | EAN | GTIN | ISBN | UPC
//
// Field names and the rules below were read from these pages on 2026-09-12:
//   https://shopify.dev/docs/api/admin-graphql/2026-10/input-objects/BarcodeInput
//   https://shopify.dev/docs/api/admin-graphql/2026-10/input-objects/ProductVariantsBulkInput
//   https://shopify.dev/docs/api/admin-graphql/2026-10/objects/ProductVariantBarcode
//   https://shopify.dev/docs/api/admin-graphql/2026-10/objects/ProductVariant
//   https://shopify.dev/docs/api/admin-graphql/2026-10/enums/BarcodeType
//
// Rules that shape this module (quoted from those pages):
//   - "A variant accepts up to 20 barcodes, and a given variant input can't
//      set both `barcode` and `barcodes`."
//   - `barcodes` on write "Replaces the entire barcode set." So every merge
//     must carry the existing rows through, or they are lost.
//   - `type`: "A `null` format denotes no type provided on write and the
//      value is stored as entered." Typed values "are validated against their
//      respective format standards."
//   - Legacy `ProductVariant.barcode` (deprecated, "Use `barcodes` instead."):
//     "When a variant has more than one barcode, this field returns the first
//      entry in `barcodes`." So a barcode written through the old field shows
//     up as the first, untyped row of `barcodes`.
//   - `value`: "Maximum length: 255 characters."
//
// Brickset supplies barcode: { EAN, UPC } for most sets. UK/EU boxes print
// the EAN-13, North American boxes the UPC-A. The till should scan whichever
// box is on the counter, so both are written, each with its type.

/** ProductVariant.barcodes limit on Admin API 2026-10. */
export const MAX_BARCODES = 20;

/** BarcodeInput.value maximum length on Admin API 2026-10. */
export const MAX_BARCODE_LENGTH = 255;

/**
 * Key used to decide whether two barcode values are "the same".
 * Whitespace and hyphens are ignored and letters are upper-cased, so
 * "5702016867473", " 5702016867473 " and "5702-0168-67473" collide.
 * Leading zeros are kept on purpose: a 12 digit UPC-A and its 13 digit
 * zero-padded GTIN are different scans at the till, so both may be stored.
 * @param {unknown} value
 * @returns {string}
 */
export function normaliseBarcodeValue(value) {
  return String(value ?? "")
    .replace(/[\s-]/g, "")
    .toUpperCase();
}

function cleanType(type) {
  const t = String(type ?? "").trim();
  return t ? t : null;
}

function cleanValue(value) {
  return String(value ?? "").trim();
}

/**
 * The typed rows Brickset data gives us, in write order.
 * EAN comes first so the legacy single `barcode` field (which mirrors the
 * first entry of `barcodes`) keeps showing the EAN that UK staff scan.
 * Empty values are dropped; a set with neither returns [].
 * @param {{ean?: string, upc?: string}} src
 * @returns {Array<{value: string, type: string}>}
 */
export function bricksetBarcodes(src = {}) {
  const rows = [];
  const ean = cleanValue(src.ean);
  const upc = cleanValue(src.upc);
  if (ean) rows.push({ value: ean, type: "EAN" });
  if (upc && normaliseBarcodeValue(upc) !== normaliseBarcodeValue(ean)) {
    rows.push({ value: upc, type: "UPC" });
  }
  return rows;
}

function sameList(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].value !== b[i].value) return false;
    if ((a[i].type ?? null) !== (b[i].type ?? null)) return false;
  }
  return true;
}

/**
 * Merge new barcodes into the rows a variant already has.
 *
 * The new rows come from Brickset (`brickset`, turned into typed EAN and UPC
 * rows by bricksetBarcodes) and/or from an explicit `candidates` list (the
 * manual CSV upload, which may also carry a GTIN). Both go through the same
 * rules, in that order.
 *
 * Rules:
 *   - Every existing row is kept, value and type untouched, in its order.
 *   - A candidate is appended when its VALUE is not already present. Presence
 *     is decided on the normalised value only, ignoring type, so an EAN
 *     stored as GTIN is not added twice.
 *   - An existing row with the same value and NO type takes the candidate's
 *     type. This is how a legacy `barcode` write (untyped) becomes a typed
 *     EAN row instead of a duplicate.
 *   - The legacy `barcode` string is a safety net: if it is non-empty and its
 *     value is not in `existing`, it is carried through as an untyped row so
 *     the replace-all write can never drop it. On 2026-10 the docs say it is
 *     the first entry of `barcodes`, so this branch should not fire.
 *   - Never more than MAX_BARCODES rows, never an empty value, no duplicate
 *     values. Values over MAX_BARCODE_LENGTH are not added.
 *
 * @param {object} args
 * @param {Array<{value?: string, type?: string|null}>} [args.existing] rows from ProductVariant.barcodes
 * @param {string} [args.legacyBarcode] the deprecated ProductVariant.barcode string
 * @param {{ean?: string, upc?: string}} [args.brickset] Brickset barcode data
 * @param {Array<{value?: string, type?: string|null}>} [args.candidates] explicit typed rows to add
 * @returns {{
 *   barcodes: Array<{value: string, type: string|null}>,
 *   changed: boolean,
 *   added: Array<{value: string, type: string|null}>,
 *   retyped: Array<{value: string, type: string|null}>,
 *   notAdded: Array<{value: string, type: string|null, reason: string}>,
 * }}
 */
export function mergeBarcodes({ existing, legacyBarcode, brickset, candidates } = {}) {
  // What Shopify holds today, as read. Compared against the result to decide
  // whether a write is needed at all.
  const current = (Array.isArray(existing) ? existing : [])
    .map((r) => ({ value: cleanValue(r?.value), type: cleanType(r?.type) }))
    .filter((r) => r.value);

  // Working copy, deduped on normalised value (first occurrence wins).
  const rows = [];
  const seen = new Set();
  for (const r of current) {
    const key = normaliseBarcodeValue(r.value);
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ value: r.value, type: r.type });
  }

  const legacy = cleanValue(legacyBarcode);
  if (legacy && !seen.has(normaliseBarcodeValue(legacy))) {
    seen.add(normaliseBarcodeValue(legacy));
    rows.push({ value: legacy, type: null });
  }

  const added = [];
  const retyped = [];
  const notAdded = [];

  const wanted = bricksetBarcodes(brickset || {}).concat(
    (Array.isArray(candidates) ? candidates : [])
      .map((c) => ({ value: cleanValue(c?.value), type: cleanType(c?.type) }))
      .filter((c) => c.value)
  );

  for (const candidate of wanted) {
    const key = normaliseBarcodeValue(candidate.value);
    const match = rows.find((r) => normaliseBarcodeValue(r.value) === key);

    if (match) {
      if (!match.type && candidate.type) {
        match.type = candidate.type;
        retyped.push({ value: match.value, type: match.type });
      }
      continue;
    }

    if (candidate.value.length > MAX_BARCODE_LENGTH) {
      notAdded.push({ ...candidate, reason: `longer than ${MAX_BARCODE_LENGTH} characters` });
      continue;
    }
    if (rows.length >= MAX_BARCODES) {
      notAdded.push({ ...candidate, reason: `variant already has ${MAX_BARCODES} barcodes` });
      continue;
    }

    seen.add(key);
    rows.push({ value: candidate.value, type: candidate.type });
    added.push({ value: candidate.value, type: candidate.type });
  }

  return {
    barcodes: rows,
    changed: !sameList(current, rows),
    added,
    retyped,
    notAdded,
  };
}

/**
 * Human readable "EAN 5702016867473, UPC 673419320801" for logs and UI.
 * @param {Array<{value: string, type?: string|null}>} rows
 * @returns {string}
 */
export function describeBarcodes(rows) {
  return (rows || [])
    .filter((r) => r?.value)
    .map((r) => (r.type ? `${r.type} ${r.value}` : r.value))
    .join(", ");
}
