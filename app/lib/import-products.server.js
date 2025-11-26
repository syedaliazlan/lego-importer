// app/lib/import-products.server.js

import { fetchSet } from "./brickset.server.js";

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

      const title = [
      `${set.name} ${set.set_num}`,
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
        {
          namespace: "brickset",
          key: "year",
          type: "number_integer",   
          value: set.year ? String(set.year) : null
        },
        {
          namespace: "brickset",
          key: "pieces",
          type: "number_integer",    
          value: set.pieces ? String(set.pieces) : null
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
          type: "single_line_text_field",
          value: new Date().toISOString(),
        },
      ];

      const tags = ["brickset-imported"];
      if (set.theme) tags.push(set.theme);
      if (set.year) tags.push(`year:${set.year}`);

      // Basic product (no media yet)
      const productInput = {
        title,
        descriptionHtml,
        vendor: env.DEFAULT_VENDOR || "LEGO",
        productType: env.DEFAULT_PRODUCT_TYPE_SET || "LEGO Set",
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
        const msg = productCreate.userErrors
          .map((e) => e.message)
          .join("; ");
        results.push({ id: setNum, status: "error", message: msg });
        continue;
      }

      const productId = productCreate.product.id;
      const productTitle = productCreate.product.title;

      // Attach all images from Brickset using productCreateMedia
      let attachedCount = 0;
      if (Array.isArray(set.gallery) && set.gallery.length > 0) {
        const mediaInput = set.gallery.map((url, index) => ({
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
