// app/lib/backfill-barcodes.server.js
//
// Backfills EAN and UPC barcodes onto EXISTING Shopify products.
// Works one page ("chunk") of variants at a time so each request stays short
// and the client can loop through the whole catalogue with live progress.
//
// This is a MERGE, not a fill: a variant that already has its EAN still gets
// the UPC added, and nothing already on the variant is ever removed or
// retyped (except an untyped row that matches Brickset, which gains its type).
// Requires Admin API 2026-10, where a variant holds up to 20 typed barcodes.
//
// Flow per chunk:
//   1. Read a page of product variants (id, sku, barcode, barcodes, product).
//   2. Match each variant's SKU to a Brickset set number.
//   3. One batched Brickset getSets call resolves EAN + UPC for the page.
//   4. Merge Brickset's barcodes into each variant's existing list and write
//      only the variants whose list actually changed.
//      Preview mode does everything except the write.

import { fetchBarcodesForSetNumbers } from "./brickset.server.js";
import { mergeBarcodes } from "./barcodes.js";

/* ===============================================================
   PURE HELPERS (no I/O, unit tested)
=============================================================== */

/**
 * Turn a Shopify variant SKU into a Brickset set number.
 * LEGO set numbers are numeric; Brickset expects "{number}-{variant}".
 * - "40760"    -> { clean: "40760", query: "40760-1" }  (assume variant 1)
 * - "40760-2"  -> { clean: "40760", query: "40760-2" }  (keep explicit variant)
 * - "TSHIRT-1" -> null  (not a LEGO set number we can match)
 * @returns {{clean: string, query: string} | null}
 */
export function parseSku(rawSku) {
  const sku = String(rawSku ?? "").trim();
  if (!sku) return null;

  let m = sku.match(/^(\d{2,8})-(\d{1,3})$/);
  if (m) return { clean: m[1], query: `${m[1]}-${m[2]}` };

  m = sku.match(/^(\d{2,8})$/);
  if (m) return { clean: m[1], query: `${m[1]}-1` };

  return null;
}

/**
 * Build a map of clean set number -> { ean, upc } from Brickset set objects.
 * Presence of a key means the set was found (both values may still be "").
 * Brickset's shape is `set.barcode.EAN` / `set.barcode.UPC` (observed).
 * @param {Array<object>} bricksetSets
 * @returns {Map<string, {ean: string, upc: string}>}
 */
export function buildBarcodeMap(bricksetSets) {
  const map = new Map();
  for (const s of bricksetSets || []) {
    const clean = String(s?.number ?? "").trim();
    if (!clean) continue;
    const entry = {
      ean: String(s?.barcode?.EAN ?? "").trim(),
      upc: String(s?.barcode?.UPC ?? "").trim(),
    };
    // If a set appears twice, prefer the entry that carries more data.
    const prev = map.get(clean);
    const score = (e) => (e.ean ? 1 : 0) + (e.upc ? 1 : 0);
    if (!prev || score(entry) > score(prev)) map.set(clean, entry);
  }
  return map;
}

/**
 * Read the rows of ProductVariant.barcodes off a variant node.
 * Shape per the 2026-10 docs: barcodes { nodes { value type } }.
 * @returns {Array<{value: string, type: string|null}>}
 */
export function existingBarcodes(variant) {
  const nodes = variant?.barcodes?.nodes;
  if (Array.isArray(nodes)) return nodes;
  // Tolerate an edges shape too, in case a caller asked for it.
  const edges = variant?.barcodes?.edges;
  if (Array.isArray(edges)) return edges.map((e) => e?.node).filter(Boolean);
  return [];
}

/**
 * Decide what to do with a single variant.
 * @returns {{
 *   outcome: "skipped"|"notFound"|"noBricksetData"|"unchanged"|"update",
 *   existingCount: number,
 *   barcodes?: Array<{value: string, type: string|null}>,
 *   added?: Array<{value: string, type: string|null}>,
 *   retyped?: Array<{value: string, type: string|null}>,
 *   notAdded?: Array<{value: string, type: string|null, reason: string}>,
 * }}
 */
export function classifyVariant(variant, parsed, barcodeMap) {
  const existing = existingBarcodes(variant);
  const legacyBarcode = String(variant?.barcode ?? "").trim();
  const existingCount = existing.filter((r) => String(r?.value ?? "").trim()).length || (legacyBarcode ? 1 : 0);

  if (!parsed) return { outcome: "skipped", existingCount };
  if (!barcodeMap.has(parsed.clean)) return { outcome: "notFound", existingCount };

  const brickset = barcodeMap.get(parsed.clean);
  if (!brickset.ean && !brickset.upc) return { outcome: "noBricksetData", existingCount };

  const merged = mergeBarcodes({ existing, legacyBarcode, brickset });
  if (!merged.changed) return { outcome: "unchanged", existingCount };

  return {
    outcome: "update",
    existingCount,
    barcodes: merged.barcodes,
    added: merged.added,
    retyped: merged.retyped,
    notAdded: merged.notAdded,
  };
}

/* ===============================================================
   SHOPIFY I/O
=============================================================== */

// Field names confirmed on shopify.dev for Admin API 2026-10 (read 2026-09-12):
//   ProductVariant.barcodes(first:) -> ProductVariantBarcodeConnection { nodes, edges, pageInfo }
//   ProductVariantBarcode { value: String!, type: BarcodeType }
//   ProductVariant.barcode -> String, deprecated ("Use `barcodes` instead."),
//     "returns the first entry in `barcodes`" when there is more than one.
//   https://shopify.dev/docs/api/admin-graphql/2026-10/objects/ProductVariant
//   https://shopify.dev/docs/api/admin-graphql/2026-10/connections/ProductVariantBarcodeConnection
// The deprecated `barcode` is no longer queried (10 Oct 2026): it only ever
// returned the first entry of `barcodes`, which is read in full, so the legacy
// argument to mergeBarcodes is now always empty.
const PRODUCT_VARIANTS_QUERY = `
  query BackfillVariants($first: Int!, $after: String) {
    productVariants(first: $first, after: $after) {
      edges {
        node {
          id
          sku
          barcodes(first: 20) {
            nodes { value type }
          }
          product { id title }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

// Write path confirmed on shopify.dev for Admin API 2026-10 (read 2026-09-12):
//   ProductVariantsBulkInput.barcodes: [BarcodeInput!]
//     "Replaces the entire barcode set. A variant accepts up to 20 barcodes,
//      and a given variant input can't set both `barcode` and `barcodes`."
//   ProductVariantsBulkInput.barcode: String, deprecated ("Use `barcodes` instead.")
//     "If `null` is provided on a variant with >1 barcode, the first barcode
//      will be erased and the next will be returned in the `barcode` field."
//   BarcodeInput { value: String!, type: BarcodeType }  (type optional; null = stored as entered)
//   https://shopify.dev/docs/api/admin-graphql/2026-10/input-objects/ProductVariantsBulkInput
//   https://shopify.dev/docs/api/admin-graphql/2026-10/input-objects/BarcodeInput
//   https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/productVariantsBulkUpdate
// So this mutation sends ONLY `barcodes`, never `barcode`, and always the full
// merged list. One variant per call so a format-validation failure on one
// variant (say a malformed UPC from Brickset) is reported for that variant
// alone and the rest of the page still writes.
const VARIANT_BARCODES_UPDATE = `
  mutation BackfillSetBarcodes($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      productVariants {
        id
        barcodes(first: 20) { nodes { value type } }
      }
      userErrors { field message }
    }
  }
`;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Retry only on Shopify throttling; surface everything else to the caller.
// Shared with the CSV upload (barcode-csv-apply.server.js).
export async function graphqlWithRetry(admin, query, variables, attempts = 4) {
  let delay = 500;
  let json;
  for (let i = 0; i < attempts; i++) {
    const resp = await admin.graphql(query, { variables });
    json = await resp.json();
    const throttled = (json.errors || []).some((e) =>
      `${e?.extensions?.code || ""} ${e?.message || ""}`.toUpperCase().includes("THROTTL")
    );
    if (throttled && i < attempts - 1) {
      await sleep(delay);
      delay *= 2;
      continue;
    }
    return json;
  }
  return json;
}

export function formatUserErrors(userErrors) {
  return (userErrors || [])
    .map((e) => {
      const field = Array.isArray(e?.field) ? e.field.join(".") : e?.field;
      return field ? `${field}: ${e.message}` : e?.message;
    })
    .filter(Boolean)
    .join("; ");
}

/**
 * Replace a variant's whole barcode list with `barcodes` (the merged list).
 * The ONE write path for barcodes on existing products: the backfill and the
 * CSV upload both go through here, so they can never drift apart.
 * Never throws.
 * @returns {Promise<{ok: true} | {ok: false, message: string}>}
 */
export async function writeVariantBarcodes(admin, { productId, variantId, barcodes }) {
  try {
    const json = await graphqlWithRetry(admin, VARIANT_BARCODES_UPDATE, {
      productId,
      variants: [{ id: variantId, barcodes }],
    });
    if (json.errors?.length) return { ok: false, message: json.errors[0].message };
    const userErrors = json.data?.productVariantsBulkUpdate?.userErrors || [];
    if (userErrors.length) return { ok: false, message: formatUserErrors(userErrors) };
    return { ok: true };
  } catch (err) {
    return { ok: false, message: err?.message || "Unknown error" };
  }
}

/**
 * Process one page of the catalogue.
 * @param admin  authenticated admin GraphQL client
 * @param env    process.env (Brickset credentials)
 * @param opts   { cursor?: string|null, pageSize?: number, mode?: "preview"|"commit" }
 * @returns report + { nextCursor, done, mode }
 */
export async function backfillChunk(admin, env, opts = {}) {
  const pageSize = Math.min(Math.max(Number(opts.pageSize) || 50, 1), 100);
  const cursor = opts.cursor || null;
  const mode = opts.mode === "commit" ? "commit" : "preview";

  // 1. One page of variants.
  const pageJson = await graphqlWithRetry(admin, PRODUCT_VARIANTS_QUERY, {
    first: pageSize,
    after: cursor,
  });
  if (pageJson.errors?.length) {
    throw new Error(pageJson.errors[0]?.message || "Failed to query product variants");
  }

  const conn = pageJson.data?.productVariants;
  const edges = conn?.edges || [];
  const pageInfo = conn?.pageInfo || { hasNextPage: false, endCursor: null };

  const items = edges.map((e) => ({ node: e.node, parsed: parseSku(e.node.sku) }));

  // 2. Every variant with a parseable SKU needs a Brickset lookup, because a
  //    variant that already has its EAN may still be missing its UPC.
  const toLookup = items.filter((it) => it.parsed);

  // 3. Batched Brickset lookup for the page.
  let barcodeMap = new Map();
  if (toLookup.length) {
    const sets = await fetchBarcodesForSetNumbers(toLookup.map((it) => it.parsed.query), env);
    barcodeMap = buildBarcodeMap(sets);
  }

  // 4. Classify + collect updates.
  const report = {
    processed: items.length,
    updated: 0,
    wouldUpdate: 0,
    unchanged: 0,
    skipped: 0,
    barcodesAdded: 0,
    barcodesRetyped: 0,
    noBricksetData: [],
    notFound: [],
    notAdded: [],
    errors: [],
  };

  const updates = []; // [{ productId, variantId, sku, barcodes, added, retyped }]

  for (const it of items) {
    const sku = (it.node.sku || "").trim();
    const c = classifyVariant(it.node, it.parsed, barcodeMap);
    const flag = () => ({
      setNumber: it.parsed?.clean || sku,
      productName: it.node.product?.title || "",
      existingCount: c.existingCount,
    });
    switch (c.outcome) {
      case "skipped":
        report.skipped++;
        break;
      case "notFound":
        report.notFound.push(flag());
        break;
      case "noBricksetData":
        report.noBricksetData.push(flag());
        break;
      case "unchanged":
        report.unchanged++;
        break;
      case "update": {
        const pid = it.node.product?.id;
        if (!pid) {
          report.errors.push({ sku, message: "variant has no product id" });
          break;
        }
        for (const n of c.notAdded || []) {
          report.notAdded.push({ sku, value: n.value, type: n.type, reason: n.reason });
        }
        updates.push({
          productId: pid,
          variantId: it.node.id,
          sku,
          barcodes: c.barcodes,
          added: c.added || [],
          retyped: c.retyped || [],
        });
        break;
      }
    }
  }

  // 5. Write (commit only). One mutation per variant so one bad barcode fails
  //    one variant, not the page.
  if (mode === "commit") {
    for (const u of updates) {
      const w = await writeVariantBarcodes(admin, {
        productId: u.productId,
        variantId: u.variantId,
        barcodes: u.barcodes,
      });
      if (!w.ok) {
        report.errors.push({ sku: u.sku, message: w.message });
      } else {
        report.updated++;
        report.barcodesAdded += u.added.length;
        report.barcodesRetyped += u.retyped.length;
      }
    }
  } else {
    report.wouldUpdate = updates.length;
    for (const u of updates) {
      report.barcodesAdded += u.added.length;
      report.barcodesRetyped += u.retyped.length;
    }
  }

  return {
    ...report,
    mode,
    nextCursor: pageInfo.hasNextPage ? pageInfo.endCursor : null,
    done: !pageInfo.hasNextPage,
  };
}
