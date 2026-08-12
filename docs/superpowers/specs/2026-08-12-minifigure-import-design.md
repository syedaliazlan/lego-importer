# Minifigure import design

Date: 2026-08-12
Status: approved, in build

## Problem

The importer only creates products for LEGO sets. The shop wants to bulk upload
individual minifigures the same way, so the team can list a large collection
without building each product by hand.

Existing minifigure listings on the storefront follow this pattern:

```
Obi-Wan Kenobi-Large Eyes SW0197 | Star Wars Minifigure | LEGO
```

They are identified by BrickLink catalogue IDs (`SW0197`, `SW0844`), not by LEGO
set numbers, so the existing `getSets` path cannot resolve them.

## Data source

Brickset's `getMinifigCollection` operation is the source. Despite the name it
returns catalogue data for any minifigure, including ones the account does not
own, when called with a `query` parameter.

```
params: {"query":"sw0197"}
-> {"minifigNumber":"sw0197",
    "name":"Obi-Wan Kenobi - Clone Wars, Large Eyes",
    "category":"Star Wars / Star Wars The Clone Wars",
    "ownedInSets":0,"ownedLoose":0,"ownedTotal":0,"wanted":false}
```

Verified against `sw`, `hp`, `col`, `njo`, `cty` and `sh` prefixes. All resolved.
Unknown IDs return `matches: 0`, which gives a clean not-found signal.

Two properties of the operation shape the implementation:

1. `query` does not accept a comma separated list. Passing `sw0197,sw0308`
   returns zero matches.
2. `query` prefix matches. `sw019` returns `sw0190` through `sw0199` in one call.

Point 2 is the batching strategy. Point 1 is why a fallback is still needed.

Brickset hosts no minifigure images (404 on `images.brickset.com/minifigs/...`),
so images come from BrickLink's public CDN at
`https://img.bricklink.com/ItemImage/MN/0/{id}.png`. Shopify copies the image
onto its own CDN during import, so there is no ongoing hotlink.

### Sources considered and rejected

- **BrickLink API.** Exact ID match and richer data, but requires a BrickLink
  seller account and four OAuth credentials the shop would have to generate.
  Blocks same day delivery. Remains the upgrade path if Brickset coverage gaps
  appear.
- **BrickLink catalogue page parsing.** Works and returns the same names, but is
  unofficial and breaks on any markup change. Unnecessary now that the official
  API covers it.
- **Rebrickable.** Keys minifigures by `fig-000123` with no BrickLink ID mapping
  exposed through the API, so IDs cannot be resolved.

## Product mapping

| Field | Value |
| --- | --- |
| Title | `{name} {ID} \| {Theme} Minifigure \| LEGO` |
| SKU | uppercase ID, `SW0197` |
| Barcode | uppercase ID, `SW0197` |
| Vendor | theme, `Star Wars` |
| Product type | `Minifigures` |
| Category | Action Figures, `gid://shopify/TaxonomyCategory/tg-5-8-1-1` |
| Status | `DRAFT` |
| Inventory | tracked, policy `DENY` |
| Tags | `brickset-imported`, `minifigure` |
| Metafields | `brickset.minifig_number`, `.theme`, `.subtheme`, `.source`, `.imported_at` |
| Media | BrickLink CDN PNG, HEAD checked before attaching |
| Channels | published to all, same as sets |

Theme and subtheme reuse the existing `brickset` metafield namespace rather than
a new `bricklink` one. Those keys already have definitions on the shop, so the
values render properly in admin and any storefront filter reading them picks
minifigures up without further work.

Two title rules come out of the real catalogue data:

- Themes that already end in "Minifigures" are not suffixed again, so `col001`
  reads `... COL001 | Collectible Minifigures | LEGO`.
- Shopify caps titles at 255 characters and a few catalogue names are long
  enough to breach it (`sw0199` is 130 characters on its own). The name is
  trimmed to fit, never the number or theme, since those are what staff search
  on.

Minifigures have no EAN, so the barcode field carries the minifigure ID instead.
Shopify POS scans the barcode field only, so this makes them scannable at the
till from a printed Code128 label. This is a deliberate departure from the sets
behaviour, where the barcode is a real manufacturer EAN.

### Category parsing

Brickset returns category as a slash delimited path with a variable depth:

```
Star Wars / Star Wars The Clone Wars
Town / City / Building
Collectible Minifigures / Series  1 Minifigures
```

The first segment is the theme and the last is the most specific subtheme.
Internal whitespace is collapsed, which fixes the double space in `Series  1`.

Two theme names differ from the Brickset set themes already used as vendor
values on the storefront, so they are aliased for consistency:

- `Town` becomes `City`
- `NINJAGO` becomes `Ninjago`

## Architecture

```
app/lib/brickset.server.js          fetchMinifigs() + pure helpers
app/lib/shopify-product.server.js   shared Shopify writes (new)
app/lib/import-minifigs.server.js   minifigure importer (new)
app/lib/import-products.server.js   set importer, refactored onto the shared module
app/routes/app.import-minifigs.jsx  action route (new)
app/routes/app._index.jsx           Sets / Minifigures toggle + chunked loop
```

`fetchMinifigs(ids, env)` groups IDs by prefix, issues one call per group,
populates a cache from every returned minifigure, then falls back to an exact
query for any ID a group did not resolve. It reuses the existing global rate
limiter, cached login hash and backoff, so minifigure lookups are throttled
alongside set lookups rather than competing with them.

`shopify-product.server.js` holds the parts both importers need: duplicate SKU
check, sales channel list, product create with tolerant metafield error
handling, first variant lookup, variant field write, SKU write, channel publish
and media attach. Extracting it removes the duplication that copying the set
importer would have created.

The extraction is behaviour preserving with one deliberate exception. In the old
set importer the SKU write was nested inside the inventory tracking branch, so a
failed tracking update silently skipped the SKU as well. The SKU is the key the
duplicate check and the barcode backfill both match on, so it is now written
independently of whether tracking succeeded.

## Chunked imports

Brickset is limited to one request per second. A large paste would exceed the
platform request timeout in a single POST, the same problem the barcode backfill
already solved.

The minifigure form therefore posts in chunks of 25 and accumulates results
client side, following the loop already proven in `app.backfill.jsx`. The
progress bar becomes real rather than simulated. Prefix batching means a chunk
of 25 consecutive IDs usually costs three or four Brickset calls, not 25.

## Error handling

Per minifigure, matching the set importer's result shape so the UI table is
shared:

| Case | Status | Behaviour |
| --- | --- | --- |
| Unknown ID | `error` | `MINIFIG_NOT_FOUND`, import continues |
| SKU already in Shopify | `skipped` | `DUPLICATE_SKU`, reports the existing product |
| Image missing from CDN | `created` | product created, message notes no image |
| Brickset rate limited | `error` | existing backoff, then a clear resume message |
| Product create fails | `error` | `PRODUCT_CREATE_ERROR` |

Variant, channel and media failures stay non fatal, as they are for sets. The
product exists at that point and the team amends pricing by hand anyway.

## Testing

Unit tests on the pure helpers: ID normalisation, prefix grouping, category
splitting, theme aliasing, minifigure map building. Then a live import into the
development store covering a known good ID, an unknown ID and a duplicate.

## Out of scope

- Pricing. The team sets prices by hand after import.
- Backfilling barcodes onto existing minifigure listings. Those already exist
  without barcodes and would need the same treatment as the set backfill.
- Naming for Collectible Minifigures. The shop has no existing `col*` listing to
  copy, so the doubled-word rule described above is a judgement call and may
  need revisiting once they list some.
