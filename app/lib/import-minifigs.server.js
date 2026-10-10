// app/lib/import-minifigs.server.js
//
// Creates Shopify draft products for individual LEGO minifigures.
//
// Minifigures are identified by their BrickLink catalogue ID (sw0197, hp001),
// not by a LEGO set number, so this cannot go through the getSets path. Name
// and theme come from Brickset's getMinifigCollection, images from BrickLink's
// public image CDN.
//
// The one deliberate difference from the set importer: minifigures have no
// manufacturer EAN, so the variant barcode carries the catalogue ID instead.
// Shopify POS only scans the barcode field, so this is what makes a minifigure
// scannable at the till from a printed label.

import { fetchMinifigs, normalizeMinifigId } from "./brickset.server.js";
import { describeStocking } from "./inventory-locations.js";
import {
  ACTION_FIGURES_CATEGORY_ID,
  attachImages,
  checkProductExists,
  createProduct,
  enableInventoryTracking,
  getActiveLocations,
  getAvailableChannels,
  getFirstVariant,
  publishToChannels,
  setVariantSku,
  stockAtAllLocations,
  updateVariantFields,
} from "./shopify-product.server.js";

/* ===============================================================
   PURE HELPERS (no I/O, unit tested)
=============================================================== */

/**
 * BrickLink's public image CDN, keyed on the lowercase catalogue ID.
 * Shopify copies the image onto its own CDN during import, so this URL only
 * needs to resolve while the import runs.
 * @param {string} id - normalised minifigure ID
 */
export function minifigImageUrl(id) {
  return `https://img.bricklink.com/ItemImage/MN/0/${id}.png`;
}

// Shopify rejects product titles over 255 characters. A handful of catalogue
// names are long enough to matter, so the name is trimmed rather than the
// number or theme, which are the parts staff search on.
const MAX_TITLE_LENGTH = 255;

/**
 * Build the storefront title.
 * "Obi-Wan Kenobi - Clone Wars, Large Eyes SW0197 | Star Wars Minifigure | LEGO"
 * Mirrors the set convention of "{name} {number} | {theme} | LEGO".
 */
export function buildMinifigTitle(minifig) {
  // "Collectible Minifigures" already says it, so do not append again.
  const themePart = !minifig.theme
    ? "Minifigure"
    : /minifigures?$/i.test(minifig.theme)
      ? minifig.theme
      : `${minifig.theme} Minifigure`;

  const suffix = ` ${minifig.sku} | ${themePart} | LEGO`;
  const room = MAX_TITLE_LENGTH - suffix.length;

  const name =
    minifig.name.length > room ? `${minifig.name.slice(0, Math.max(0, room - 3)).trimEnd()}...` : minifig.name;

  return `${name}${suffix}`;
}

/**
 * Build the Shopify product input for a minifigure.
 * Theme and subtheme reuse the existing `brickset` metafield namespace so the
 * storefront filters that already read those keys pick minifigures up too.
 * @param {{id: string, sku: string, name: string, theme: string, subtheme: string}} minifig
 * @param {object} env - process.env
 */
export function buildMinifigProductInput(minifig, env = {}) {
  const title = buildMinifigTitle(minifig);

  const detailsLines = [`<li><strong>Minifigure number:</strong> ${minifig.sku}</li>`];
  if (minifig.theme) detailsLines.push(`<li><strong>Theme:</strong> ${minifig.theme}</li>`);
  if (minifig.subtheme) detailsLines.push(`<li><strong>Subtheme:</strong> ${minifig.subtheme}</li>`);

  const descriptionHtml = [
    `<p><strong>${minifig.name} (${minifig.sku})</strong></p>`,
    `<ul>${detailsLines.join("")}</ul>`,
  ].join("\n");

  const metafields = [
    { namespace: "brickset", key: "minifig_number", type: "single_line_text_field", value: minifig.sku },
    { namespace: "brickset", key: "theme", type: "single_line_text_field", value: minifig.theme || "" },
    { namespace: "brickset", key: "subtheme", type: "single_line_text_field", value: minifig.subtheme || "" },
    { namespace: "brickset", key: "source", type: "single_line_text_field", value: "brickset" },
    { namespace: "brickset", key: "imported_at", type: "date_time", value: new Date().toISOString() },
  ];

  return {
    title,
    descriptionHtml,
    vendor: minifig.theme || env.DEFAULT_VENDOR || "LEGO", // theme doubles as vendor, same as sets
    productType: "Minifigures",
    category: ACTION_FIGURES_CATEGORY_ID,
    status: "DRAFT",
    tags: ["brickset-imported", "minifigure"],
    metafields,
  };
}

/* ===============================================================
   IMAGE AVAILABILITY
=============================================================== */

/**
 * Check the BrickLink CDN actually has an image before handing the URL to
 * Shopify, so a missing image reports clearly instead of surfacing as an
 * opaque media error.
 * Fails open: if the check itself cannot run, attach the URL anyway and let
 * Shopify decide.
 * @returns {Promise<boolean>}
 */
export async function minifigImageExists(url) {
  try {
    const resp = await fetch(url, { method: "HEAD" });
    // Some CDNs refuse HEAD. Treat "method not allowed" as unknown, not missing.
    if (resp.status === 405 || resp.status === 501) return true;
    return resp.ok;
  } catch {
    return true;
  }
}

/* ===============================================================
   IMPORT
=============================================================== */

/**
 * Import minifigures and create Shopify draft products.
 *
 * Callers should pass a chunk at a time (the UI sends 25). Brickset is limited
 * to one request per second, so a large paste in a single call would exceed the
 * platform request timeout.
 *
 * @param {Object} auth - authenticate.admin(request)
 * @param {Array<string>} ids - minifigure IDs, e.g. ["sw0197", "SW0844"]
 * @param {Object} env - process.env
 */
export async function importMinifigs(auth, ids, env) {
  const { admin } = await auth;

  const requested = (ids || []).map((raw) => {
    const trimmed = String(raw || "").trim();
    return { raw: trimmed, id: normalizeMinifigId(trimmed) };
  });

  // One batched Brickset lookup for the whole chunk.
  let minifigMap;
  try {
    minifigMap = await fetchMinifigs(
      requested.map((r) => r.id).filter(Boolean),
      env
    );
  } catch (err) {
    // A rate limit or daily quota stop kills the whole chunk. Report it against
    // every row so the table is not silently empty, and flag ok:false so the
    // client loop stops rather than hammering the API.
    console.error("Minifigure lookup failed:", err?.message);
    return {
      ok: false,
      message: err?.message || "Brickset lookup failed",
      importedCount: 0,
      totalRequested: requested.length,
      results: requested.map((r) => ({
        id: r.raw,
        status: "error",
        errorCode: "BRICKSET_FETCH_ERROR",
        message: err?.message || "Brickset lookup failed",
      })),
    };
  }

  const availableChannels = await getAvailableChannels(admin);
  // Every active location, read once per chunk: each new product is stocked
  // at all of them at zero so the POS never asks "stock at this location?".
  const locations = await getActiveLocations(admin);

  const results = [];
  let importedCount = 0;

  for (const { raw, id } of requested) {
    if (!id) {
      results.push({
        id: raw,
        status: "error",
        errorCode: "INVALID_MINIFIG_ID",
        message: raw
          ? `"${raw}" is not a minifigure ID. Expected a BrickLink catalogue ID such as sw0197.`
          : "Empty or invalid minifigure ID",
      });
      continue;
    }

    const minifig = minifigMap.get(id);
    if (!minifig) {
      results.push({
        id: raw,
        status: "error",
        errorCode: "MINIFIG_NOT_FOUND",
        message: `No minifigure found on Brickset for "${raw}"`,
      });
      continue;
    }

    try {
      console.log(`[${minifig.sku}] Starting import...`);

      const existingProduct = await checkProductExists(admin, minifig.sku);
      if (existingProduct.exists) {
        console.log(`[${minifig.sku}] Product already exists: ${existingProduct.title}`);
        results.push({
          id: raw,
          status: "skipped",
          errorCode: "DUPLICATE_SKU",
          message: `Product already exists with SKU "${minifig.sku}": "${existingProduct.title}" (Status: ${existingProduct.status})`,
          existingProductId: existingProduct.productId,
          existingProductTitle: existingProduct.title,
          existingProductStatus: existingProduct.status,
        });
        continue;
      }

      const productInput = buildMinifigProductInput(minifig, env);

      const created = await createProduct(admin, productInput, minifig.sku);
      if (!created.ok) {
        results.push({ id: raw, status: "error", errorCode: created.errorCode, message: created.message });
        continue;
      }

      const { productId, title: productTitle } = created;
      console.log(`[${minifig.sku}] Product created: ${productTitle}`);

      const variant = await getFirstVariant(admin, productId, minifig.sku);
      if (!variant.ok) {
        results.push({
          id: raw,
          status: "error",
          errorCode: variant.errorCode,
          message: variant.message,
          shopifyProductId: productId,
        });
        continue;
      }

      // No EAN exists for a minifigure, so the catalogue ID becomes the
      // barcode. It is not a GS1 code, so it is written with no type
      // ("Custom" in the admin), which Shopify stores as entered.
      await updateVariantFields(admin, {
        productId,
        variantId: variant.variantId,
        barcodes: [{ value: minifig.sku, type: null }],
        label: minifig.sku,
      });

      // Track inventory, then stock the item at every active location at
      // zero. A stocking failure is reported on this row, never fatal.
      let stocking = { ok: false, activated: [], alreadyActive: [], message: "variant has no inventory item" };
      if (variant.inventoryItemId) {
        await enableInventoryTracking(admin, { productId, variantId: variant.variantId, label: minifig.sku });
        stocking = await stockAtAllLocations(admin, {
          inventoryItemId: variant.inventoryItemId,
          locations,
          label: minifig.sku,
        });
      }

      await setVariantSku(admin, { productId, variantId: variant.variantId, sku: minifig.sku, label: minifig.sku });

      await publishToChannels(admin, { productId, channelIds: availableChannels, label: minifig.sku });

      const imageUrl = minifigImageUrl(minifig.id);
      const hasImage = await minifigImageExists(imageUrl);
      const attachedCount = hasImage
        ? await attachImages(admin, {
            productId,
            title: productInput.title,
            imageUrls: [imageUrl],
            label: minifig.sku,
          })
        : 0;

      importedCount += 1;

      const imageNote = hasImage ? `${attachedCount} images` : "no image on BrickLink";
      const stockingNote = stocking.ok
        ? describeStocking(stocking)
        : `NOT stocked at every location (${stocking.message})`;

      results.push({
        id: raw,
        status: "created",
        errorCode: null,
        message: `${productTitle} (${minifig.sku}): ${imageNote}, barcode ${minifig.sku}, ${stockingNote}`,
        shopifyProductTitle: productTitle,
        shopifyProductId: productId,
        imageCount: attachedCount,
        barcode: minifig.sku,
        stockedAt: stocking.activated.concat(stocking.alreadyActive).map((l) => l.name),
        stockingError: stocking.ok ? null : stocking.message,
      });
    } catch (err) {
      const errorMessage = err?.message || "Unknown error";
      console.error(`[${minifig.sku}] Import failed:`, errorMessage);
      results.push({ id: raw, status: "error", errorCode: "UNKNOWN_ERROR", message: errorMessage });
    }
  }

  return {
    ok: true,
    importedCount,
    totalRequested: requested.length,
    results,
  };
}
