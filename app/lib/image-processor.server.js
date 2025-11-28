// app/lib/image-processor.server.js
// Utility to process images to 1:1 ratio with white space padding

import sharp from 'sharp';

/**
 * Process an image from URL to 1:1 ratio with white padding
 * @param {string} imageUrl - URL of the image to process
 * @returns {Promise<Buffer>} - Processed image buffer
 */
export async function processImageToSquare(imageUrl) {
  try {
    // Fetch the image
    const response = await fetch(imageUrl);
    if (!response.ok) {
      throw new Error(`Failed to fetch image: ${response.statusText}`);
    }

    const imageBuffer = Buffer.from(await response.arrayBuffer());

    // Get image metadata
    const metadata = await sharp(imageBuffer).metadata();
    const { width, height } = metadata;

    // Calculate dimensions for 1:1 ratio
    const size = Math.max(width, height);

    // Create a square image with white background and center the original image
    const processedImage = await sharp({
      create: {
        width: size,
        height: size,
        channels: 3,
        background: { r: 255, g: 255, b: 255 } // White background
      }
    })
      .composite([
        {
          input: imageBuffer,
          top: Math.round((size - height) / 2),
          left: Math.round((size - width) / 2)
        }
      ])
      .jpeg({ quality: 90 })
      .toBuffer();

    return processedImage;
  } catch (error) {
    console.error(`Error processing image ${imageUrl}:`, error);
    // Return original image buffer if processing fails
    const response = await fetch(imageUrl);
    return Buffer.from(await response.arrayBuffer());
  }
}

/**
 * Upload processed image to Shopify using staged uploads and return the URL
 * @param {Buffer} imageBuffer - Processed image buffer
 * @param {Object} admin - Shopify admin GraphQL client
 * @param {string} filename - Filename for the uploaded image
 * @returns {Promise<string>} - URL of the uploaded image
 */
export async function uploadImageToShopify(imageBuffer, admin, filename = 'processed-image.jpg') {
  try {
    // Step 1: Create staged upload target
    const stagedUploadsCreateMutation = `
      mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
        stagedUploadsCreate(input: $input) {
          stagedTargets {
            url
            resourceUrl
            parameters {
              name
              value
            }
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

    const stagedResp = await admin.graphql(stagedUploadsCreateMutation, {
      variables: {
        input: [
          {
            resource: 'FILE',
            filename: filename,
            mimeType: 'image/jpeg',
            fileSize: imageBuffer.length.toString()
          }
        ]
      }
    });

    const stagedJson = await stagedResp.json();
    const stagedTarget = stagedJson.data?.stagedUploadsCreate?.stagedTargets?.[0];

    if (!stagedTarget) {
      throw new Error('Failed to create staged upload target');
    }

    // Step 2: Upload file to the staged target URL
    // Construct multipart form data manually for Node.js compatibility
    const boundary = `----WebKitFormBoundary${Math.random().toString(36).substring(2, 15)}`;
    const formParts = [];
    
    // Add parameters
    stagedTarget.parameters.forEach(param => {
      formParts.push(`--${boundary}\r\n`);
      formParts.push(`Content-Disposition: form-data; name="${param.name}"\r\n\r\n`);
      formParts.push(`${param.value}\r\n`);
    });
    
    // Add file
    formParts.push(`--${boundary}\r\n`);
    formParts.push(`Content-Disposition: form-data; name="file"; filename="${filename}"\r\n`);
    formParts.push(`Content-Type: image/jpeg\r\n\r\n`);
    
    const formDataBuffer = Buffer.concat([
      Buffer.from(formParts.join('')),
      imageBuffer,
      Buffer.from(`\r\n--${boundary}--\r\n`)
    ]);

    const uploadResp = await fetch(stagedTarget.url, {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': formDataBuffer.length.toString()
      },
      body: formDataBuffer
    });

    if (!uploadResp.ok) {
      throw new Error(`Failed to upload file: ${uploadResp.statusText}`);
    }

    // Step 3: Create file from staged upload
    const fileCreateMutation = `
      mutation fileCreate($files: [FileCreateInput!]!) {
        fileCreate(files: $files) {
          files {
            id
            fileStatus
            ... on MediaImage {
              image {
                url
              }
            }
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

    const fileCreateResp = await admin.graphql(fileCreateMutation, {
      variables: {
        files: [
          {
            originalSource: stagedTarget.resourceUrl,
            filename: filename,
            contentType: 'IMAGE'
          }
        ]
      }
    });

    const fileCreateJson = await fileCreateResp.json();
    const fileCreate = fileCreateJson.data?.fileCreate;

    if (fileCreate?.userErrors?.length > 0) {
      throw new Error(`File create errors: ${JSON.stringify(fileCreate.userErrors)}`);
    }

    const file = fileCreate?.files?.[0];
    if (file?.image?.url) {
      return file.image.url;
    }

    throw new Error('Failed to get uploaded image URL');
  } catch (error) {
    console.error('Error uploading image to Shopify:', error);
    throw error;
  }
}

