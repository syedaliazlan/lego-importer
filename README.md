# 🚀 LEGO Shopify Importer – Brickset Powered

A fully custom **Remix + Shopify GraphQL Admin App** that imports LEGO sets directly from **Brickset**, auto-creates draft products with complete metadata, uploads full image galleries, and configures all product settings automatically.

---

## ✨ Key Features

| Feature | Status |
|---|:---:|
| Bulk import LEGO set numbers (CSV or comma separated) | ✔ |
| **Duplicate product detection** - Automatically skips existing products | ✔ |
| **Structured error codes** - Clear error messages with error codes | ✔ |
| Brickset login + hash authentication | ✔ |
| Fetch full extended set details | ✔ |
| Gallery import using `getAdditionalImages + setID` | ✔ |
| Shopify `productCreateMedia` multi-image upload | ✔ |
| Auto metafield writing under `brickset.*` and `custom.*` namespaces | ✔ |
| Custom SEO product title structure | ✔ |
| **Automatic SKU assignment** (set number without -1 suffix) | ✔ |
| **Inventory tracking enabled** by default | ✔ |
| **Sales channels automatically selected** | ✔ |
| **Product category set** to "Construction Set Toys" | ✔ |
| **Vendor set** to theme/brand (e.g., "Harry Potter", "Star Wars") | ✔ |
| **Product type** set to "Sets" | ✔ |
| **Barcodes from Brickset** written with their type (EAN and UPC), plus an in-app backfill for existing products (Admin API 2026-10) | ✔ |
| Progress table + UI import feedback | ✔ |

---

## 🧰 Tech Stack

| Layer | Technology |
|---|---|
| Backend Runtime | Node.js |
| App Framework | Remix |
| Shopify API | GraphQL Admin API + REST API |
| Source Data Provider | Brickset API v3 |
| Media Upload | `productCreateMedia` mutation |
| Environment Secrets | `.env` variables |
| Database | Prisma + PostgreSQL (for session storage) |

---

## 🔧 Installation & Local Setup

```bash
git clone <your-repo-url>
cd lego-importer
npm install
npm run dev
```

---

## 🔐 Required `.env` Variables

```env
BRICKSET_API_KEY=xxxxx
BRICKSET_USERNAME=xxxxx
BRICKSET_PASSWORD=xxxxx

DEFAULT_VENDOR=LEGO
```

---

## Shopify Metafield Setup

Go to:

```
Shopify Admin → Settings → Custom Data → Products → Add Definition
```

Create these metafield definitions:

| Field Label | Namespace.Key | Type |
|---|---|---|
| Set Number | `brickset.set_number` | Single line text |
| Theme | `brickset.theme` | Single line text |
| Subtheme | `brickset.subtheme` | Single line text |
| Year | `brickset.year` | Integer |
| Pieces | `brickset.pieces` | Single line text |
| Brickset URL | `brickset.brickset_url` | Single line text |
| Source | `brickset.source` | Single line text |
| Imported At | `brickset.imported_at` | Date & time |
| Year Released | `custom.year_released` | Integer (optional, for live site) |

---

## Product Configuration (Auto-applied)

### Product Title Format
```
{Set Name} {Set Number} | {Theme} | LEGO
```

**Example:**
```
Adventure Peely & Cuddle Team Leader 40760 | BrickHeadz | LEGO
```

**Note:** Set numbers in titles exclude the "-1" suffix (e.g., `40760` instead of `40760-1`)

### Automatic Product Settings

- **Status:** Draft (ready for review before publishing)
- **Product Type:** "Sets"
- **Vendor:** Theme/Brand (e.g., "Harry Potter", "Star Wars", "LEGO")
- **Category:** "Construction Set Toys" (Shopify Standard Product Taxonomy)
- **SKU:** Set number without "-1" suffix (e.g., `40760` for set `40760-1`)
- **Inventory Tracking:** Enabled
- **Inventory Policy:** Deny (don't allow selling when out of stock)
- **Sales Channels:** All available channels automatically selected
- **Tags:** `brickset-imported`, `year:{year}`
- **Barcodes:** every barcode Brickset has for the set, each with its type: EAN (UK and EU boxes) and UPC (North American boxes). A variant can hold up to 20 typed barcodes on Admin API 2026-10. The **Backfill barcodes** page merges the same into existing products: what is already on a product is kept, only missing barcodes are added, and an untyped barcode that matches Brickset gains its type.

---

## 📥 How to Import LEGO Sets

1. Open app route `/app.import`
2. Paste set numbers (with or without `-1` suffix):
   ```
   40632-1, 40760-1, 6315025-1, 40539-1
   ```
   or
   ```
   40632, 40760, 6315025, 40539
   ```

3. Click **Import Sets**
4. The app will:
   - Check for duplicate products (skip if exists)
   - Fetch data from Brickset
   - Create draft product in Shopify
   - Set SKU, inventory tracking, and sales channels
   - Upload all available images
   - Display results with status

### Output Format

**Success:**
```
40760-1 → Created (5 images)
40539-1 → Created (4 images)
```

**Duplicate (Skipped):**
```
40760-1 → Skipped (Product already exists: "Adventure Peely..." (DRAFT))
```

**Error:**
```
40632-1 → Error: Failed to fetch set data from Brickset: Set not found
```

---

## 🚨 Error Codes & Handling

The app provides structured error codes for easy troubleshooting:

| Error Code | Description |
|---|---|
| `DUPLICATE_SKU` | Product already exists with this SKU (any status) |
| `INVALID_SET_NUMBER` | Empty or invalid set number provided |
| `BRICKSET_FETCH_ERROR` | Failed to fetch data from Brickset API |
| `PRODUCT_CREATE_ERROR` | Failed to create product in Shopify |
| `VARIANT_QUERY_ERROR` | Failed to query product variant |
| `VARIANT_NOT_FOUND` | No variant found for created product |
| `VARIANT_UPDATE_ERROR` | Failed to update variant (non-fatal) |
| `SKU_SET_ERROR` | Failed to set SKU (non-fatal) |
| `INVENTORY_ERROR` | Failed to enable inventory tracking (non-fatal) |
| `SALES_CHANNEL_ERROR` | Failed to publish to sales channels (non-fatal) |
| `IMAGE_ERROR` | Failed to attach images (non-fatal) |
| `UNKNOWN_ERROR` | Unknown/unexpected error |

**Note:** Some errors (variant updates, SKU setting, inventory, sales channels, images) are non-fatal - the product is created successfully, but these operations may have failed. Check logs for details.

### Error Response Format

```json
{
  "id": "40760-1",
  "status": "error" | "skipped" | "created",
  "errorCode": "DUPLICATE_SKU",
  "message": "Product already exists with SKU \"40760\": \"Adventure Peely...\" (Status: DRAFT)",
  "existingProductId": "gid://shopify/Product/123456",
  "existingProductTitle": "Adventure Peely & Cuddle Team Leader 40760",
  "existingProductStatus": "DRAFT"
}
```

---

## 🔄 Duplicate Detection

The app automatically checks if a product with the same SKU already exists before importing. This prevents duplicate products and allows you to import large lists without manual checking.

- **Checks by SKU:** Uses the clean set number (without `-1` suffix)
- **Checks all statuses:** Draft, Active, Archived - all are detected
- **Clear feedback:** Shows existing product title and status when skipped

---

## 📡 API Workflow Overview

```
1. Check for duplicate product (by SKU)
   ↓
2. Login to Brickset → get userHash
   ↓
3. getSets (extendedData) → retrieve set + setID
   ↓
4. getAdditionalImages(setID) → fetch gallery
   ↓
5. Shopify productCreate → create draft product
   ↓
6. Update variant → set SKU, enable inventory tracking
   ↓
7. Publish to sales channels → select all available channels
   ↓
8. productCreateMedia → upload all images
```

---

## 📂 Project Structure

```
/app
 ├─ lib/
 │   ├─ brickset.server.js          ← Brickset API integration
 │   ├─ import-products.server.js   ← Shopify product creation & configuration
 │   ├─ image-processor.server.js   ← Image processing utilities
 │
 ├─ routes/
 │   ├─ app.import.jsx               ← Import UI screen
 │   ├─ app._index.jsx               ← Dashboard
 │
 ├─ shopify.server.js                ← Shopify authentication
 └─ shopify.app.toml                 ← App configuration

.env.example
README.md
```

---

## 🔑 Required Shopify App Scopes

The app requires the following scopes (configured in `shopify.app.toml`):

- `write_products` - Create and update products
- `write_inventory` - Enable inventory tracking, set SKU, and stock every new product at every active location at zero (inventoryBulkToggleActivation)
- `write_publications` - Publish products to sales channels

---

## 📝 To‑Do Roadmap

| Next Feature | Status |
|---|:---:|
| Image processing to 1:1 aspect ratio | ⏳ (requires additional permissions) |
| Price auto-fetch from secondary API | ⏳ |
| Dashboard history of imported sets | ⏳ |
| Image alt text SEO automation | ⏳ |

---

## 🤝 Contributions

PRs are always welcome.  
Keep code formatted, commented clearly, and adhere to Shopify API rate limits.

---

## 📄 License

MIT — use, modify, extend freely.

---
