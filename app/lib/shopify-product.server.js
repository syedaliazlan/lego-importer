// app/lib/shopify-product.server.js
//
// Shopify write helpers shared by the set importer and the minifigure
// importer. Both build a different product from a different source, but the
// Shopify side is identical: check the SKU is free, create a draft, set the
// variant fields, publish to every channel and attach images.
//
// Failure policy matches what the set importer has always done:
//   - a failed duplicate check fails OPEN, so a Shopify hiccup never blocks
//     an import
//   - product creation failures are FATAL for that item
//   - variant, channel and media failures are NON FATAL and only logged,
//     because the product already exists at that point and the team amends
//     pricing by hand anyway

import {
  activationUpdates,
  activeLocationIdsFromLevels,
  locationsToActivate,
  nonZeroAvailable,
} from "./inventory-locations.js";

// Shopify Standard Product Taxonomy categories.
// Sets are construction toys; minifigures are filed as action figures, which is
// what the shop's existing hand-built minifigure listings use.
export const CONSTRUCTION_TOYS_CATEGORY_ID = "gid://shopify/TaxonomyCategory/tg-5-7-8";
export const ACTION_FIGURES_CATEGORY_ID = "gid://shopify/TaxonomyCategory/tg-5-8-1-1";

/* ===============================================================
   LOOKUPS
=============================================================== */

/**
 * Find an existing product by variant SKU.
 * Fails open: if the query itself errors we report "not found" rather than
 * blocking the import.
 * @returns {Promise<{exists: boolean, productId?: string, title?: string, status?: string, error?: string}>}
 */
export async function checkProductExists(admin, sku) {
  const query = `
    query checkProductBySku($query: String!) {
      products(first: 1, query: $query) {
        edges {
          node {
            id
            title
            status
            variants(first: 1) { edges { node { sku } } }
          }
        }
      }
    }
  `;

  try {
    const resp = await admin.graphql(query, { variables: { query: `sku:${sku}` } });
    const json = await resp.json();

    const product = json.data?.products?.edges?.[0]?.node;
    if (product) {
      return {
        exists: true,
        productId: product.id,
        title: product.title,
        status: product.status,
      };
    }
    return { exists: false };
  } catch (err) {
    console.warn(`Could not check for existing product with SKU ${sku}:`, err.message);
    return { exists: false, error: err.message };
  }
}

/**
 * List every publication (sales channel) on the shop.
 * Returns [] on failure so the caller can carry on without publishing.
 * @returns {Promise<Array<string>>} publication IDs
 */
export async function getAvailableChannels(admin) {
  const query = `
    query {
      publications(first: 50) {
        edges { node { id } }
      }
    }
  `;

  try {
    const resp = await admin.graphql(query);
    const json = await resp.json();
    const publications = json.data?.publications?.edges || [];
    return publications.map((edge) => edge.node.id);
  } catch (err) {
    console.warn("Could not fetch sales channels, continuing without them:", err);
    return [];
  }
}

/* ===============================================================
   PRODUCT CREATE
=============================================================== */

// Shopify rejects metafields whose definition does not exist on this shop.
// Those are expected (custom.year_released exists on live but not on dev) and
// must not fail the import.
function isMissingMetafieldDefinition(error) {
  const message = error?.message || "";
  return (
    message.includes("metafield") &&
    (message.includes("does not exist") ||
      message.includes("not found") ||
      message.includes("No metafield definition"))
  );
}

/**
 * Create a product.
 * @returns {Promise<{ok: true, productId: string, title: string} | {ok: false, errorCode: string, message: string}>}
 */
export async function createProduct(admin, productInput, label = "") {
  // `product: ProductCreateInput` replaces the deprecated `input: ProductInput`
  // (2026-10). The fields the importer sends exist on both; the ones only on
  // ProductInput (publications, published, publishDate and so on) are not used.
  //   https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/productCreate
  const mutation = `
    mutation CreateProduct($product: ProductCreateInput!) {
      productCreate(product: $product) {
        product { id title status publishedAt }
        userErrors { field message }
      }
    }
  `;

  const resp = await admin.graphql(mutation, { variables: { product: productInput } });
  const json = await resp.json();

  if (json.errors) {
    const message = json.errors[0]?.message || "Unknown GraphQL error";
    console.error(`[${label}] Product creation GraphQL error:`, message);
    return { ok: false, errorCode: "PRODUCT_CREATE_ERROR", message: `Failed to create product: ${message}` };
  }

  const productCreate = json.data?.productCreate;
  if (!productCreate) {
    return {
      ok: false,
      errorCode: "PRODUCT_CREATE_ERROR",
      message: "No productCreate payload returned from Shopify",
    };
  }

  const userErrors = productCreate.userErrors || [];
  if (userErrors.length > 0) {
    const criticalErrors = userErrors.filter((e) => !isMissingMetafieldDefinition(e));

    if (criticalErrors.length > 0) {
      const message = criticalErrors.map((e) => e.message).join("; ");
      return { ok: false, errorCode: "PRODUCT_CREATE_ERROR", message: `Failed to create product: ${message}` };
    }
    console.warn(`[${label}] Non-critical metafield errors (field may not exist on this shop):`, userErrors);
  }

  // A product can come back missing only when Shopify reported errors we
  // classified as non-critical, so treat it as a create failure.
  if (!productCreate.product?.id) {
    return {
      ok: false,
      errorCode: "PRODUCT_CREATE_ERROR",
      message: "Shopify returned no product for this item",
    };
  }

  return { ok: true, productId: productCreate.product.id, title: productCreate.product.title };
}

/* ===============================================================
   VARIANT
=============================================================== */

/**
 * Read the default variant Shopify creates alongside a new product.
 * @returns {Promise<{ok: true, variantId: string, inventoryItemId?: string} | {ok: false, errorCode: string, message: string}>}
 */
export async function getFirstVariant(admin, productId, label = "") {
  const query = `
    query getProduct($id: ID!) {
      product(id: $id) {
        variants(first: 1) {
          edges { node { id sku inventoryItem { id tracked } } }
        }
      }
    }
  `;

  const resp = await admin.graphql(query, { variables: { id: productId } });
  const json = await resp.json();

  if (json.errors) {
    const message = json.errors[0]?.message || "Unknown error";
    console.error(`[${label}] GraphQL errors fetching variant:`, message);
    return {
      ok: false,
      errorCode: "VARIANT_QUERY_ERROR",
      message: `Failed to fetch product variant: ${message}`,
    };
  }

  const variant = json.data?.product?.variants?.edges?.[0]?.node;
  if (!variant?.id) {
    return {
      ok: false,
      errorCode: "VARIANT_NOT_FOUND",
      message: "No variant found for the created product",
    };
  }

  return { ok: true, variantId: variant.id, inventoryItemId: variant.inventoryItem?.id };
}

// Selection uses `barcodes` (Admin API 2026-10). The old single `barcode`
// field is deprecated there ("Use `barcodes` instead.") and only mirrors the
// first entry of the list.
//   https://shopify.dev/docs/api/admin-graphql/2026-10/objects/ProductVariant
const VARIANTS_BULK_UPDATE = `
  mutation productVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      productVariants {
        id
        sku
        inventoryPolicy
        barcodes(first: 20) { nodes { value type } }
        inventoryItem { id tracked }
      }
      userErrors { field message }
    }
  }
`;

// Non fatal by contract: log and report, never throw.
async function bulkUpdateVariant(admin, productId, variantInput, label, what) {
  try {
    const resp = await admin.graphql(VARIANTS_BULK_UPDATE, {
      variables: { productId, variants: [variantInput] },
    });
    const json = await resp.json();

    if (json.errors) {
      console.error(`[${label}] ${what} error:`, json.errors[0]?.message || "Unknown error");
      return null;
    }

    const userErrors = json.data?.productVariantsBulkUpdate?.userErrors || [];
    if (userErrors.length > 0) {
      console.error(`[${label}] ${what} failed:`, userErrors[0]?.message || "Unknown error");
      return null;
    }

    return json.data?.productVariantsBulkUpdate?.productVariants?.[0] || null;
  } catch (err) {
    console.error(`[${label}] ${what} failed:`, err.message);
    return null;
  }
}

/**
 * Set the variant fields we control at import time.
 * `barcodes` is the full typed list for a brand new variant: the set's EAN
 * and UPC from Brickset, or the minifigure's catalogue ID (untyped).
 * An empty list leaves the variant with no barcode.
 *
 * Input shape confirmed on shopify.dev for Admin API 2026-10 (read 2026-09-12):
 *   ProductVariantsBulkInput.barcodes: [BarcodeInput!]
 *     "Replaces the entire barcode set. A variant accepts up to 20 barcodes,
 *      and a given variant input can't set both `barcode` and `barcodes`."
 *   BarcodeInput { value: String!, type: BarcodeType }
 *     type: "A `null` format denotes no type provided on write and the value
 *      is stored as entered." Typed values are validated against their format.
 *   The legacy ProductVariantsBulkInput.barcode is deprecated ("Use `barcodes`
 *   instead.") and is NOT sent here, because both cannot be set together.
 *   https://shopify.dev/docs/api/admin-graphql/2026-10/input-objects/ProductVariantsBulkInput
 *   https://shopify.dev/docs/api/admin-graphql/2026-10/input-objects/BarcodeInput
 *
 * @param {Array<{value: string, type?: string|null}>} [barcodes]
 */
export async function updateVariantFields(admin, { productId, variantId, barcodes, label = "" }) {
  const rows = (barcodes || [])
    .filter((b) => b && String(b.value ?? "").trim())
    .map((b) => ({ value: String(b.value).trim(), type: b.type || null }));

  const input = { id: variantId, inventoryPolicy: "DENY" };
  if (rows.length) input.barcodes = rows;

  return bulkUpdateVariant(admin, productId, input, label, "Variant update");
}

/**
 * Turn on inventory tracking for the variant.
 * @returns {Promise<boolean>} whether tracking is on
 */
export async function enableInventoryTracking(admin, { productId, variantId, label = "" }) {
  const variant = await bulkUpdateVariant(
    admin,
    productId,
    { id: variantId, inventoryItem: { tracked: true } },
    label,
    "Inventory tracking update"
  );
  return Boolean(variant?.inventoryItem?.tracked);
}

/* ===============================================================
   LOCATIONS
=============================================================== */

// `locations` returns only ACTIVE, non-legacy locations by default
// (includeInactive: false, includeLegacy: false), which is exactly the set a
// product should be stocked at. Read on shopify.dev for 2026-10 (2026-09-14):
//   https://shopify.dev/docs/api/admin-graphql/2026-10/queries/locations
//   https://shopify.dev/docs/api/admin-graphql/2026-10/objects/Location
// Requires read_inventory (implied by write_inventory) or read_locations.
const LOCATIONS_QUERY = `
  query ImportLocations {
    locations(first: 50) {
      edges { node { id name } }
    }
  }
`;

/**
 * Every active location on the shop. Fetched ONCE per import run and passed
 * to stockAtAllLocations for each product.
 * Returns [] on failure so the import carries on; the missing stocking is
 * then reported on every product row.
 * @returns {Promise<Array<{id: string, name: string}>>}
 */
export async function getActiveLocations(admin) {
  try {
    const resp = await admin.graphql(LOCATIONS_QUERY);
    const json = await resp.json();
    if (json.errors) {
      console.warn("Could not fetch locations:", json.errors[0]?.message || "Unknown error");
      return [];
    }
    return (json.data?.locations?.edges || [])
      .map((e) => e?.node)
      .filter((n) => n?.id)
      .map((n) => ({ id: n.id, name: n.name || n.id }));
  } catch (err) {
    console.warn("Could not fetch locations, continuing without them:", err?.message);
    return [];
  }
}

// Where the inventory item is stocked right now. Field names read on
// shopify.dev for 2026-10 (2026-09-14):
//   InventoryItem.inventoryLevels(first:) -> InventoryLevelConnection
//     "A list of the inventory item's quantities for each location that the
//      inventory item can be stocked at."
//   https://shopify.dev/docs/api/admin-graphql/2026-10/objects/InventoryItem
const INVENTORY_ITEM_LEVELS_QUERY = `
  query ImportInventoryLevels($id: ID!) {
    inventoryItem(id: $id) {
      id
      inventoryLevels(first: 50) {
        edges { node { location { id } } }
      }
    }
  }
`;

// Mutation chosen: inventoryBulkToggleActivation, NOT inventoryActivate.
//
//   inventoryBulkToggleActivation(inventoryItemId: ID!,
//       inventoryItemUpdates: [InventoryBulkToggleActivationInput!]!)
//     InventoryBulkToggleActivationInput { locationId: ID!, activate: Boolean! }
//     payload: inventoryItem, inventoryLevels ([InventoryLevel!], "The
//       activated inventory levels."), userErrors { field message code }
//   https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/inventoryBulkToggleActivation
//   https://shopify.dev/docs/api/admin-graphql/2026-10/input-objects/InventoryBulkToggleActivationInput
//
//   inventoryActivate(inventoryItemId: ID!, locationId: ID!, available: Int, onHand: Int)
//   https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/inventoryActivate
//
// Why: inventoryActivate takes ONE locationId per call, so stocking a product
// at N locations is N mutations. inventoryBulkToggleActivation takes the
// whole list in one call. Neither sets a quantity on activation other than
// through inventoryActivate's optional `available`/`onHand`, and a level
// created by activation starts at zero in every state, which is what the
// shop wants ("stocked at every location at zero"). The payload's
// inventoryLevels are read back with quantities(names: ["available"]) so a
// non-zero level would be reported rather than assumed. Both require
// write_inventory, which the app already has in shopify.app.toml.
const INVENTORY_BULK_TOGGLE_ACTIVATION = `
  mutation ImportStockAtLocations($inventoryItemId: ID!, $inventoryItemUpdates: [InventoryBulkToggleActivationInput!]!) {
    inventoryBulkToggleActivation(inventoryItemId: $inventoryItemId, inventoryItemUpdates: $inventoryItemUpdates) {
      inventoryItem { id }
      inventoryLevels {
        id
        location { id name }
        quantities(names: ["available"]) { name quantity }
      }
      userErrors { field message code }
    }
  }
`;

/**
 * Stock the variant's inventory item at every active location, at zero.
 * Reads where it is already stocked, activates only the missing locations in
 * ONE inventoryBulkToggleActivation call, and never throws: a failure comes
 * back as { ok: false, message } for the caller to put on the result row.
 *
 * @param admin
 * @param {{inventoryItemId: string, locations: Array<{id: string, name: string}>, label?: string}} args
 * @returns {Promise<{
 *   ok: boolean,
 *   activated: Array<{id: string, name: string}>,
 *   alreadyActive: Array<{id: string, name: string}>,
 *   nonZero: Array<{locationId: string, quantity: number}>,
 *   message: string|null,
 * }>}
 */
export async function stockAtAllLocations(admin, { inventoryItemId, locations, label = "" }) {
  const result = { ok: false, activated: [], alreadyActive: [], nonZero: [], message: null };

  if (!inventoryItemId) {
    result.message = "variant has no inventory item";
    return result;
  }
  if (!locations?.length) {
    result.message = "could not read the shop's locations";
    return result;
  }

  try {
    const levelsResp = await admin.graphql(INVENTORY_ITEM_LEVELS_QUERY, { variables: { id: inventoryItemId } });
    const levelsJson = await levelsResp.json();
    if (levelsJson.errors) {
      result.message = `could not read current locations: ${levelsJson.errors[0]?.message || "Unknown error"}`;
      console.error(`[${label}] ${result.message}`);
      return result;
    }

    const activeIds = activeLocationIdsFromLevels(levelsJson.data?.inventoryItem);
    const plan = locationsToActivate({ locations, activeLocationIds: activeIds });
    result.alreadyActive = plan.alreadyActive;

    if (!plan.toActivate.length) {
      result.ok = true;
      return result;
    }

    const resp = await admin.graphql(INVENTORY_BULK_TOGGLE_ACTIVATION, {
      variables: { inventoryItemId, inventoryItemUpdates: activationUpdates(plan.toActivate) },
    });
    const json = await resp.json();

    if (json.errors) {
      result.message = `activation failed: ${json.errors[0]?.message || "Unknown error"}`;
      console.error(`[${label}] ${result.message}`);
      return result;
    }

    const payload = json.data?.inventoryBulkToggleActivation;
    const userErrors = payload?.userErrors || [];
    if (userErrors.length) {
      result.message = `activation failed: ${userErrors.map((e) => e.message).join("; ")}`;
      console.error(`[${label}] ${result.message}`);
      return result;
    }

    // Trust the payload over the plan: the activated levels are what Shopify
    // says it created.
    const returned = new Set((payload?.inventoryLevels || []).map((l) => l?.location?.id).filter(Boolean));
    result.activated = plan.toActivate.filter((l) => returned.has(l.id));
    const missed = plan.toActivate.filter((l) => !returned.has(l.id));
    result.nonZero = nonZeroAvailable(payload?.inventoryLevels);

    if (missed.length) {
      result.message = `not activated at ${missed.map((l) => l.name).join(", ")}`;
      console.error(`[${label}] ${result.message}`);
      return result;
    }
    if (result.nonZero.length) {
      console.warn(`[${label}] activated levels with non-zero available:`, result.nonZero);
    }
    result.ok = true;
    return result;
  } catch (err) {
    result.message = `activation failed: ${err?.message || "Unknown error"}`;
    console.error(`[${label}] ${result.message}`);
    return result;
  }
}

/**
 * Write the variant SKU.
 *
 * The SKU lives on the inventory item, so it is written through
 * ProductVariantsBulkInput.inventoryItem.sku (InventoryItemInput.sku), the
 * same productVariantsBulkUpdate call used for tracking above. This replaced a
 * REST PUT /admin/api/2025-10/variants/{id}.json when the app moved to 2026-10:
 * the REST call was pinned to a version about to leave support, and REST
 * product endpoints are legacy.
 *   https://shopify.dev/docs/api/admin-graphql/2026-10/input-objects/InventoryItemInput
 * @returns {Promise<boolean>} whether the SKU now matches
 */
export async function setVariantSku(admin, { productId, variantId, sku, label = "" }) {
  const variant = await bulkUpdateVariant(
    admin,
    productId,
    { id: variantId, inventoryItem: { sku } },
    label,
    "SKU update"
  );
  if (variant?.sku !== sku) {
    console.error(`[${label}] SKU not set. Expected: ${sku}, Got: ${variant?.sku || "null"}`);
    return false;
  }
  return true;
}

/* ===============================================================
   PUBLISH + MEDIA
=============================================================== */

/**
 * Select every sales channel for the product.
 * The product stays in draft until someone activates it, so this only
 * decides where it will appear once it goes live.
 */
export async function publishToChannels(admin, { productId, channelIds, label = "" }) {
  if (!channelIds?.length) return false;

  const mutation = `
    mutation publishablePublish($id: ID!, $input: [PublicationInput!]!) {
      publishablePublish(id: $id, input: $input) {
        publishable { ... on Product { id publishedAt status } }
        userErrors { field message }
      }
    }
  `;

  try {
    const resp = await admin.graphql(mutation, {
      variables: { id: productId, input: channelIds.map((publicationId) => ({ publicationId })) },
    });
    const json = await resp.json();

    if (json.errors) {
      console.error(`[${label}] Sales channel publish error:`, json.errors[0]?.message || "Unknown error");
      return false;
    }

    const userErrors = json.data?.publishablePublish?.userErrors || [];
    if (userErrors.length > 0) {
      console.error(`[${label}] Sales channel publish failed:`, userErrors[0]?.message || "Unknown error");
      return false;
    }

    return Boolean(json.data?.publishablePublish);
  } catch (err) {
    console.error(`[${label}] Failed to publish to sales channels:`, err.message);
    return false;
  }
}

/**
 * Attach images by URL. Shopify fetches each one and copies it onto its own
 * CDN, so the source only has to be reachable during the import.
 * @returns {Promise<number>} how many media items were accepted
 */
export async function attachImages(admin, { productId, title, imageUrls, label = "" }) {
  if (!Array.isArray(imageUrls) || imageUrls.length === 0) return 0;

  // productUpdate(media:) replaces the deprecated productCreateMedia (2026-10).
  // Its payload has no media list or mediaUserErrors, so the accepted count is
  // read back from the product, matched on the alt text set here.
  //   https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/productUpdate
  const mutation = `
    mutation AttachImages($product: ProductUpdateInput!, $media: [CreateMediaInput!]) {
      productUpdate(product: $product, media: $media) {
        product { id media(first: 50) { nodes { alt mediaContentType status } } }
        userErrors { field message }
      }
    }
  `;

  const media = imageUrls.map((url, index) => ({
    alt: index === 0 ? title : `${title} (image ${index + 1})`,
    mediaContentType: "IMAGE",
    originalSource: url,
  }));

  try {
    const resp = await admin.graphql(mutation, { variables: { product: { id: productId }, media } });
    const json = await resp.json();

    if (json.errors) {
      console.error(`[${label}] Image attachment GraphQL error:`, json.errors[0]?.message || "Unknown error");
    }

    const mediaErrors = json.data?.productUpdate?.userErrors || [];
    if (mediaErrors.length) {
      console.warn(`[${label}] Image attachment errors:`, mediaErrors.map((e) => e.message).join("; "));
    }

    const ourAlts = new Set(media.map((m) => m.alt));
    const nodes = json.data?.productUpdate?.product?.media?.nodes || [];
    return nodes.filter((n) => ourAlts.has(n.alt)).length;
  } catch (err) {
    console.error(`[${label}] Failed to attach images:`, err.message);
    return 0;
  }
}
