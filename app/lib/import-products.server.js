// app/lib/import-products.server.js

import { fetchSet } from "./brickset.server.js";
import { processImageToSquare, uploadImageToShopify } from "./image-processor.server.js";

/**
 * Import multiple LEGO sets and create Shopify draft products using Brickset data.
 *
 * @param {Object} auth - authenticate.admin(request)
 * @param {Array<string>} ids - list of set IDs (e.g. ["40760-1", "40539-1"])
 * @param {Object} env - process.env
 */
export async function importSets(auth, ids, env) {
  const { admin, session } = await auth;

  const results = [];
  let importedCount = 0;

  // Helper function to check if a product with the given SKU already exists
  async function checkProductExists(admin, sku) {
    try {
      const checkQuery = `
        query checkProductBySku($query: String!) {
          products(first: 1, query: $query) {
            edges {
              node {
                id
                title
                status
                variants(first: 1) {
                  edges {
                    node {
                      sku
                    }
                  }
                }
              }
            }
          }
        }
      `;
      
      // Search for products with this SKU
      const query = `sku:${sku}`;
      const resp = await admin.graphql(checkQuery, {
        variables: { query }
      });
      const json = await resp.json();
      
      const products = json.data?.products?.edges || [];
      if (products.length > 0) {
        const product = products[0].node;
        return {
          exists: true,
          productId: product.id,
          title: product.title,
          status: product.status
        };
      }
      
      return { exists: false };
    } catch (err) {
      // If query fails, log but don't block import (fail open)
      console.warn(`Could not check for existing product with SKU ${sku}:`, err.message);
      return { exists: false, error: err.message };
    }
  }

  // Helper function to get all available sales channels/publications
  async function getAvailableChannels(admin) {
    try {
      const channelsQuery = `
        query {
          publications(first: 50) {
            edges {
              node {
                id
                name
              }
            }
          }
        }
      `;
      const resp = await admin.graphql(channelsQuery);
      const json = await resp.json();
      const publications = json.data?.publications?.edges || [];
      const channelIds = publications.map(edge => edge.node.id);
      return channelIds;
    } catch (err) {
      console.warn("Could not fetch sales channels, continuing without them:", err);
      return [];
    }
  }

  // Get all available sales channels once
  const availableChannels = await getAvailableChannels(admin);
  
  // Category ID for "Construction Set Toys" from Shopify Standard Product Taxonomy
  const categoryId = "gid://shopify/TaxonomyCategory/tg-5-7-8";

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
      
      // First, fetch set data to get the clean SKU
      let set;
      try {
        set = await fetchSet(setNum, env);
      } catch (err) {
        console.error(`[${setNum}] ❌ Failed to fetch from Brickset:`, err.message);
        results.push({
          id: setNum,
          status: "error",
          errorCode: "BRICKSET_FETCH_ERROR",
          message: `Failed to fetch set data from Brickset: ${err.message}`,
        });
        continue;
      }

      // Use clean set number (without -1) for title and SKU
      const cleanSetNum = set.set_num_clean || set.set_num.replace(/-1$/, '');
      
      // Check if product with this SKU already exists
      const existingProduct = await checkProductExists(admin, cleanSetNum);
      if (existingProduct.exists) {
        console.log(`[${setNum}] ⚠️ Product already exists with SKU ${cleanSetNum}: ${existingProduct.title} (${existingProduct.status})`);
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
      
      const title = [
      `${set.name} ${cleanSetNum}`,
      set.theme && `${set.theme}`,
      "LEGO"
    ].filter(Boolean).join(" | ");


      // Basic description using Brickset fields
      const detailsLines = [];

      if (set.year) {
        detailsLines.push(`<li><strong>Year:</strong> ${set.year}</li>`);
      }
      if (set.pieces) {
        detailsLines.push(`<li><strong>Pieces:</strong> ${set.pieces}</li>`);
      }
      if (set.theme) {
        detailsLines.push(`<li><strong>Theme:</strong> ${set.theme}</li>`);
      }
      if (set.subtheme) {
        detailsLines.push(`<li><strong>Subtheme:</strong> ${set.subtheme}</li>`);
      }

      const descriptionParts = [];

      descriptionParts.push(
        `<p><strong>${set.name} (${set.set_num})</strong></p>`,
      );

      if (detailsLines.length) {
        descriptionParts.push(
          `<ul>${detailsLines.join("")}</ul>`,
        );
      }

      if (set.description) {
        descriptionParts.push(`<p>${set.description}</p>`);
      }

      // if (set.bricksetURL) {
      //   descriptionParts.push(
      //     `<p><a href="${set.bricksetURL}" target="_blank" rel="noopener noreferrer">View on Brickset</a></p>`,
      //   );
      // }

      const descriptionHtml = descriptionParts.join("\n");

      // Metafields mapped from Brickset
      const metafields = [
        {
          namespace: "brickset",
          key: "set_number",
          type: "single_line_text_field",
          value: set.set_num,
        },
        {
          namespace: "brickset",
          key: "theme",
          type: "single_line_text_field",
          value: set.theme || "",
        },
        {
          namespace: "brickset",
          key: "subtheme",
          type: "single_line_text_field",
          value: set.subtheme || "",
        },
        // Metafield types must match the actual definitions in Shopify
        // Based on screenshot: brickset.year is Integer, brickset.pieces is Single line text
        {
          namespace: "brickset",
          key: "year",
          type: "number_integer",   
          value: set.year ? String(set.year) : null
        },
        // custom.year_released - exists on live site as Integer, doesn't exist on dev theme
        // Set it as Integer for live site, will be ignored gracefully if field doesn't exist
        {
          namespace: "custom",
          key: "year_released",
          type: "number_integer",
          value: set.year ? String(set.year) : null
        },
        {
          namespace: "brickset",
          key: "pieces",
          type: "single_line_text_field",    
          value: set.pieces ? String(set.pieces) : ""
        },
        {
          namespace: "brickset",
          key: "brickset_url",
          type: "single_line_text_field",
          value: set.bricksetURL || "",
        },
        {
          namespace: "brickset",
          key: "source",
          type: "single_line_text_field",
          value: "brickset",
        },
        {
          namespace: "brickset",
          key: "imported_at",
          type: "date_time",
          value: new Date().toISOString(),
        },
      ];

      // Tags: only keep brickset-imported and year, remove theme (it's now vendor)
      const tags = ["brickset-imported"];
      if (set.year) tags.push(`year:${set.year}`);

      // Basic product (no media yet)
      // Note: variants cannot be set in ProductInput in newer API versions
      const productInput = {
        title,
        descriptionHtml,
        vendor: set.theme || env.DEFAULT_VENDOR || "LEGO", // Use theme as vendor
        productType: "Sets", // Fixed to "Sets" as requested
        category: categoryId, // "Construction Set Toys" category ID
        status: "DRAFT",
        tags,
        metafields,
      };


      // Create the product
      const createMutation = `
        mutation CreateProduct($input: ProductInput!) {
          productCreate(input: $input) {
            product {
              id
              title
              status
              publishedAt
            }
            userErrors {
              field
              message
            }
          }
        }
      `;

      const createResp = await admin.graphql(createMutation, {
        variables: { input: productInput },
      });
      const createJson = await createResp.json();


      // Check for GraphQL errors
      if (createJson.errors) {
        const errorMsg = createJson.errors[0]?.message || "Unknown GraphQL error";
        console.error(`[${setNum}] ❌ Product creation GraphQL error:`, errorMsg);
        results.push({
          id: setNum,
          status: "error",
          errorCode: "PRODUCT_CREATE_ERROR",
          message: `Failed to create product: ${errorMsg}`,
        });
        continue;
      }

      const productCreate = createJson.data?.productCreate;
      if (!productCreate) {
        results.push({
          id: setNum,
          status: "error",
          errorCode: "PRODUCT_CREATE_ERROR",
          message: "No productCreate payload returned from Shopify",
        });
        continue;
      }

      if (productCreate.userErrors && productCreate.userErrors.length > 0) {
        // Filter out metafield errors for fields that don't exist (like custom.year_released on dev theme)
        // These are non-critical and we can continue
        const criticalErrors = productCreate.userErrors.filter(
          (e) => !(e.message.includes("metafield") && 
                   (e.message.includes("does not exist") ||
                    e.message.includes("not found") ||
                    e.message.includes("No metafield definition")))
        );
        
        // If only non-critical metafield errors, log them but continue
        if (criticalErrors.length === 0 && productCreate.userErrors.some(e => e.message.includes("metafield"))) {
          console.warn(`Non-critical metafield errors for ${setNum} (field may not exist on this theme):`, productCreate.userErrors);
        } else if (criticalErrors.length > 0) {
          const msg = criticalErrors
            .map((e) => e.message)
            .join("; ");
          results.push({
            id: setNum,
            status: "error",
            errorCode: "PRODUCT_CREATE_ERROR",
            message: `Failed to create product: ${msg}`,
          });
          continue;
        }
      }

      const productId = productCreate.product.id;
      const productTitle = productCreate.product.title;
      console.log(`[${setNum}] ✅ Product created: ${productTitle}`);

      // Update the default variant with SKU and inventory settings
      // Shopify automatically creates a default variant when a product is created
      try {
        // First, get the product's variants with inventory item ID
        const productQuery = `
          query getProduct($id: ID!) {
            product(id: $id) {
              variants(first: 1) {
                edges {
                  node {
                    id
                    sku
                    inventoryItem {
                      id
                      tracked
                    }
                  }
                }
              }
            }
          }
        `;

        const productQueryResp = await admin.graphql(productQuery, {
          variables: { id: productId }
        });
        const productQueryJson = await productQueryResp.json();
        
        if (productQueryJson.errors) {
          const errorMsg = productQueryJson.errors[0]?.message || "Unknown error";
          console.error(`[${setNum}] ❌ GraphQL errors fetching variant:`, errorMsg);
          results.push({
            id: setNum,
            status: "error",
            errorCode: "VARIANT_QUERY_ERROR",
            message: `Failed to fetch product variant: ${errorMsg}`,
            shopifyProductId: productId,
          });
          continue;
        }
        
        const variant = productQueryJson.data?.product?.variants?.edges?.[0]?.node;
        const variantId = variant?.id;
        const inventoryItemId = variant?.inventoryItem?.id;
        
        if (!variantId) {
          results.push({
            id: setNum,
            status: "error",
            errorCode: "VARIANT_NOT_FOUND",
            message: "No variant found for the created product",
            shopifyProductId: productId,
          });
          continue;
        }
        
        if (variantId) {
          // Update variant with SKU and inventory tracking via productVariantsBulkUpdate
          const variantUpdateMutation = `
            mutation productVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
              productVariantsBulkUpdate(productId: $productId, variants: $variants) {
                productVariants {
                  id
                  sku
                  inventoryPolicy
                }
                userErrors {
                  field
                  message
                }
              }
            }
          `;

          const variantResp = await admin.graphql(variantUpdateMutation, {
            variables: {
              productId: productId,
              variants: [
                {
                  id: variantId,
                  inventoryPolicy: "DENY", // Don't allow selling when out of stock
                  inventoryPolicy: "DENY"
                }
              ]
            }
          });

          const variantJson = await variantResp.json();
          const variantUpdate = variantJson.data?.productVariantsBulkUpdate;

          if (variantJson.errors) {
            const errorMsg = variantJson.errors[0]?.message || "Unknown error";
            console.error(`[${setNum}] ❌ Variant update error:`, errorMsg);
            // Don't fail the import for variant update errors, but log them
          } else if (variantUpdate?.userErrors?.length > 0) {
            const errorMsg = variantUpdate.userErrors[0]?.message || "Unknown error";
            console.error(`[${setNum}] ❌ Variant update failed:`, errorMsg);
            // Don't fail the import for variant update errors, but log them
          }

          // Set SKU and enable inventory tracking via inventoryItemUpdate
          if (inventoryItemId) {
            // Use inventoryAdjustQuantity mutation to set SKU and tracked
            // First, update the variant's SKU directly via productVariantsBulkUpdate with inventoryItem
            const skuUpdateMutation = `
              mutation productVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
                productVariantsBulkUpdate(productId: $productId, variants: $variants) {
                  productVariants {
                    id
                    sku
                    inventoryItem {
                      id
                      tracked
                    }
                  }
                  userErrors {
                    field
                    message
                  }
                }
              }
            `;

            const skuResp = await admin.graphql(skuUpdateMutation, {
              variables: {
                productId: productId,
                variants: [
                  {
                    id: variantId,
                    inventoryItem: {
                      tracked: true
                    }
                  }
                ]
              }
            });

            const skuJson = await skuResp.json();
            const skuUpdate = skuJson.data?.productVariantsBulkUpdate;
            
            if (skuJson.errors) {
              const errorMsg = skuJson.errors[0]?.message || "Unknown error";
              console.error(`[${setNum}] ❌ Inventory tracking update error:`, errorMsg);
              // Don't fail the import, but note the error
            } else if (skuUpdate?.userErrors?.length > 0) {
              const errorMsg = skuUpdate.userErrors[0]?.message || "Unknown error";
              console.error(`[${setNum}] ❌ Inventory tracking update failed:`, errorMsg);
              // Don't fail the import, but note the error
            } else if (skuUpdate?.productVariants?.[0]) {
              const variant = skuUpdate.productVariants[0];
              const tracked = variant.inventoryItem?.tracked;
              
              // Set SKU using REST API
              if (session?.shop) {
                try {
                  const variantIdNum = variantId.split('/').pop();
                  const restUrl = `https://${session.shop}/admin/api/2025-10/variants/${variantIdNum}.json`;
                  const restResp = await fetch(restUrl, {
                    method: 'PUT',
                    headers: {
                      'X-Shopify-Access-Token': session.accessToken,
                      'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                      variant: {
                        sku: cleanSetNum
                      }
                    })
                  });
                  
                  if (restResp.ok) {
                    const restJson = await restResp.json();
                    const sku = restJson.variant?.sku;
                    if (sku === cleanSetNum && tracked) {
                      console.log(`[${setNum}] ✅ SKU: ${sku}, Inventory tracking: enabled`);
                    } else {
                      if (sku !== cleanSetNum) {
                        console.error(`[${setNum}] ❌ SKU not set. Expected: ${cleanSetNum}, Got: ${sku || 'null'}`);
                        // Note: This is a warning, not a fatal error
                      }
                      if (!tracked) {
                        console.error(`[${setNum}] ❌ Inventory tracking not enabled`);
                        // Note: This is a warning, not a fatal error
                      }
                    }
                  } else {
                    const errorText = await restResp.text();
                    console.error(`[${setNum}] ❌ Failed to set SKU: ${restResp.status} ${errorText}`);
                    // Note: This is a warning, not a fatal error - product was created successfully
                  }
                } catch (err) {
                  console.error(`[${setNum}] ❌ Error setting SKU:`, err.message);
                  // Note: This is a warning, not a fatal error - product was created successfully
                }
              } else {
                console.error(`[${setNum}] ❌ Cannot set SKU: session.shop not available`);
                // Note: This is a warning, not a fatal error - product was created successfully
              }
            }
          }
        }
      } catch (err) {
        console.error(`[${setNum}] ❌ Variant update failed:`, err.message);
        // Continue even if variant update fails - product was created successfully
        // This is a non-fatal error
      }

      // Publish to all available sales channels (but keep as draft)
      // Note: publishablePublish selects channels but product remains draft until manually activated
      if (availableChannels.length > 0) {
        try {
          const publishMutation = `
            mutation publishablePublish($id: ID!, $input: [PublicationInput!]!) {
              publishablePublish(id: $id, input: $input) {
                publishable {
                  ... on Product {
                    id
                    publishedAt
                    status
                  }
                }
                userErrors {
                  field
                  message
                }
              }
            }
          `;

          const publishInput = availableChannels.map(channelId => ({
            publicationId: channelId
          }));


          const publishResp = await admin.graphql(publishMutation, {
            variables: {
              id: productId,
              input: publishInput
            }
          });

          const publishJson = await publishResp.json();
          
          // Check for GraphQL errors
          if (publishJson.errors) {
            const errorMsg = publishJson.errors[0]?.message || "Unknown error";
            console.error(`[${setNum}] ❌ Sales channel publish error:`, errorMsg);
            // Note: This is a warning, not a fatal error - product was created successfully
          }
          
          if (publishJson.data?.publishablePublish?.userErrors?.length > 0) {
            const errorMsg = publishJson.data.publishablePublish.userErrors[0]?.message || "Unknown error";
            console.error(`[${setNum}] ❌ Sales channel publish failed:`, errorMsg);
            // Note: This is a warning, not a fatal error - product was created successfully
          } else if (publishJson.data?.publishablePublish) {
            const publishedProduct = publishJson.data?.publishablePublish?.publishable;
            const status = publishedProduct?.status || "unknown";
            const publishedAt = publishedProduct?.publishedAt;
            console.log(`[${setNum}] ✅ Published to ${availableChannels.length} sales channels`);
          } else {
            console.warn(`[${setNum}] ⚠️ No data returned from publishablePublish`);
          }
        } catch (err) {
          console.error(`[${setNum}] ❌ Failed to publish to sales channels:`, err.message);
          // Continue even if publishing fails - product was created successfully
          // This is a non-fatal error
        }
      } else {
      }

      // Attach all images from Brickset using productCreateMedia
      // Note: Image processing requires stagedUploadsCreate permission which may not be available
      // For now, use original images directly - image processing can be added later with proper permissions
      let attachedCount = 0;
      if (Array.isArray(set.gallery) && set.gallery.length > 0) {
        // Use original images directly (image processing requires additional permissions)
        // TODO: Add image processing when stagedUploadsCreate permission is available
        const imageUrls = set.gallery;

        const mediaInput = imageUrls.map((url, index) => ({
          alt:
            index === 0
              ? title
              : `${title} – image ${index + 1}`,
          mediaContentType: "IMAGE",
          originalSource: url,
        }));

        const mediaMutation = `
          mutation productCreateMedia($media: [CreateMediaInput!]!, $productId: ID!) {
            productCreateMedia(media: $media, productId: $productId) {
              media {
                alt
                mediaContentType
                status
              }
              mediaUserErrors {
                field
                message
              }
              product {
                id
                title
              }
            }
          }
        `;

        const mediaResp = await admin.graphql(mediaMutation, {
          variables: {
            media: mediaInput,
            productId,
          },
        });
        const mediaJson = await mediaResp.json();


        // Check for GraphQL errors
        if (mediaJson.errors) {
          const errorMsg = mediaJson.errors[0]?.message || "Unknown error";
          console.error(`[${setNum}] ❌ Image attachment GraphQL error:`, errorMsg);
          // Note: This is a warning, not a fatal error - product was created successfully
        }

        const mediaErrors =
          mediaJson.data?.productCreateMedia?.mediaUserErrors || [];
        if (mediaErrors.length) {
          const errorMsg = mediaErrors.map(e => e.message).join("; ");
          console.warn(`[${setNum}] ⚠️ Image attachment errors:`, errorMsg);
          // Note: This is a warning, not a fatal error - product was created successfully
        }

        attachedCount =
          mediaJson.data?.productCreateMedia?.media?.length || 0;
      }

      importedCount += 1;

      // IMPORTANT: return the fields your table expects
      results.push({
        id: setNum,
        status: "created",
        errorCode: null, // No error
        message: `${productTitle} (${setNum}) – ${attachedCount} images`,
        shopifyProductTitle: productTitle,
        shopifyProductId: productId,
        imageCount: attachedCount
      });

    } catch (err) {
      console.error(`[${setNum}] ❌ Import failed:`, err?.message || 'Unknown error');

      // Determine error code based on error message
      let errorCode = "UNKNOWN_ERROR";
      const errorMessage = err?.message || "Unknown error";
      
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

      results.push({
        id: setNum,
        status: "error",
        errorCode,
        message: errorMessage,
      });
    }
  }

  return {
    ok: true,
    importedCount,
    totalRequested: ids.length,
    results,
  };
}
