
# 🚀 LEGO Shopify Importer – Brickset Powered

A fully custom **Remix + Shopify GraphQL Admin App** that imports LEGO sets directly from **Brickset**, auto-creates products, uploads full image galleries, assigns metafields, and formats product titles for SEO-ready store listings.

---

## ✨ Key Features

| Feature | Status |
|---|:---:|
| Bulk import LEGO set numbers (CSV or comma separated) | ✔ |
| Brickset login + hash authentication | ✔ |
| Fetch full extended set details | ✔ |
| Gallery import using `getAdditionalImages + setID` | ✔ |
| Shopify `productCreateMedia` multi-image upload | ✔ |
| Auto metafield writing under `brickset.*` namespace | ✔ |
| Custom SEO product title structure | ✔ |
| Progress table + UI import feedback | ✔ |

---

## 🧰 Tech Stack

| Layer | Technology |
|---|---|
| Backend Runtime | Node.js |
| App Framework | Remix |
| Shopify API | GraphQL Admin API |
| Source Data Provider | Brickset API v3 |
| Media Upload | `productCreateMedia` mutation |
| Environment Secrets | `.env` variables |

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
DEFAULT_PRODUCT_TYPE_SET=LEGO Set
```

---

## 🏗 Shopify Metafield Setup

Go to:

```
Shopify Admin → Settings → Custom Data → Products → Add Definition
```

Create these fields:

| Field Label | Namespace.Key | Type |
|---|---|---|
| Set Number | brickset.set_number | Single line text |
| Theme | brickset.theme | Single line text |
| Subtheme | brickset.subtheme | Single line text |
| Pieces | brickset.pieces | Integer |
| Year | brickset.year | Integer |
| Brickset URL | brickset.brickset_url | Single line text |
| Imported At | brickset.imported_at | Single line text |
| Source | brickset.source | Single line text |

---

## 🔥 Product Title Format (Auto-generated)

```
{Set Name} {Set Number} | {Theme} | LEGO
```

Example:

```
Adventure Peely & Cuddle Team Leader 40760-1 | BrickHeadz | LEGO
```

---

## 📥 How to Import LEGO Sets

1. Open app route `/app.import`
2. Paste set numbers like:

```
40632-1, 40760-1, 6315025-1, 40539-1
```

3. Click **Import Sets**
4. The app fetches Brickset → builds product → uploads images → displays results

Output format:

```
40632-1 → Created (5 images)
40539-1 → Created (4 images)
```

---

## 📡 API Workflow Overview

```
Login → get userHash
 ↓
getSets (extendedData) → retrieve set + setID
 ↓
getAdditionalImages(setID) → fetch gallery
 ↓
Shopify createProduct → createMedia → metafields
```

---

## 📂 Project Structure

```
/app
 ├─ lib/
 │   ├─ brickset.server.js   ← Brickset fetch logic
 │   ├─ import-products.server.js ← Shopify integration
 │
 ├─ routes/
 │   ├─ app.import.jsx       ← UI Import screen
 │   ├─ app._index.jsx       ← UI Dashboard
 │
.env.example
README.md
```

---

## 📝 To‑Do Roadmap

| Next Feature | Status |
|---|:---:|
| Price auto-fetch from secondary API | ⏳ |
| Dashboard history of imported sets | ⏳ |
| Image alt text SEO automation | ⏳ |
| Scheduled daily auto‑sync | 🔥 future |

---

## 🤝 Contributions

PRs are always welcome.  
Keep code formatted, commented clearly, and adhere to Shopify API rate limits.

---

## 📄 License

MIT — use, modify, extend freely.

---

