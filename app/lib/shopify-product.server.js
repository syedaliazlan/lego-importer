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
//   - variant, channel and media failures are NON FATAL, because the product
//     already exists at that point and the team amends pricing by hand
//     anyway. The ones staff must fix by hand (SKU, tracking, stocking, a
//     variant that could not be read) are reported on the result row.

import {
  activationUpdates,
  activeLocationIdsFromLevels,
  describeStockingFailure,
  describeStockingUnknown,
  locationName,
  locationsToActivate,
  nonZeroAvailable,
} from "./inventory-locations.js";

/* ===============================================================
   CLIENT ERRORS AND RETRIES
=============================================================== */

// How admin.graphql fails, read in the installed library source:
//   - @shopify/shopify-api lib/clients/admin/graphql/client.mjs request():
//     any reply carrying `errors` goes to throwFailedRequest
//     (lib/clients/common.mjs), which ALWAYS throws: GraphqlQueryError for a
//     200 with GraphQL errors (THROTTLED, ACCESS_DENIED and so on, the raw
//     errors kept on err.body.errors.graphQLErrors), HttpRequestError when
//     there was no response, otherwise an HttpResponseError subclass.
//   - @shopify/shopify-app-react-router authenticate/admin/helpers/
//     handle-client-error.mjs rethrows an HttpResponseError as a plain
//     `Response` (status kept, no message), and anything else as it is.
// So admin.graphql never resolves with a body that has `errors`.

/**
 * Readable text for whatever admin.graphql threw.
 * @param {unknown} err
 */
export function describeClientError(err) {
  if (typeof Response !== "undefined" && err instanceof Response) {
    return `Shopify replied HTTP ${err.status}`;
  }
  const message = err && typeof err === "object" ? err.message : err;
  return String(message ?? "").trim() || "Unknown error";
}

// Retries for the reads and the writes that are safe to send twice, from the
// installed library source:
//   - admin.graphql(doc, { tries }) passes `tries - 1` as `retries`
//     (@shopify/shopify-app-react-router dist/esm/server/clients/admin/graphql.mjs).
//   - @shopify/graphql-client dist/graphql-client/http-fetch.mjs retries ONLY
//     when fetch itself throws (network) or the HTTP status is 429 or 503
//     (RETRIABLE_STATUS_CODES), waiting Retry-After or 1 s. Every other reply,
//     including a 500 and a 200 with GraphQL errors, is returned without a
//     retry. MAX_RETRIES is 3, so `tries` may be at most 4 (validateRetries
//     throws otherwise).
//   - The Admin GraphQL API reports query-cost rate limiting as 200 OK with a
//     THROTTLED error, not 429 (shopify.dev/docs/api/usage/response-codes);
//     a 429 is kept for resource-based limits, such as productCreate,
//     productUpdate and productVariantsBulkCreate once a store has 500,000
//     variants (shopify.dev/docs/apps/build/apis/graphql-admin/rate-limits).
//     The library does not retry THROTTLED. A throttled request is refused
//     before it runs ("Before execution begins, an app's bucket must have
//     enough capacity for the requested cost", same rate-limits page), so it
//     is retried here after the 1 s backoff shopify.dev/docs/api/usage/limits
//     recommends.
// Only reads and absolute writes go through here, because a lost reply means
// the same request is sent again:
//   - inventoryBulkToggleActivation only ever sends activate:true, for
//     locations a product created moments earlier was missing, so a repeat can
//     only reach levels the first attempt created at zero.
//   - productVariantsBulkUpdate here only sets values outright: the SKU,
//     tracked: true, inventoryPolicy DENY, and `barcodes`, which "Replaces the
//     entire barcode set" (2026-10 ProductVariantsBulkInput). Sending one twice
//     leaves the same result.
// productCreate never goes through here: a repeat would make a second product.
export const STOCKING_TRIES = 3;
export const THROTTLE_RETRIES = 2;
const THROTTLE_WAIT_MS = 1000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isThrottled(err) {
  const errors = err?.body?.errors?.graphQLErrors;
  return Array.isArray(errors) && errors.some((e) => e?.extensions?.code === "THROTTLED");
}

/**
 * admin.graphql with library retries (network, 429, 503) plus a retry after
 * 1 s on THROTTLED. Throws whatever admin.graphql throws once out of retries.
 * @param {{wait?: (ms: number) => Promise<void>}} [opts] wait is swapped in tests
 */
async function requestWithRetries(admin, document, variables, { wait = sleep } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const resp = await admin.graphql(document, { variables, tries: STOCKING_TRIES });
      return await resp.json();
    } catch (err) {
      if (attempt < THROTTLE_RETRIES && isThrottled(err)) {
        await wait(THROTTLE_WAIT_MS);
        continue;
      }
      throw err;
    }
  }
}

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
 * Retries like the stocking reads. If the check still fails it fails CLOSED:
 * `checked` is false and the caller skips the item, because importing blind
 * could create a second copy of a product the shop already has.
 * @param {{wait?: (ms: number) => Promise<void>}} [opts]
 * @returns {Promise<{checked: true, exists: boolean, productId?: string, title?: string, status?: string} | {checked: false, exists: false, error: string}>}
 */
export async function checkProductExists(admin, sku, opts = {}) {
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
    const json = await requestWithRetries(admin, query, { query: `sku:${sku}` }, opts);

    const product = json?.data?.products?.edges?.[0]?.node;
    if (product) {
      return {
        checked: true,
        exists: true,
        productId: product.id,
        title: product.title,
        status: product.status,
      };
    }
    return { checked: true, exists: false };
  } catch (err) {
    const error = describeClientError(err);
    console.warn(`Could not check for existing product with SKU ${sku}:`, error);
    return { checked: false, exists: false, error };
  }
}

/**
 * Row text for an item skipped because the duplicate check failed.
 * @param {{sku: string, importId: string, error: string}} args
 */
export function duplicateCheckFailedMessage({ sku, importId, error }) {
  return (
    `Not imported: could not check whether a product with SKU "${sku}" already exists (${error}). ` +
    `Nothing was created. Import ${importId} again.`
  );
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

// GraphQL error codes Shopify returns before a request runs: both are cost
// checks made "Before execution begins" / "enforced before a query is
// executed" (shopify.dev/docs/apps/build/apis/graphql-admin/rate-limits).
const REFUSED_BEFORE_RUNNING = new Set(["THROTTLED", "MAX_COST_EXCEEDED"]);

/**
 * Whether a request that threw may still have been carried out by Shopify.
 * Only a refusal is certain to have changed nothing: a 4xx status (rethrown as
 * a Response) or a 200 whose GraphQL errors are all cost refusals. No reply
 * at all (network), a 5xx, a 200 whose body was cut off or was not JSON (the
 * library rethrows that as a Response with status 200), any other GraphQL
 * error (an INTERNAL_SERVER_ERROR is "returned instead of 500 Internal Server
 * Error", and an access error can come from a field read after the change) or
 * anything unexpected may have come after the work was done.
 * @param {unknown} err what admin.graphql threw
 */
export function mayHaveBeenApplied(err) {
  if (typeof Response !== "undefined" && err instanceof Response) {
    return !(err.status >= 400 && err.status < 500);
  }
  const graphQLErrors = err?.body?.errors?.graphQLErrors;
  if (Array.isArray(graphQLErrors) && graphQLErrors.length) {
    return !graphQLErrors.every((e) => REFUSED_BEFORE_RUNNING.has(e?.extensions?.code));
  }
  return true;
}

/**
 * Row text when productCreate threw in a way that may have come after Shopify
 * created the product, so a draft may exist that this run cannot see.
 * @param {{title: string, importId: string, reason: string}} args
 */
export function possibleDraftMessage({ title, importId, reason }) {
  return (
    `Shopify did not confirm the product was created (${reason}), so a draft "${title}" may already exist. ` +
    `Search Shopify for that title before importing ${importId} again, or it may be created twice.`
  );
}

/**
 * Create a product. Sent ONCE, with no retries: a repeat after a lost reply
 * would create a second product. Never throws.
 * @returns {Promise<{ok: true, productId: string, title: string} |
 *   {ok: false, errorCode: string, message: string, mayExist?: boolean, reason?: string}>}
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

  let json;
  try {
    const resp = await admin.graphql(mutation, { variables: { product: productInput } });
    json = await resp.json();
  } catch (err) {
    const reason = describeClientError(err);
    console.error(`[${label}] Product creation failed:`, reason);
    if (mayHaveBeenApplied(err)) {
      return {
        ok: false,
        errorCode: "PRODUCT_CREATE_UNCONFIRMED",
        message: `Failed to create product: ${reason}`,
        mayExist: true,
        reason,
      };
    }
    return { ok: false, errorCode: "PRODUCT_CREATE_ERROR", message: `Failed to create product: ${reason}` };
  }

  const productCreate = json?.data?.productCreate;
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
 * Never throws: the product already exists at this point, so a failure comes
 * back as { ok: false } for the caller to report the draft it left behind.
 * The message completes "Created draft ... but <message>".
 * @param {{wait?: (ms: number) => Promise<void>}} [opts]
 * @returns {Promise<{ok: true, variantId: string, inventoryItemId?: string} | {ok: false, errorCode: string, message: string}>}
 */
export async function getFirstVariant(admin, productId, label = "", opts = {}) {
  const query = `
    query getProduct($id: ID!) {
      product(id: $id) {
        variants(first: 1) {
          edges { node { id sku inventoryItem { id tracked } } }
        }
      }
    }
  `;

  let json;
  try {
    json = await requestWithRetries(admin, query, { id: productId }, opts);
  } catch (err) {
    const message = describeClientError(err);
    console.error(`[${label}] Could not read the new product's variant:`, message);
    return {
      ok: false,
      errorCode: "VARIANT_QUERY_ERROR",
      message: `could not read its variant (${message})`,
    };
  }

  const variant = json?.data?.product?.variants?.edges?.[0]?.node;
  if (!variant?.id) {
    return {
      ok: false,
      errorCode: "VARIANT_NOT_FOUND",
      message: "Shopify returned no variant for it",
    };
  }

  return { ok: true, variantId: variant.id, inventoryItemId: variant.inventoryItem?.id };
}

/**
 * Row text for a product that was created but not finished, so staff can find
 * it and clean it up. Without a SKU the duplicate check cannot see it, so a
 * plain re-import would make a second copy.
 * @param {{title: string, productId: string, importId: string, reason: string}} args
 */
export function leftoverDraftMessage({ title, productId, importId, reason }) {
  return (
    `Created draft "${title}" (${productId}) but ${reason}. ` +
    `Its SKU, barcodes, stock locations, sales channels and images may not be set, ` +
    `and without a SKU a re-import cannot see it and would make a duplicate. ` +
    `Delete that draft in Shopify, then import ${importId} again.`
  );
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

// Non fatal by contract: log and report, never throw. Every input sent here
// sets values outright, so it goes through requestWithRetries (see there).
async function bulkUpdateVariant(admin, productId, variantInput, label, what, opts = {}) {
  try {
    const json = await requestWithRetries(admin, VARIANTS_BULK_UPDATE, { productId, variants: [variantInput] }, opts);

    const userErrors = json?.data?.productVariantsBulkUpdate?.userErrors || [];
    if (userErrors.length > 0) {
      console.error(`[${label}] ${what} failed:`, userErrors[0]?.message || "Unknown error");
      return null;
    }

    return json?.data?.productVariantsBulkUpdate?.productVariants?.[0] || null;
  } catch (err) {
    console.error(`[${label}] ${what} failed:`, describeClientError(err));
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
 * inventoryPolicy "Defaults to `DENY`" on the same input, so sending it only
 * makes sure; a failed write leaves it at that default.
 *
 * @param {Array<{value: string, type?: string|null}>} [barcodes]
 * @returns {Promise<object|null>} the updated variant, or null when the write failed
 */
export async function updateVariantFields(admin, { productId, variantId, barcodes, label = "", wait }) {
  const input = { id: variantId, inventoryPolicy: "DENY" };
  const rows = barcodeRows(barcodes);
  if (rows.length) input.barcodes = rows;

  return bulkUpdateVariant(admin, productId, input, label, "Variant update", wait ? { wait } : {});
}

function barcodeRows(barcodes) {
  return (barcodes || [])
    .filter((b) => b && String(b.value ?? "").trim())
    .map((b) => ({ value: String(b.value).trim(), type: b.type || null }));
}

/**
 * Turn on inventory tracking for the variant.
 * @returns {Promise<boolean>} whether tracking is on
 */
export async function enableInventoryTracking(admin, { productId, variantId, label = "", wait }) {
  const variant = await bulkUpdateVariant(
    admin,
    productId,
    { id: variantId, inventoryItem: { tracked: true } },
    label,
    "Inventory tracking update",
    wait ? { wait } : {}
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
//
// Ids ONLY. Location `name` needs the read_locations scope, which this app
// does not have. Asking for it fails the WHOLE query; observed on the live
// store 2026-11-09 with this app's own token:
//   "Access denied for name field. Required access: `read_locations` access
//    scope or `read_markets_home` access scope."
// That error made this function return [] on every run, so no imported
// product was stocked anywhere beyond the location Shopify created it at.
// The same query without `name` returns all three locations.
export const LOCATIONS_QUERY = `
  query ImportLocations {
    locations(first: 50) {
      edges { node { id } }
    }
  }
`;

/**
 * Every active location on the shop. Fetched ONCE per import run and passed
 * to stockAtAllLocations for each product. Names are not readable (see
 * LOCATIONS_QUERY), so each id is named from KNOWN_LOCATION_NAMES, or shown
 * by its numeric id when it is not one of the store's three.
 * Returns [] on failure so the import carries on; the missing stocking is
 * then reported on every product row.
 * @param {{wait?: (ms: number) => Promise<void>}} [opts]
 * @returns {Promise<Array<{id: string, name: string}>>}
 */
export async function getActiveLocations(admin, opts = {}) {
  try {
    const json = await requestWithRetries(admin, LOCATIONS_QUERY, undefined, opts);
    return (json?.data?.locations?.edges || [])
      .map((e) => e?.node)
      .filter((n) => n?.id)
      .map((n) => ({ id: n.id, name: locationName(n.id) }));
  } catch (err) {
    console.warn("Could not fetch locations, continuing without them:", describeClientError(err));
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
// `location { id }` only: `name` needs read_locations (see LOCATIONS_QUERY).
export const INVENTORY_BULK_TOGGLE_ACTIVATION = `
  mutation ImportStockAtLocations($inventoryItemId: ID!, $inventoryItemUpdates: [InventoryBulkToggleActivationInput!]!) {
    inventoryBulkToggleActivation(inventoryItemId: $inventoryItemId, inventoryItemUpdates: $inventoryItemUpdates) {
      inventoryItem { id }
      inventoryLevels {
        id
        location { id }
        quantities(names: ["available"]) { name quantity }
      }
      userErrors { field message code }
    }
  }
`;

async function readActiveLocationIds(admin, inventoryItemId, opts) {
  const json = await requestWithRetries(admin, INVENTORY_ITEM_LEVELS_QUERY, { id: inventoryItemId }, opts);
  return activeLocationIdsFromLevels(json?.data?.inventoryItem);
}

/**
 * Stock the variant's inventory item at every active location, at zero.
 * Reads where it is already stocked, activates only the missing locations in
 * ONE inventoryBulkToggleActivation call, and never throws: a failure comes
 * back as { ok: false, message } for the caller to put on the result row.
 *
 * When the activation reports a problem, or its payload leaves a location
 * out, the item's levels are read again: that read is the truth about where
 * it is stocked now, so the row can name the locations that did and did not
 * take.
 *
 * @param admin
 * @param {{inventoryItemId: string, locations: Array<{id: string, name: string}>, label?: string, wait?: (ms: number) => Promise<void>}} args
 * @returns {Promise<{
 *   ok: boolean,
 *   activated: Array<{id: string, name: string}>,
 *   alreadyActive: Array<{id: string, name: string}>,
 *   failed: Array<{id: string, name: string}>,
 *   unknown: Array<{id: string, name: string}>,
 *   nonZero: Array<{locationId: string, quantity: number}>,
 *   message: string|null,
 * }>}
 * `unknown` lists locations whose outcome could not be confirmed (reply and
 * re-read both failed); they are never reported as not stocked.
 */
export async function stockAtAllLocations(admin, { inventoryItemId, locations, label = "", wait }) {
  const result = { ok: false, activated: [], alreadyActive: [], failed: [], unknown: [], nonZero: [], message: null };
  const opts = wait ? { wait } : {};

  if (!inventoryItemId) {
    result.message = "variant has no inventory item";
    return result;
  }
  if (!locations?.length) {
    result.message = "could not read the shop's locations";
    return result;
  }

  let plan;
  try {
    plan = locationsToActivate({ locations, activeLocationIds: await readActiveLocationIds(admin, inventoryItemId, opts) });
  } catch (err) {
    result.message = `could not check where it is already stocked, so no location was added (${describeClientError(err)})`;
    console.error(`[${label}] ${result.message}`);
    return result;
  }
  result.alreadyActive = plan.alreadyActive;

  if (!plan.toActivate.length) {
    result.ok = true;
    return result;
  }

  let problem = null;
  let returned = new Set();
  try {
    const json = await requestWithRetries(
      admin,
      INVENTORY_BULK_TOGGLE_ACTIVATION,
      { inventoryItemId, inventoryItemUpdates: activationUpdates(plan.toActivate) },
      opts
    );
    const payload = json?.data?.inventoryBulkToggleActivation;
    returned = new Set((payload?.inventoryLevels || []).map((l) => l?.location?.id).filter(Boolean));
    result.nonZero = nonZeroAvailable(payload?.inventoryLevels);
    const userErrors = payload?.userErrors || [];
    if (userErrors.length) problem = userErrors.map((e) => e?.message).filter(Boolean).join("; ");
  } catch (err) {
    problem = describeClientError(err);
  }

  if (result.nonZero.length) {
    console.warn(`[${label}] activated levels with non-zero available:`, result.nonZero);
  }

  // The payload's inventoryLevels are "The activated inventory levels".
  let stockedNow = returned;
  if (plan.toActivate.some((l) => !returned.has(l.id))) {
    try {
      stockedNow = await readActiveLocationIds(admin, inventoryItemId, opts);
    } catch (err) {
      // Neither the reply nor a fresh read says where the rest stand. They
      // may well be stocked (a lost reply often follows a change that was
      // made), so do not claim they are not: say it is unknown.
      const recheckError = describeClientError(err);
      result.activated = plan.toActivate.filter((l) => returned.has(l.id));
      result.unknown = plan.toActivate.filter((l) => !returned.has(l.id));
      result.message = describeStockingUnknown({ ...result, problem, recheckError });
      console.error(`[${label}] ${result.message}`);
      return result;
    }
  }
  result.activated = plan.toActivate.filter((l) => stockedNow.has(l.id));
  result.failed = plan.toActivate.filter((l) => !stockedNow.has(l.id));

  if (!result.failed.length) {
    if (problem) console.warn(`[${label}] activation reported "${problem}" but every location is stocked`);
    result.ok = true;
    return result;
  }

  result.message = describeStockingFailure({ ...result, problem });
  console.error(`[${label}] ${result.message}`);
  return result;
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
export async function setVariantSku(admin, { productId, variantId, sku, label = "", wait }) {
  const variant = await bulkUpdateVariant(
    admin,
    productId,
    { id: variantId, inventoryItem: { sku } },
    label,
    "SKU update",
    wait ? { wait } : {}
  );
  if (variant?.sku !== sku) {
    console.error(`[${label}] SKU not set. Expected: ${sku}, Got: ${variant?.sku || "null"}`);
    return false;
  }
  return true;
}

/* ===============================================================
   NEW VARIANT SETUP (shared by both importers)
=============================================================== */

/**
 * Everything the importer does to the default variant of a product it has
 * just created, in the order Shopify needs:
 *   1. read the variant (never throws; a failure ends the setup)
 *   2. barcodes and inventory policy
 *   3. SKU, BEFORE stocking: inventoryBulkToggleActivation can refuse with
 *      MISSING_SKU, "Cannot stock this inventory item at this location
 *      because the variant is missing a SKU."
 *      https://shopify.dev/docs/api/admin-graphql/2026-10/enums/InventoryBulkToggleActivationUserErrorCode
 *   4. inventory tracking
 *   5. stock at every location at zero
 * Never throws. A barcode, SKU or tracking write that did not take is
 * returned in `warnings` for the result row, because staff must fix it by
 * hand.
 *
 * @param {{productId: string, sku: string, barcodes: Array<{value: string, type?: string|null}>,
 *   locations: Array<{id: string, name: string}>, label?: string, wait?: (ms: number) => Promise<void>}} args
 * @returns {Promise<{ok: false, errorCode: string, message: string} | {
 *   ok: true, variantId: string, inventoryItemId?: string, barcodesWritten: boolean, skuSet: boolean,
 *   tracked: boolean, stocking: Awaited<ReturnType<typeof stockAtAllLocations>>, warnings: string[] }>}
 */
export async function setUpNewVariant(admin, { productId, sku, barcodes, locations, label = "", wait }) {
  const opts = wait ? { wait } : {};

  const variant = await getFirstVariant(admin, productId, label, opts);
  if (!variant.ok) return variant;
  const { variantId, inventoryItemId } = variant;

  const warnings = [];
  const wanted = barcodeRows(barcodes);
  const fields = await updateVariantFields(admin, { productId, variantId, barcodes, label, ...opts });
  // With no barcode to write, the call only re-states inventoryPolicy DENY,
  // which is already the default, so a failure there needs no warning.
  const barcodesWritten = Boolean(fields) || !wanted.length;
  if (!barcodesWritten) {
    warnings.push(
      `barcodes not written: add ${wanted.map((b) => b.value).join(", ")} to the variant in Shopify, or the tills cannot scan it`
    );
  }

  const skuSet = await setVariantSku(admin, { productId, variantId, sku, label, ...opts });
  if (!skuSet) {
    warnings.push(`SKU not set: set it to ${sku} in Shopify, otherwise a re-import cannot see this product and will make a duplicate`);
  }

  let tracked = false;
  let stocking = {
    ok: false,
    activated: [],
    alreadyActive: [],
    failed: [],
    unknown: [],
    nonZero: [],
    message: "variant has no inventory item",
  };
  if (inventoryItemId) {
    tracked = await enableInventoryTracking(admin, { productId, variantId, label, ...opts });
    if (!tracked) warnings.push("inventory tracking is off: open the variant in Shopify and tick Track quantity");
    stocking = await stockAtAllLocations(admin, { inventoryItemId, locations, label, ...opts });
  }

  return { ok: true, variantId, inventoryItemId, barcodesWritten, skuSet, tracked, stocking, warnings };
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
