// app/lib/backfill-barcodes.server.js
//
// Backfills EAN barcodes onto EXISTING Shopify products.
// Works one page ("chunk") of variants at a time so each request stays short
// and the client can loop through the whole catalogue with live progress.
//
// Flow per chunk:
//   1. Read a page of product variants (id, sku, barcode, product).
//   2. Match each variant's SKU to a Brickset set number.
//   3. One batched Brickset getSets call resolves EANs for the page.
//   4. Fill the barcode on variants that are empty and have an EAN.
//      Preview mode does everything except the write.

import { fetchEansForSetNumbers } from "./brickset.server.js";

/* ===============================================================
   PURE HELPERS (no I/O — unit tested)
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
 * Build a map of clean set number -> trimmed EAN from Brickset set objects.
 * Presence of a key means the set was found (EAN may still be "").
 * @param {Array<object>} bricksetSets
 * @returns {Map<string, string>}
 */
export function buildEanMap(bricksetSets) {
  const map = new Map();
  for (const s of bricksetSets || []) {
    const clean = String(s?.number ?? "").trim();
    if (!clean) continue;
    const ean = (s?.barcode?.EAN || "").trim();
    // If a set appears twice, prefer the entry that actually carries an EAN.
    if (!map.has(clean) || (!map.get(clean) && ean)) {
      map.set(clean, ean);
    }
  }
  return map;
}

/**
 * Decide what to do with a single variant.
 * Fill-only: a variant that already has a barcode is left untouched.
 * @returns {{outcome: "alreadySet"|"skipped"|"notFound"|"missingEan"|"fill", ean?: string}}
 */
export function classifyVariant(variant, parsed, eanMap) {
  const currentBarcode = (variant?.barcode || "").trim();
  if (currentBarcode) return { outcome: "alreadySet" };
  if (!parsed) return { outcome: "skipped" };
  if (!eanMap.has(parsed.clean)) return { outcome: "notFound" };
  const ean = eanMap.get(parsed.clean);
  if (!ean) return { outcome: "missingEan" };
  return { outcome: "fill", ean };
}

/* ===============================================================
   SHOPIFY I/O
=============================================================== */

const PRODUCT_VARIANTS_QUERY = `
  query BackfillVariants($first: Int!, $after: String) {
    productVariants(first: $first, after: $after) {
      edges {
        node {
          id
          sku
          barcode
          product { id title }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const VARIANT_BARCODE_UPDATE = `
  mutation BackfillSetBarcode($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      productVariants { id barcode }
      userErrors { field message }
    }
  }
`;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Retry only on Shopify throttling; surface everything else to the caller.
async function graphqlWithRetry(admin, query, variables, attempts = 4) {
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

  // 2. Which variants need a Brickset lookup (empty barcode + parseable SKU).
  const toLookup = items.filter(
    (it) => (it.node.barcode || "").trim() === "" && it.parsed
  );

  // 3. Batched Brickset lookup for the page.
  let eanMap = new Map();
  if (toLookup.length) {
    const sets = await fetchEansForSetNumbers(toLookup.map((it) => it.parsed.query), env);
    eanMap = buildEanMap(sets);
  }

  // 4. Classify + collect fills grouped by product.
  const report = {
    processed: items.length,
    alreadySet: 0,
    filled: 0,
    wouldFill: 0,
    skipped: 0,
    missingEan: [],
    notFound: [],
    errors: [],
  };

  const fillsByProduct = new Map(); // productId -> [{ id, barcode, sku }]

  for (const it of items) {
    const sku = (it.node.sku || "").trim();
    const c = classifyVariant(it.node, it.parsed, eanMap);
    switch (c.outcome) {
      case "alreadySet":
        report.alreadySet++;
        break;
      case "skipped":
        report.skipped++;
        break;
      case "notFound":
        report.notFound.push(sku || it.node.id);
        break;
      case "missingEan":
        report.missingEan.push(sku || it.parsed.clean);
        break;
      case "fill": {
        const pid = it.node.product?.id;
        if (!pid) {
          report.errors.push({ sku, message: "variant has no product id" });
          break;
        }
        if (!fillsByProduct.has(pid)) fillsByProduct.set(pid, []);
        fillsByProduct.get(pid).push({ id: it.node.id, barcode: c.ean, sku });
        break;
      }
    }
  }

  const totalFills = [...fillsByProduct.values()].reduce((n, a) => n + a.length, 0);

  // 5. Write (commit only). One mutation per product.
  if (mode === "commit" && totalFills) {
    for (const [productId, variants] of fillsByProduct) {
      try {
        const json = await graphqlWithRetry(admin, VARIANT_BARCODE_UPDATE, {
          productId,
          variants: variants.map((v) => ({ id: v.id, barcode: v.barcode })),
        });
        const userErrors = json.data?.productVariantsBulkUpdate?.userErrors || [];
        if (json.errors?.length) {
          for (const v of variants) report.errors.push({ sku: v.sku, message: json.errors[0].message });
        } else if (userErrors.length) {
          for (const v of variants) report.errors.push({ sku: v.sku, message: userErrors[0].message });
        } else {
          report.filled += json.data?.productVariantsBulkUpdate?.productVariants?.length || variants.length;
        }
      } catch (err) {
        for (const v of variants) report.errors.push({ sku: v.sku, message: err.message });
      }
    }
  } else {
    report.wouldFill = totalFills;
  }

  return {
    ...report,
    mode,
    nextCursor: pageInfo.hasNextPage ? pageInfo.endCursor : null,
    done: !pageInfo.hasNextPage,
  };
}
