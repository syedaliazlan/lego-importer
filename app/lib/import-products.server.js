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
  console.log("DEBUG importSets(): starting with ids:", ids);

  const { admin } = await auth;
  console.log("DEBUG importSets(): admin exists?", !!admin);

  const results = [];
  let importedCount = 0;

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
      console.log(`Found ${channelIds.length} sales channels/publications`);
      return channelIds;
    } catch (err) {
      console.warn("Could not fetch sales channels, continuing without them:", err);
      return [];
    }
  }

  // Get all available sales channels once
  const availableChannels = await getAvailableChannels(admin);

  for (const rawId of ids) {
    const setNum = String(rawId || "").trim();
    if (!setNum) {
      results.push({
        id: rawId,
        status: "error",
        message: "Empty or invalid set number",
      });
      continue;
    }

    try {
      console.log("DEBUG importSets(): fetching Brickset data for:", setNum);

      const set = await fetchSet(setNum, env);

      console.log("DEBUG fetched Brickset set:", set);

      // Use clean set number (without -1) for title
      const cleanSetNum = set.set_num_clean || set.set_num.replace(/-1$/, '');
      
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
        status: "DRAFT",
        tags,
        metafields,
      };

      console.log(
        "DEBUG productInput (Brickset):",
        JSON.stringify(productInput, null, 2),
      );

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

      console.log(
        "DEBUG GraphQL productCreate response:",
        JSON.stringify(createJson, null, 2),
      );

      const productCreate = createJson.data?.productCreate;
      if (!productCreate) {
        throw new Error("No productCreate payload returned from Shopify");
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
          results.push({ id: setNum, status: "error", message: msg });
          continue;
        }
      }

      const productId = productCreate.product.id;
      const productTitle = productCreate.product.title;

      // Update the default variant with SKU and inventory settings
      // Shopify automatically creates a default variant when a product is created
      console.log(`\n========== [${setNum}] Starting variant update for product ${productId} ==========`);
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

        console.log(`[${setNum}] Querying product variants...`);
        const productQueryResp = await admin.graphql(productQuery, {
          variables: { id: productId }
        });
        const productQueryJson = await productQueryResp.json();
        
        // Check for GraphQL errors
        if (productQueryJson.errors) {
          console.error(`[${setNum}] ❌ GraphQL errors in product query:`, JSON.stringify(productQueryJson.errors, null, 2));
        }
        
        console.log(`[${setNum}] Product query response:`, JSON.stringify(productQueryJson, null, 2));
        
        const variant = productQueryJson.data?.product?.variants?.edges?.[0]?.node;
        const variantId = variant?.id;
        const inventoryItemId = variant?.inventoryItem?.id;
        
        console.log(`[${setNum}] Variant ID: ${variantId}, Inventory Item ID: ${inventoryItemId}`);

        if (variantId) {
          // Step 1: Update the variant with SKU and inventory policy
          // Use productVariantUpdate for single variant (more reliable than bulk update)
          console.log(`[${setNum}] Updating variant ${variantId} with SKU: ${cleanSetNum}`);
          const variantUpdateMutation = `
            mutation productVariantUpdate($input: ProductVariantInput!) {
              productVariantUpdate(input: $input) {
                productVariant {
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
              input: {
                id: variantId,
                sku: cleanSetNum, // Set SKU to clean set number (without -1)
                inventoryPolicy: "DENY", // Don't allow selling when out of stock
              }
            }
          });

          const variantJson = await variantResp.json();
          
          // Check for GraphQL errors
          if (variantJson.errors) {
            console.error(`[${setNum}] ❌ GraphQL errors in variant update:`, JSON.stringify(variantJson.errors, null, 2));
          }
          
          console.log(`[${setNum}] Variant update response:`, JSON.stringify(variantJson, null, 2));
          const variantUpdate = variantJson.data?.productVariantUpdate;

          if (variantUpdate?.userErrors?.length > 0) {
            console.warn(`[${setNum}] Variant update userErrors:`, variantUpdate.userErrors);
          } else if (variantUpdate?.productVariant) {
            const updatedSku = variantUpdate.productVariant.sku;
            console.log(`[${setNum}] ✅ Variant updated successfully. SKU set to: ${updatedSku}`);
          } else {
            console.warn(`[${setNum}] ⚠️ No productVariant in response`);
          }

          // Step 2: Enable inventory tracking using inventoryItemUpdate
          if (inventoryItemId) {
            console.log(`[${setNum}] Enabling inventory tracking for inventory item ${inventoryItemId}`);
            const inventoryUpdateMutation = `
              mutation inventoryItemUpdate($input: InventoryItemUpdateInput!) {
                inventoryItemUpdate(input: $input) {
                  inventoryItem {
                    id
                    tracked
                  }
                  userErrors {
                    field
                    message
                  }
                }
              }
            `;

            const inventoryResp = await admin.graphql(inventoryUpdateMutation, {
              variables: {
                input: {
                  id: inventoryItemId,
                  tracked: true
                }
              }
            });

            const inventoryJson = await inventoryResp.json();
            
            // Check for GraphQL errors
            if (inventoryJson.errors) {
              console.error(`[${setNum}] ❌ GraphQL errors in inventory update:`, JSON.stringify(inventoryJson.errors, null, 2));
            }
            
            console.log(`[${setNum}] Inventory update response:`, JSON.stringify(inventoryJson, null, 2));
            const inventoryUpdate = inventoryJson.data?.inventoryItemUpdate;

            if (inventoryUpdate?.userErrors?.length > 0) {
              console.warn(`[${setNum}] Inventory tracking enable errors:`, inventoryUpdate.userErrors);
            } else {
              const tracked = inventoryUpdate?.inventoryItem?.tracked;
              console.log(`[${setNum}] ✅ Inventory tracking enabled. Tracked: ${tracked}`);
            }
          } else {
            console.warn(`[${setNum}] ⚠️ No inventory item ID found to enable tracking`);
          }
        } else {
          console.error(`[${setNum}] ❌ ERROR: No variant found to update for product ${productId}`);
        }
      } catch (err) {
        console.error(`[${setNum}] ❌ ERROR: Failed to update variant:`, err);
        console.error(`[${setNum}] Error stack:`, err?.stack);
        // Continue even if variant update fails
      }
      console.log(`========== [${setNum}] Finished variant update ==========\n`);

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

          console.log(`Attempting to publish product to ${availableChannels.length} sales channels...`);

          const publishResp = await admin.graphql(publishMutation, {
            variables: {
              id: productId,
              input: publishInput
            }
          });

          const publishJson = await publishResp.json();
          
          // Check for GraphQL errors
          if (publishJson.errors) {
            console.error(`[${setNum}] ❌ GraphQL errors in sales channel publish:`, JSON.stringify(publishJson.errors, null, 2));
          }
          
          if (publishJson.data?.publishablePublish?.userErrors?.length > 0) {
            console.warn(`[${setNum}] Sales channel publishing userErrors:`, JSON.stringify(publishJson.data.publishablePublish.userErrors, null, 2));
          } else if (publishJson.data?.publishablePublish) {
            const publishedProduct = publishJson.data?.publishablePublish?.publishable;
            const status = publishedProduct?.status || "unknown";
            const publishedAt = publishedProduct?.publishedAt;
            console.log(`[${setNum}] ✅ Product published to ${availableChannels.length} sales channels. Status: ${status}, PublishedAt: ${publishedAt || "null (draft)"}`);
          } else {
            console.warn(`[${setNum}] ⚠️ No data returned from publishablePublish`);
          }
        } catch (err) {
          console.warn("Failed to publish to sales channels:", err);
          console.warn("Error details:", err.message, err.stack);
          // Continue even if publishing fails
        }
      } else {
        console.warn("No sales channels found to publish to");
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

        console.log(
          "DEBUG GraphQL productCreateMedia response:",
          JSON.stringify(mediaJson, null, 2),
        );

        const mediaErrors =
          mediaJson.data?.productCreateMedia?.mediaUserErrors || [];
        if (mediaErrors.length) {
          console.warn(
            "MediaUserErrors while attaching Brickset images:",
            mediaErrors,
          );
        }

        attachedCount =
          mediaJson.data?.productCreateMedia?.media?.length || 0;
      }

      importedCount += 1;

      // IMPORTANT: return the fields your table expects
      results.push({
      id: setNum,
      status: "created",
      message: `${productTitle} (${setNum}) – ${attachedCount} images`,
      shopifyProductTitle: productTitle,
      shopifyProductId: productId,
      imageCount: attachedCount
    });

    } catch (err) {
      console.error(
        `Error importing set ${setNum}:`,
        err?.stack || err?.message || err,
      );

      results.push({
        id: setNum,
        status: "error",
        message: err?.message || "Unknown error",
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
