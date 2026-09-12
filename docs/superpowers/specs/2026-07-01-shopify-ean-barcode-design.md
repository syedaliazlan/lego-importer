# Shopify EAN Barcode — Design

**Date:** 2026-07-01
**Author:** Ali (Devonic) for Retired Sets / National Brick Events (Joe, Nick)
**Status:** Approved to build

> **Superseded 2026-09-12.** Joe asked (2026-09-05) for every available barcode to be written so the till scans UPC boxes too. The importer and backfill now write EAN and UPC as typed barcodes on Admin API 2026-10 and the backfill is a merge rather than fill-only. The "EAN only, no UPC fallback" decision in section 3 no longer applies; UPC is written as its own typed row, never as a substitute for a missing EAN.

## 1. Background & goal

Retired Sets is moving to Shopify POS (Aylesbury first, as a POS Pro test). For staff to scan a boxed LEGO set at the till, the set's **EAN barcode** must live in the Shopify variant `barcode` field (POS scans that field, not a metafield). Brickset already carries the EAN for each set in its API. The importer currently creates products with SKU, metafields, images and inventory tracking, but **never fetches or stores the EAN**.

Two agreed deliverables (top of the list in the Joe email thread):

1. **Backfill** — sweep the existing Shopify catalogue, pull the EAN from Brickset for each product, and write it into the variant `barcode`. Produce a list of sets where Brickset has no EAN so Ali can flag them to Joe.
2. **New imports carry the barcode** — every new import fetches the EAN and attaches it to the variant.

### Confirmed decision (Joe, WhatsApp 2026-07-01)

New imports **stay `DRAFT`** (unchanged). Joe wants staff to set stock/price and review before a product goes live; activation is a manual step and is the moment the product becomes POS-scannable (drafts are invisible to POS). So item 2 is purely "attach the barcode" — **no status or sales-channel change**.

## 2. Scope

**In scope**
- Extract `barcode.EAN` from Brickset in `fetchSet()`.
- Attach the EAN to the variant `barcode` on every new import (status stays DRAFT).
- A backfill tool (in-app page) that fills empty barcodes on existing products by matching SKU → Brickset set, with a preview mode and a report of sets with no EAN / not found.

**Out of scope (deferred until Aylesbury POS Pro is live)**
- Multi-location inventory, stock receiving, transfers, "warehouse/website = default location", auto-activating to POS when shop stock is added. These need `read_locations`/`write_locations` scopes we do not currently hold. Joe's preferences are captured for that phase but nothing here builds toward it.
- Flipping new imports to Active / POS-only publishing (explicitly rejected by Joe in favour of draft-first).

## 3. Verified facts

**Brickset API v3** (`getSets`)
- Barcode lives at `set.barcode.EAN` and `set.barcode.UPC` (both String, can be empty). Top-level on the set object, not gated behind `extendedData`.
- `setNumber` accepts a **comma-delimited list**; `pageSize` max **500**. One call resolves up to 500 sets. Response `sets[]` each carry `number` + `numberVariant`, so we rebuild the clean-number → EAN map from the response regardless of input order.
- Only `getSets` counts against the key's daily usage. Log in once, reuse `userHash` for the whole run.

**Shopify Admin GraphQL** (2025-07 verified)
- `ProductVariantsBulkInput` has a `barcode` (String) field → set via `productVariantsBulkUpdate(productId, variants:[{id, barcode}])`.
- `productVariants(first, after)` cursor pagination exposes `sku` and `barcode` per node → used to scan the catalogue.
- Current app scopes (`write_products, write_inventory, write_publications`) are sufficient. **No scope change needed.**

**Decision — EAN only, no UPC fallback.** UK/EU boxes print EAN-13; the US UPC will not match the physical box, so a silent UPC fallback would write a barcode that never scans. If EAN is missing we report it rather than substitute UPC.

## 4. Item 2 — New imports carry the barcode

### 4.1 `app/lib/brickset.server.js`
`fetchSet()` return object gains:
```js
ean: (s.barcode?.EAN || "").trim(),
upc: (s.barcode?.UPC || "").trim(),  // captured for completeness; not written to Shopify
```

### 4.2 `app/lib/import-products.server.js`
In the existing variant update (`productVariantsBulkUpdate`), add the barcode when present:
```js
variants: [{ id: variantId, barcode: set.ean || null, inventoryPolicy: "DENY" }]
```
(Also removes the duplicated `inventoryPolicy` key currently in that call.) Status stays `DRAFT`; publish logic unchanged. If `set.ean` is empty, the field is left blank and the set is noted in the per-row result message ("no EAN in Brickset") so it surfaces in the results table.

## 5. Item 1 — Backfill

### 5.1 Data flow (per chunk)
1. Query one page of variants via `productVariants(first: N, after: cursor)` → `{ id, sku, barcode, product { id, title } }`.
2. Select variants where `sku` looks like a LEGO set number **and** `barcode` is empty (fill-only; idempotent). Normalise `sku` → Brickset set number: strip any trailing `-<n>`, append `-1`.
3. One Brickset `getSets` call for the page's set numbers (comma-delimited, `pageSize: 500`). Build `cleanNumber → EAN` map.
4. For each selected variant:
   - EAN found & non-empty → `productVariantsBulkUpdate` to set `barcode`. → **filled**
   - Set found but EAN empty → **missingEan** (report).
   - Set not found on Brickset → **notFound** (report).
   - SKU empty / non-numeric → **skipped** (report).
5. Return `{ processed, filled, missingEan[], notFound[], skipped, errors[], nextCursor, done }`.

Chunking keeps every request short (well under Render's timeout) and gives live progress. Page size ~50 variants → one Brickset call + ≤50 writes per request (~a few seconds each).

### 5.2 Preview vs commit
`mode` param: `"preview"` runs steps 1–4 but **skips the write**, returning the same report (counts + missing/notFound lists). `"commit"` performs the writes. Ali runs preview first to get the "no EAN" list for Joe and to sanity-check match rates before committing.

### 5.3 Files
- **`app/lib/backfill-barcodes.server.js`** — `backfillChunk(admin, env, { cursor, pageSize, mode })`. Pure orchestration: paginate, match, batch-fetch, write. Exposes a Brickset batch helper `fetchEansForSetNumbers(setNumbers, env)` (login once, comma-delimited getSets).
- **`app/routes/app.backfill.jsx`** — `action` receives `{ cursor, mode }`, calls `backfillChunk`, returns JSON. Default export renders the Backfill page.
- **`app/routes/app.jsx`** — add a nav link to the Backfill page (match existing App Bridge nav).

### 5.4 UI (Backfill page)
- Short explanation + **Preview** and **Run backfill** buttons (mode = preview/commit).
- Client loops: calls the action with the returned `nextCursor` until `done`, accumulating totals. Progress bar shows `processed` and a running tally: filled / missing EAN / not found / skipped / errors.
- Results: summary counts + a copyable list of **set numbers with no EAN** and **not found on Brickset** (for flagging to Joe). Downloadable as plain text.
- A "stop" affordance to halt the loop between chunks.

## 6. Edge cases
- **Brickset login/API failure mid-run:** a chunk fails → return the error for that chunk; the client can retry the same cursor. `userHash` is fetched per chunk (stateless server) but Brickset use is tiny (1 getSets/chunk).
- **Shopify throttling (429/THROTTLED):** write helper retries with backoff; on repeated failure the variant is recorded in `errors[]` and the run continues.
- **Variant already has a barcode:** skipped (fill-only). A future "overwrite" toggle is possible but not built (YAGNI).
- **SKU with a non-`-1` variant / non-numeric SKU:** normalised best-effort; unresolved ones land in `notFound`/`skipped` and are reported, never guessed.
- **EAN present but malformed (e.g. "0"/blank):** treated as missing.

## 7. Testing / verification
- **Unit-testable pure functions** (no Shopify/Brickset calls): `normaliseSkuToSetNumber(sku)`, `buildEanMap(bricksetSets)`, `classifyVariant(variant, eanMap)`. Cover: clean number, trailing `-1`/`-2`, non-numeric, empty EAN, missing set, already-has-barcode.
- **Manual E2E** on the dev store: import one set (e.g. `10236-1`) → confirm variant barcode populated, status DRAFT. Run backfill preview → confirm counts and missing list. Run commit on a small page → confirm barcodes written and idempotent on re-run.
- Brickset `getSets` batch shape verified against a couple of known EAN sets before the full run.

## 8. Implementation checklist
1. `brickset.server.js`: add `ean`/`upc` to `fetchSet()` return.
2. `import-products.server.js`: set `barcode` in the variant bulk update; fix duplicate `inventoryPolicy`; surface "no EAN" in the row result.
3. `backfill-barcodes.server.js`: pure helpers + `backfillChunk` + Brickset batch fetch.
4. `app.backfill.jsx`: action + Backfill page UI with preview/commit and chunk loop.
5. `app.jsx`: nav link.
6. Tests for the pure helpers.
7. Manual E2E on dev store; run preview; hand Joe the "no EAN" list.
```
