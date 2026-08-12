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
        edges { node { id name } }
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
  const mutation = `
    mutation CreateProduct($input: ProductInput!) {
      productCreate(input: $input) {
        product { id title status publishedAt }
        userErrors { field message }
      }
    }
  `;

  const resp = await admin.graphql(mutation, { variables: { input: productInput } });
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

const VARIANTS_BULK_UPDATE = `
  mutation productVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      productVariants { id sku barcode inventoryPolicy inventoryItem { id tracked } }
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
 * `barcode` carries the set's EAN, or the minifigure's catalogue ID.
 * Passing null leaves the barcode empty.
 */
export async function updateVariantFields(admin, { productId, variantId, barcode, label = "" }) {
  return bulkUpdateVariant(
    admin,
    productId,
    { id: variantId, inventoryPolicy: "DENY", barcode: barcode || null },
    label,
    "Variant update"
  );
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

/**
 * Write the variant SKU.
 * GraphQL will not set a SKU on the auto-created default variant, so this
 * goes through the REST admin API.
 * @returns {Promise<boolean>} whether the SKU now matches
 */
export async function setVariantSku(session, { variantId, sku, label = "" }) {
  if (!session?.shop) {
    console.error(`[${label}] Cannot set SKU: session.shop not available`);
    return false;
  }

  try {
    const variantIdNum = variantId.split("/").pop();
    const resp = await fetch(`https://${session.shop}/admin/api/2025-10/variants/${variantIdNum}.json`, {
      method: "PUT",
      headers: {
        "X-Shopify-Access-Token": session.accessToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ variant: { sku } }),
    });

    if (!resp.ok) {
      console.error(`[${label}] Failed to set SKU: ${resp.status} ${await resp.text()}`);
      return false;
    }

    const json = await resp.json();
    if (json.variant?.sku !== sku) {
      console.error(`[${label}] SKU not set. Expected: ${sku}, Got: ${json.variant?.sku || "null"}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`[${label}] Error setting SKU:`, err.message);
    return false;
  }
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

  const mutation = `
    mutation productCreateMedia($media: [CreateMediaInput!]!, $productId: ID!) {
      productCreateMedia(media: $media, productId: $productId) {
        media { alt mediaContentType status }
        mediaUserErrors { field message }
        product { id title }
      }
    }
  `;

  const media = imageUrls.map((url, index) => ({
    alt: index === 0 ? title : `${title} (image ${index + 1})`,
    mediaContentType: "IMAGE",
    originalSource: url,
  }));

  try {
    const resp = await admin.graphql(mutation, { variables: { media, productId } });
    const json = await resp.json();

    if (json.errors) {
      console.error(`[${label}] Image attachment GraphQL error:`, json.errors[0]?.message || "Unknown error");
    }

    const mediaErrors = json.data?.productCreateMedia?.mediaUserErrors || [];
    if (mediaErrors.length) {
      console.warn(`[${label}] Image attachment errors:`, mediaErrors.map((e) => e.message).join("; "));
    }

    return json.data?.productCreateMedia?.media?.length || 0;
  } catch (err) {
    console.error(`[${label}] Failed to attach images:`, err.message);
    return 0;
  }
}
