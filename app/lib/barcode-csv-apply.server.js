// app/lib/barcode-csv-apply.server.js
//
// Applies a hand-filled barcode CSV to existing Shopify products. This is the
// manual companion to the Brickset backfill: the backfill exports the sets
// Brickset has no barcode for, the shop fills in EAN/UPC (and optionally
// GTIN) from the box or barcodelookup.com, and uploads the file here.
//
// Same guarantees as the backfill:
//   - MERGE, never replace: mergeBarcodes keeps every barcode already on the
//     variant and only appends what is missing, so nothing is removed or
//     duplicated and a re-upload is harmless.
//   - Same write: writeVariantBarcodes (productVariantsBulkUpdate `barcodes`,
//     Admin API 2026-10).
//   - Preview mode does everything except the write.
//
// One request handles a CHUNK of rows (CSV_CHUNK_ROWS) so a 2,000 row file
// never runs into the platform request timeout; the page loops through the
// file by offset, re-sending the same text each time (1 MB at most).

import { parseBarcodeCsv } from "./barcode-csv.js";
import {
  existingBarcodes,
  graphqlWithRetry,
  parseSku,
  writeVariantBarcodes,
} from "./backfill-barcodes.server.js";
import { mergeBarcodes } from "./barcodes.js";

/** Rows processed per request. Each row is one lookup plus at most one write. */
export const CSV_CHUNK_ROWS = 25;

/* ===============================================================
   PURE HELPERS (no I/O, unit tested)
=============================================================== */

/**
 * Search term for one set number. The SKU search is a token match, so a
 * number like 40760 also surfaces 40760-2; pickVariantForSetNumber then
 * decides. Anything outside [A-Za-z0-9._-] is quoted for the search syntax.
 * @param {string} setNumber
 */
export function skuSearchQuery(setNumber) {
  const want = String(setNumber ?? "").trim();
  const parsed = parseSku(want);
  const term = parsed ? parsed.clean : want;
  if (/^[A-Za-z0-9._-]+$/.test(term)) return `sku:${term}`;
  return `sku:"${term.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Choose the variant a CSV set number refers to, from the variants the SKU
 * search returned.
 *
 *   1. An exact SKU match (case-insensitive, trimmed) wins.
 *   2. Otherwise, the same LEGO set number and variant the backfill would
 *      derive (parseSku: "40760" means "40760-1"): one match wins.
 *   3. Otherwise, the same set number with any variant suffix ("40760" versus
 *      "40760-2"): one match wins, several is ambiguous and the shop is asked
 *      to put the full SKU in the file.
 *
 * @param {string} setNumber
 * @param {Array<{id: string, sku?: string}>} variants
 * @returns {{variant: object} | {variant: null, ambiguous: boolean, message: string}}
 */
export function pickVariantForSetNumber(setNumber, variants) {
  const want = String(setNumber ?? "").trim();
  if (!want) return { variant: null, ambiguous: false, message: "No product with SKU (blank)." };
  const list = Array.isArray(variants) ? variants.filter((v) => v?.id) : [];
  const skuOf = (v) => String(v?.sku ?? "").trim();

  const decide = (matches, how) => {
    if (matches.length === 1) return { variant: matches[0] };
    if (matches.length > 1) {
      const skus = matches.map(skuOf).filter(Boolean);
      return {
        variant: null,
        ambiguous: true,
        message: `${want} matches ${matches.length} products by ${how} (SKUs ${skus.join(", ")}); put the exact SKU in the file.`,
      };
    }
    return null;
  };

  const exact = decide(
    list.filter((v) => skuOf(v).toUpperCase() === want.toUpperCase()),
    "exact SKU"
  );
  if (exact) return exact;

  const parsed = parseSku(want);
  if (parsed) {
    const sameQuery = decide(
      list.filter((v) => parseSku(skuOf(v))?.query === parsed.query),
      "set number"
    );
    if (sameQuery) return sameQuery;

    const sameClean = decide(
      list.filter((v) => parseSku(skuOf(v))?.clean === parsed.clean),
      "set number"
    );
    if (sameClean) return sameClean;
  }

  return { variant: null, ambiguous: false, message: `No product with SKU ${want}.` };
}

/* ===============================================================
   SHOPIFY I/O
=============================================================== */

// Same selection as the backfill's page query so existingBarcodes() and the
// legacy `barcode` safety net behave identically here.
//   https://shopify.dev/docs/api/admin-graphql/2026-10/queries/productVariants
//   https://shopify.dev/docs/api/admin-graphql/2026-10/objects/ProductVariant
const VARIANTS_BY_SKU_QUERY = `
  query CsvVariantsBySku($query: String!) {
    productVariants(first: 25, query: $query) {
      edges {
        node {
          id
          sku
          barcode
          barcodes(first: 20) {
            nodes { value type }
          }
          product { id title }
        }
      }
    }
  }
`;

async function findVariantsBySku(admin, setNumber) {
  const json = await graphqlWithRetry(admin, VARIANTS_BY_SKU_QUERY, { query: skuSearchQuery(setNumber) });
  if (json.errors?.length) throw new Error(json.errors[0]?.message || "Variant lookup failed");
  return (json.data?.productVariants?.edges || []).map((e) => e.node).filter(Boolean);
}

function label(rows) {
  return rows.map((r) => (r.type ? `${r.type} ${r.value}` : r.value));
}

/**
 * Process one chunk of the CSV.
 *
 * Per-row outcome (`outcome`):
 *   added      written (commit) or would be written (preview); `added` lists
 *              the typed values, `retyped` the existing untyped rows that
 *              gained a type
 *   unchanged  product found, every barcode already on it
 *   notFound   no product with that SKU
 *   ambiguous  several products could match; exact SKU needed
 *   invalid    the row failed validation (length, check digit, no barcode)
 *   duplicate  the set number appears again later in the file; that row wins
 *   error      lookup or write failed; `error` carries Shopify's message
 *
 * @param admin authenticated admin GraphQL client
 * @param {{csv: string, offset?: number, mode?: "preview"|"commit"}} opts
 */
export async function applyBarcodeCsvChunk(admin, opts = {}) {
  const mode = opts.mode === "commit" ? "commit" : "preview";
  const parsed = parseBarcodeCsv(opts.csv);
  if (!parsed.ok) {
    return { ok: false, error: parsed.message, mode, done: true, nextOffset: null, results: [] };
  }

  const total = parsed.rows.length;
  const start = Math.min(Math.max(Number(opts.offset) || 0, 0), total);
  const end = Math.min(start + CSV_CHUNK_ROWS, total);
  const results = [];

  for (const row of parsed.rows.slice(start, end)) {
    const out = {
      line: row.line,
      setNumber: row.setNumber,
      raw: row.raw,
      requested: label(row.barcodes),
      found: false,
      productTitle: "",
      sku: "",
      outcome: "error",
      added: [],
      retyped: [],
      notAdded: [],
      error: null,
    };
    results.push(out);

    if (row.errors.length) {
      out.outcome = row.duplicateOfLine ? "duplicate" : "invalid";
      out.error = row.errors.join(" ");
      continue;
    }

    let variants;
    try {
      variants = await findVariantsBySku(admin, row.setNumber);
    } catch (err) {
      out.outcome = "error";
      out.error = `Lookup failed: ${err?.message || "Unknown error"}`;
      continue;
    }

    const pick = pickVariantForSetNumber(row.setNumber, variants);
    if (!pick.variant) {
      out.outcome = pick.ambiguous ? "ambiguous" : "notFound";
      out.error = pick.message;
      continue;
    }

    const variant = pick.variant;
    out.found = true;
    out.productTitle = variant.product?.title || "";
    out.sku = variant.sku || "";

    if (!variant.product?.id) {
      out.outcome = "error";
      out.error = "Variant has no product id.";
      continue;
    }

    const merged = mergeBarcodes({
      existing: existingBarcodes(variant),
      legacyBarcode: variant.barcode,
      candidates: row.barcodes,
    });
    out.notAdded = merged.notAdded.map((n) => `${n.type || "Barcode"} ${n.value}: ${n.reason}`);

    if (!merged.changed) {
      out.outcome = "unchanged";
      continue;
    }

    out.added = label(merged.added);
    out.retyped = label(merged.retyped);

    if (mode === "commit") {
      const w = await writeVariantBarcodes(admin, {
        productId: variant.product.id,
        variantId: variant.id,
        barcodes: merged.barcodes,
      });
      if (!w.ok) {
        out.outcome = "error";
        out.error = `Write failed: ${w.message}`;
        out.added = [];
        out.retyped = [];
        continue;
      }
    }
    out.outcome = "added";
  }

  return {
    ok: true,
    mode,
    totalRows: total,
    ignoredColumns: parsed.ignoredColumns,
    offset: start,
    nextOffset: end < total ? end : null,
    done: end >= total,
    results,
  };
}
