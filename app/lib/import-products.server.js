// app/lib/import-products.server.js

import { fetchSet } from "./brickset.server.js";
import { bricksetBarcodes, describeBarcodes } from "./barcodes.js";
import { describeStocking } from "./inventory-locations.js";
import {
  CONSTRUCTION_TOYS_CATEGORY_ID,
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

/**
 * Build the Shopify product input for a Brickset set.
 * Pure, so the title and description shape can be checked without any I/O.
 * @param {object} set - normalised set from fetchSet()
 * @param {string} cleanSetNum - set number without the -1 variant suffix
 * @param {object} env - process.env
 */
export function buildSetProductInput(set, cleanSetNum, env = {}) {
  const title = [`${set.name} ${cleanSetNum}`, set.theme && `${set.theme}`, "LEGO"]
    .filter(Boolean)
    .join(" | ");

  const detailsLines = [];
  if (set.year) detailsLines.push(`<li><strong>Year:</strong> ${set.year}</li>`);
  if (set.pieces) detailsLines.push(`<li><strong>Pieces:</strong> ${set.pieces}</li>`);
  if (set.theme) detailsLines.push(`<li><strong>Theme:</strong> ${set.theme}</li>`);
  if (set.subtheme) detailsLines.push(`<li><strong>Subtheme:</strong> ${set.subtheme}</li>`);

  const descriptionParts = [`<p><strong>${set.name} (${set.set_num})</strong></p>`];
  if (detailsLines.length) descriptionParts.push(`<ul>${detailsLines.join("")}</ul>`);
  if (set.description) descriptionParts.push(`<p>${set.description}</p>`);

  // Metafield types must match the definitions in Shopify. brickset.year is an
  // Integer and brickset.pieces is a single line text field.
  const metafields = [
    { namespace: "brickset", key: "set_number", type: "single_line_text_field", value: set.set_num },
    { namespace: "brickset", key: "theme", type: "single_line_text_field", value: set.theme || "" },
    { namespace: "brickset", key: "subtheme", type: "single_line_text_field", value: set.subtheme || "" },
    { namespace: "brickset", key: "year", type: "number_integer", value: set.year ? String(set.year) : null },
    // custom.year_released exists on the live theme but not on dev. A missing
    // definition is tolerated by createProduct().
    { namespace: "custom", key: "year_released", type: "number_integer", value: set.year ? String(set.year) : null },
    { namespace: "brickset", key: "pieces", type: "single_line_text_field", value: set.pieces ? String(set.pieces) : "" },
    { namespace: "brickset", key: "brickset_url", type: "single_line_text_field", value: set.bricksetURL || "" },
    { namespace: "brickset", key: "source", type: "single_line_text_field", value: "brickset" },
    { namespace: "brickset", key: "imported_at", type: "date_time", value: new Date().toISOString() },
  ];

  const tags = ["brickset-imported"];
  if (set.year) tags.push(`year:${set.year}`);

  return {
    title,
    descriptionHtml: descriptionParts.join("\n"),
    vendor: set.theme || env.DEFAULT_VENDOR || "LEGO", // theme doubles as vendor
    productType: "Sets",
    category: CONSTRUCTION_TOYS_CATEGORY_ID,
    status: "DRAFT",
    tags,
    metafields,
  };
}

/**
 * Import multiple LEGO sets and create Shopify draft products using Brickset data.
 *
 * @param {Object} auth - authenticate.admin(request)
 * @param {Array<string>} ids - list of set IDs (e.g. ["40760-1", "40539-1"])
 * @param {Object} env - process.env
 */
export async function importSets(auth, ids, env) {
  const { admin } = await auth;

  const results = [];
  let importedCount = 0;

  const availableChannels = await getAvailableChannels(admin);
  // Every active location, read once per run: each new product is stocked at
  // all of them at zero so the POS never asks "stock at this location?".
  const locations = await getActiveLocations(admin);

  for (const rawId of ids) {
    const setNum = String(rawId || "").trim();
    if (!setNum) {
      results.push({
        id: rawId,
        status: "error",
        errorCode: "INVALID_SET_NUMBER",
        message: "Empty or invalid set number",
      });
      continue;
    }

    try {
      console.log(`[${setNum}] Starting import...`);

      let set;
      try {
        set = await fetchSet(setNum, env);
      } catch (err) {
        console.error(`[${setNum}] Failed to fetch from Brickset:`, err.message);
        results.push({
          id: setNum,
          status: "error",
          errorCode: "BRICKSET_FETCH_ERROR",
          message: `Failed to fetch set data from Brickset: ${err.message}`,
        });
        continue;
      }

      // The clean set number (without -1) is the SKU and goes in the title.
      const cleanSetNum = set.set_num_clean || set.set_num.replace(/-1$/, "");

      const existingProduct = await checkProductExists(admin, cleanSetNum);
      if (existingProduct.exists) {
        console.log(`[${setNum}] Product already exists with SKU ${cleanSetNum}: ${existingProduct.title}`);
        results.push({
          id: setNum,
          status: "skipped",
          errorCode: "DUPLICATE_SKU",
          message: `Product already exists with SKU "${cleanSetNum}": "${existingProduct.title}" (Status: ${existingProduct.status})`,
          existingProductId: existingProduct.productId,
          existingProductTitle: existingProduct.title,
          existingProductStatus: existingProduct.status,
        });
        continue;
      }

      const productInput = buildSetProductInput(set, cleanSetNum, env);

      const created = await createProduct(admin, productInput, setNum);
      if (!created.ok) {
        results.push({ id: setNum, status: "error", errorCode: created.errorCode, message: created.message });
        continue;
      }

      const { productId, title: productTitle } = created;
      console.log(`[${setNum}] Product created: ${productTitle}`);

      const variant = await getFirstVariant(admin, productId, setNum);
      if (!variant.ok) {
        results.push({
          id: setNum,
          status: "error",
          errorCode: variant.errorCode,
          message: variant.message,
          shopifyProductId: productId,
        });
        continue;
      }

      // Every barcode Brickset knows goes onto the variant with its type
      // (EAN for UK/EU boxes, UPC for North American boxes) so the set scans
      // at Shopify POS whichever box is on the counter. Left empty when
      // Brickset has neither, which the result message below flags.
      const barcodes = bricksetBarcodes({ ean: set.ean, upc: set.upc });
      await updateVariantFields(admin, {
        productId,
        variantId: variant.variantId,
        barcodes,
        label: setNum,
      });

      // Track inventory, then stock the item at every active location at
      // zero. A stocking failure is reported on this row, never fatal.
      let stocking = { ok: false, activated: [], alreadyActive: [], message: "variant has no inventory item" };
      if (variant.inventoryItemId) {
        await enableInventoryTracking(admin, { productId, variantId: variant.variantId, label: setNum });
        stocking = await stockAtAllLocations(admin, {
          inventoryItemId: variant.inventoryItemId,
          locations,
          label: setNum,
        });
      }

      await setVariantSku(admin, { productId, variantId: variant.variantId, sku: cleanSetNum, label: setNum });

      await publishToChannels(admin, { productId, channelIds: availableChannels, label: setNum });

      const attachedCount = await attachImages(admin, {
        productId,
        title: productInput.title,
        imageUrls: set.gallery,
        label: setNum,
      });

      importedCount += 1;

      // Note which barcodes Brickset supplied so missing ones surface in the UI.
      const barcodeNote = barcodes.length
        ? `barcodes ${describeBarcodes(barcodes)}`
        : "no barcode in Brickset";
      const stockingNote = stocking.ok
        ? describeStocking(stocking)
        : `NOT stocked at every location (${stocking.message})`;

      results.push({
        id: setNum,
        status: "created",
        errorCode: null,
        message: `${productTitle} (${setNum}): ${attachedCount} images, ${barcodeNote}, ${stockingNote}`,
        shopifyProductTitle: productTitle,
        shopifyProductId: productId,
        imageCount: attachedCount,
        ean: set.ean || null,
        upc: set.upc || null,
        barcodes,
        stockedAt: stocking.activated.concat(stocking.alreadyActive).map((l) => l.name),
        stockingError: stocking.ok ? null : stocking.message,
      });
    } catch (err) {
      console.error(`[${setNum}] Import failed:`, err?.message || "Unknown error");

      const errorMessage = err?.message || "Unknown error";
      let errorCode = "UNKNOWN_ERROR";

      if (errorMessage.includes("Brickset") || errorMessage.includes("brickset")) {
        errorCode = "BRICKSET_FETCH_ERROR";
      } else if (errorMessage.includes("product") && errorMessage.includes("create")) {
        errorCode = "PRODUCT_CREATE_ERROR";
      } else if (errorMessage.includes("variant")) {
        errorCode = "VARIANT_UPDATE_ERROR";
      } else if (errorMessage.includes("SKU") || errorMessage.includes("sku")) {
        errorCode = "SKU_SET_ERROR";
      } else if (errorMessage.includes("inventory")) {
        errorCode = "INVENTORY_ERROR";
      } else if (errorMessage.includes("sales channel") || errorMessage.includes("publish")) {
        errorCode = "SALES_CHANNEL_ERROR";
      } else if (errorMessage.includes("image") || errorMessage.includes("media")) {
        errorCode = "IMAGE_ERROR";
      }

      results.push({ id: setNum, status: "error", errorCode, message: errorMessage });
    }
  }

  return {
    ok: true,
    importedCount,
    totalRequested: ids.length,
    results,
  };
}
