// End-to-end tests through the REAL admin.graphql stack installed here:
// @shopify/shopify-app-react-router's client factory and handleClientError,
// @shopify/shopify-api, and @shopify/graphql-client with its own retries.
// Only globalThis.fetch is fake: it plays Shopify for new products and
// Brickset for importSets. No network, no database. Run with: npm test
//
// The fake Shopify follows the 2026-10 docs: productCreate makes a draft
// stocked at the warehouse only, inventoryBulkToggleActivation returns "The
// activated inventory levels" and refuses with MISSING_SKU while the variant
// has no SKU (a code the docs list). Faults are injected per operation:
// "apply then lose the reply" means Shopify did the work but the reply never
// arrived. These are hypothetical scenarios, not observed live.
//
// node --test runs each test file in its own process, so replacing fetch here
// does not reach any other test file.

/* global globalThis */
import { test } from "node:test";
import assert from "node:assert/strict";

// ---- fake fetch, installed BEFORE the node adapter captures globalThis.fetch
let route = null;
const sent = [];
globalThis.fetch = async (url, init) => {
  const u = String(url);
  const entry = { url: u, body: init?.body };
  if (u.includes("/graphql.json")) {
    const b = JSON.parse(init.body);
    entry.op = /\b(?:query|mutation)\s+(\w+)/.exec(b.query)?.[1] ?? "anonymous";
    entry.variables = b.variables;
  }
  sent.push(entry);
  return route(entry);
};

await import("@shopify/shopify-api/adapters/node");
const { shopifyApi, Session, LogSeverity } = await import("@shopify/shopify-api");
const NM = new URL("../../node_modules/", import.meta.url);
const { graphqlClientFactory } = await import(
  new URL("@shopify/shopify-app-react-router/dist/esm/server/clients/admin/graphql.mjs", NM).href
);
const { handleClientErrorFactory } = await import(
  new URL("@shopify/shopify-app-react-router/dist/esm/server/authenticate/admin/helpers/handle-client-error.mjs", NM).href
);
const sp = await import("./shopify-product.server.js");
const { importSets } = await import("./import-products.server.js");

const api = shopifyApi({
  apiKey: "k",
  apiSecretKey: "s",
  scopes: [],
  hostName: "harness.local",
  apiVersion: "2026-10",
  isEmbeddedApp: true,
  logger: { level: LogSeverity.Error, log: () => {} },
});
const session = new Session({ id: "offline_x", shop: "harness.myshopify.com", state: "", isOnline: false, accessToken: "t" });
const params = { api, logger: { debug() {}, info() {}, warning() {}, error() {} } };
const admin = {
  graphql: graphqlClientFactory({
    params,
    session,
    handleClientError: handleClientErrorFactory({ request: new Request("https://harness.local/app") }),
  }),
};

// ---- a small Shopify for brand-new products
const AYL = "gid://shopify/Location/115870531959";
const GLA = "gid://shopify/Location/115809452407";
const WH = "gid://shopify/Location/106650468727";
const LOCS = [AYL, GLA, WH];
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const THROTTLED = { errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }] };

function makeShop() {
  const shop = { products: [], faults: {}, existingSkus: new Set() };
  shop.handle = (e) => {
    const f = shop.faults[e.op];
    if (f && f.length) {
      const next = f.shift();
      if (next !== "pass") return next(e, shop);
    }
    return shop.apply(e);
  };
  shop.apply = (e) => {
    const v = e.variables || {};
    switch (e.op) {
      case "anonymous": // publications
        return json({ data: { publications: { edges: [] } } });
      case "ImportLocations":
        return json({ data: { locations: { edges: LOCS.map((id) => ({ node: { id } })) } } });
      case "checkProductBySku": {
        const sku = String(v.query).replace(/^sku:/, "");
        const hit = shop.products.find((p) => p.sku === sku);
        return json({ data: { products: { edges: hit ? [{ node: { id: hit.id, title: hit.title, status: "DRAFT", variants: { edges: [] } } }] : [] } } });
      }
      case "CreateProduct": {
        const p = { id: `gid://shopify/Product/${shop.products.length + 1}`, title: v.product.title, sku: "", barcodes: [], tracked: false, levels: new Set([WH]) };
        shop.products.push(p);
        return json({ data: { productCreate: { product: { id: p.id, title: p.title, status: "DRAFT", publishedAt: null }, userErrors: [] } } });
      }
      case "getProduct": {
        const p = shop.products.find((x) => x.id === v.id);
        return json({ data: { product: { variants: { edges: [{ node: { id: p.id.replace("Product", "ProductVariant"), sku: p.sku, inventoryItem: { id: p.id.replace("Product", "InventoryItem"), tracked: p.tracked } } }] } } } });
      }
      case "productVariantsBulkUpdate": {
        const p = shop.products.find((x) => x.id === v.productId);
        const i = v.variants[0];
        if (i.inventoryItem?.sku !== undefined) p.sku = i.inventoryItem.sku;
        if (i.inventoryItem?.tracked !== undefined) p.tracked = i.inventoryItem.tracked;
        if (i.barcodes) p.barcodes = i.barcodes;
        return json({ data: { productVariantsBulkUpdate: { productVariants: [{ id: "v", sku: p.sku, inventoryPolicy: "DENY", barcodes: { nodes: p.barcodes }, inventoryItem: { id: "i", tracked: p.tracked } }], userErrors: [] } } });
      }
      case "ImportInventoryLevels": {
        const p = shop.products.find((x) => x.id.replace("Product", "InventoryItem") === v.id);
        return json({ data: { inventoryItem: { id: v.id, inventoryLevels: { edges: [...p.levels].map((id) => ({ node: { location: { id } } })) } } } });
      }
      case "ImportStockAtLocations": {
        const p = shop.products.find((x) => x.id.replace("Product", "InventoryItem") === v.inventoryItemId);
        if (!p.sku) {
          return json({ data: { inventoryBulkToggleActivation: { inventoryItem: { id: v.inventoryItemId }, inventoryLevels: [], userErrors: [{ field: ["inventoryItemUpdates"], message: "Cannot stock this inventory item at this location because the variant is missing a SKU.", code: "MISSING_SKU" }] } } });
        }
        const newly = [];
        for (const u of v.inventoryItemUpdates) {
          if (!u.activate) throw new Error("harness: activate:false sent");
          if (!p.levels.has(u.locationId)) newly.push(u.locationId);
          p.levels.add(u.locationId);
        }
        return json({ data: { inventoryBulkToggleActivation: { inventoryItem: { id: v.inventoryItemId }, inventoryLevels: newly.map((id) => ({ id: "l", location: { id }, quantities: [{ name: "available", quantity: 0 }] })), userErrors: [] } } });
      }
      case "publishablePublish":
        return json({ data: { publishablePublish: { publishable: { id: v.id }, userErrors: [] } } });
      case "AttachImages":
        return json({ data: { productUpdate: { product: { id: "p", media: { nodes: [] } }, userErrors: [] } } });
      default:
        throw new Error("harness: unexpected op " + e.op);
    }
  };
  return shop;
}

// Fault helpers.
const applyThenThrow = (e, shop) => {
  shop.apply(e); // Shopify did the work...
  throw new TypeError("fetch failed"); // ...and the reply never arrived
};
const throwBeforeSend = () => {
  throw new TypeError("fetch failed");
};
const status = (s) => () => json({ errors: "boom" }, s);
const throttled = () => json(THROTTLED);

function freshProduct(shop, sku = "") {
  const p = { id: `gid://shopify/Product/${shop.products.length + 1}`, title: "Set", sku, barcodes: [], tracked: true, levels: new Set([WH]) };
  shop.products.push(p);
  return p;
}
const itemOf = (p) => p.id.replace("Product", "InventoryItem");
const opCount = (op) => sent.filter((s) => s.op === op).length;
const noWait = async () => {};
const locs = LOCS.map((id) => ({ id, name: id }));

// ---- a small Brickset for importSets
const SETS = {
  "10001-1": { setID: 1, number: "10001", numberVariant: 1, name: "Alpha", year: 2020, theme: "City", barcode: { EAN: "", UPC: "" } },
  "10002-1": { setID: 2, number: "10002", numberVariant: 1, name: "Bravo", year: 2020, theme: "City", barcode: { EAN: "", UPC: "" } },
  "10003-1": { setID: 3, number: "10003", numberVariant: 1, name: "Charlie", year: 2020, theme: "City", barcode: { EAN: "", UPC: "" } },
};
function brickset(e) {
  const p = new URLSearchParams(e.body);
  if (e.url.endsWith("/login")) return json({ status: "success", hash: "h" });
  if (e.url.endsWith("/getSets")) {
    const n = JSON.parse(p.get("params")).setNumber;
    return json({ status: "success", sets: SETS[n] ? [SETS[n]] : [] });
  }
  if (e.url.endsWith("/getAdditionalImages")) return json({ status: "success", additionalImages: [] });
  throw new Error("harness: unexpected brickset call " + e.url);
}
const ENV = { BRICKSET_API_KEY: "k", BRICKSET_USERNAME: "u", BRICKSET_PASSWORD: "p" };

function use(shop) {
  sent.length = 0;
  route = (e) => (e.url.includes("brickset.com") ? brickset(e) : shop.handle(e));
}
const rowsById = (out) => Object.fromEntries((out.results ?? out).map((r) => [r.id, r]));

// ---------------------------------------------------------------- retries

test("L1 a 200 THROTTLED reply is not retried by the library; requestWithRetries retries it (3 sends, then ok)", async () => {
  const shop = makeShop();
  use(shop);
  const p = freshProduct(shop, "75192");
  shop.faults.ImportStockAtLocations = [throttled, throttled];
  const r = await sp.stockAtAllLocations(admin, { inventoryItemId: itemOf(p), locations: locs, wait: noWait });
  assert.equal(opCount("ImportStockAtLocations"), 3);
  assert.equal(r.ok, true);
});

test("L2 network error after the activation was applied: the library re-sends it, the re-read confirms, ok", async () => {
  const shop = makeShop();
  use(shop);
  const p = freshProduct(shop, "75192");
  shop.faults.ImportStockAtLocations = [applyThenThrow];
  const r = await sp.stockAtAllLocations(admin, { inventoryItemId: itemOf(p), locations: locs, wait: noWait });
  assert.equal(opCount("ImportStockAtLocations"), 2, "mutation was sent twice");
  assert.equal(opCount("ImportInventoryLevels"), 2, "levels read before and re-read after");
  assert.equal(r.ok, true);
  assert.deepEqual([...p.levels].sort(), [...LOCS].sort());
});

test("L4 the SKU write is absolute, so a network error is re-sent by the library and the SKU lands", async () => {
  const shop = makeShop();
  use(shop);
  const p = freshProduct(shop, "");
  p.tracked = false;
  // order inside setUpNewVariant: getProduct, bulk(barcodes), bulk(sku), bulk(tracking), levels, activate
  shop.faults.productVariantsBulkUpdate = ["pass", throwBeforeSend];
  const r = await sp.setUpNewVariant(admin, { productId: p.id, sku: "75192", barcodes: [], locations: locs, wait: noWait });
  assert.equal(opCount("productVariantsBulkUpdate"), 4, "barcodes, sku twice (re-sent), tracking");
  assert.equal(r.ok, true);
  assert.equal(r.skuSet, true);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.stocking.ok, true);
});

test("L4b a SKU write that keeps failing is reported, and the MISSING_SKU stocking failure with it", async () => {
  const shop = makeShop();
  use(shop);
  const p = freshProduct(shop, "");
  p.tracked = false;
  // a 500 is not retried by the library, and is not THROTTLED
  shop.faults.productVariantsBulkUpdate = ["pass", status(500)];
  const r = await sp.setUpNewVariant(admin, { productId: p.id, sku: "75192", barcodes: [], locations: locs, wait: noWait });
  assert.equal(opCount("productVariantsBulkUpdate"), 3, "barcodes, sku once, tracking");
  assert.equal(r.skuSet, false);
  assert.match(r.warnings.join(" "), /SKU not set/);
  assert.equal(r.stocking.ok, false);
  assert.match(r.stocking.message, /missing a SKU/);
});

test("L5 reply lost after apply AND the re-read fails: the row says unknown, never NOT stocked", async () => {
  const shop = makeShop();
  use(shop);
  const p = freshProduct(shop, "75192");
  // activation: applied then the reply is lost, and the library's 2 re-sends fail before reaching Shopify
  shop.faults.ImportStockAtLocations = [applyThenThrow, throwBeforeSend, throwBeforeSend];
  // first levels read passes, the re-read is THROTTLED every time
  shop.faults.ImportInventoryLevels = ["pass", throttled, throttled, throttled];
  const r = await sp.stockAtAllLocations(admin, { inventoryItemId: itemOf(p), locations: locs, wait: noWait });
  assert.deepEqual([...p.levels].sort(), [...LOCS].sort(), "truth: stocked everywhere");
  assert.equal(r.ok, false);
  assert.doesNotMatch(r.message, /NOT stocked/);
  assert.match(r.message, /^stocked at warehouse; UNKNOWN at Aylesbury, Glasgow, check them in Shopify \(/);
  assert.match(r.message, /re-check failed: Throttled/);
  assert.deepEqual(r.unknown.map((l) => l.id), [AYL, GLA]);
  assert.deepEqual(r.failed, []);
});

test("F3 the duplicate check retries THROTTLED, so one throttled reply does not skip or duplicate", async () => {
  const shop = makeShop();
  use(shop);
  shop.faults.checkProductBySku = [throttled];
  const rows = rowsById(await importSets(Promise.resolve({ admin }), ["10001"], ENV));
  assert.equal(rows["10001"].status, "created");
  assert.equal(opCount("checkProductBySku"), 2);
  assert.equal(opCount("CreateProduct"), 1);
});

test("F3 a duplicate check that still fails is fail-closed: nothing is created and the row says so", async () => {
  const shop = makeShop();
  use(shop);
  shop.faults.checkProductBySku = [status(500)];
  const rows = rowsById(await importSets(Promise.resolve({ admin }), ["10001", "10002"], ENV));
  assert.equal(rows["10001"].status, "error");
  assert.equal(rows["10001"].errorCode, "DUPLICATE_CHECK_FAILED");
  assert.match(rows["10001"].message, /^Not imported: could not check whether a product with SKU "10001" already exists/);
  assert.match(rows["10001"].message, /Nothing was created\. Import 10001 again\.$/);
  assert.equal(rows["10002"].status, "created", "the next item still runs");
  assert.equal(opCount("CreateProduct"), 1);
});

// ---------------------------------------------------------------- end to end

test("E1 one bad item never stops the run; a variant that cannot be read is reported as a draft left behind", async () => {
  const shop = makeShop();
  use(shop);
  // the 2nd product's variant read gets a 500 (not retried)
  shop.faults.getProduct = ["pass", status(500)];
  const rows = rowsById(await importSets(Promise.resolve({ admin }), ["10001", "10002", "10003"], ENV));
  assert.equal(rows["10001"].status, "created");
  assert.equal(rows["10003"].status, "created");
  assert.equal(rows["10002"].status, "error");
  assert.equal(rows["10002"].shopifyProductId, "gid://shopify/Product/2");
  assert.match(rows["10002"].message, /^Created draft "/);
  assert.match(rows["10002"].message, /Delete that draft in Shopify, then import 10002 again\.$/);
  assert.equal(shop.products.length, 3);
});

test("E2 productCreate applied but its reply lost: sent once, and the row warns a draft may already exist", async () => {
  const shop = makeShop();
  use(shop);
  shop.faults.CreateProduct = [applyThenThrow];
  const rows = rowsById(await importSets(Promise.resolve({ admin }), ["10001"], ENV));
  assert.equal(shop.products.length, 1, "Shopify did create it");
  assert.equal(opCount("CreateProduct"), 1, "productCreate is never re-sent");
  assert.equal(rows["10001"].status, "error");
  assert.equal(rows["10001"].errorCode, "PRODUCT_CREATE_UNCONFIRMED");
  assert.match(rows["10001"].message, /^Shopify did not confirm the product was created \(/);
  assert.match(rows["10001"].message, /a draft "Alpha 10001 \| City \| LEGO" may already exist\./);
  assert.match(rows["10001"].message, /Search Shopify for that title before importing 10001 again/);
});

test("E2b productCreate refused as THROTTLED: sent once, and no may-exist warning (it never ran)", async () => {
  const shop = makeShop();
  use(shop);
  shop.faults.CreateProduct = [throttled];
  const rows = rowsById(await importSets(Promise.resolve({ admin }), ["10001"], ENV));
  assert.equal(shop.products.length, 0);
  assert.equal(opCount("CreateProduct"), 1);
  assert.equal(rows["10001"].errorCode, "PRODUCT_CREATE_ERROR");
  assert.doesNotMatch(rows["10001"].message, /may already exist/);
});

test("E3 a barcode write that fails is a row warning, and the message says the barcodes were not written", async () => {
  const shop = makeShop();
  use(shop);
  SETS["10001-1"].barcode = { EAN: "5702017155364", UPC: "" };
  try {
    shop.faults.productVariantsBulkUpdate = [
      () => json({ data: { productVariantsBulkUpdate: { productVariants: [], userErrors: [{ field: ["barcodes"], message: "Barcode is invalid" }] } } }),
    ];
    const rows = rowsById(await importSets(Promise.resolve({ admin }), ["10001"], ENV));
    const row = rows["10001"];
    assert.equal(row.status, "created");
    assert.deepEqual(row.warnings, [
      "barcodes not written: add 5702017155364 to the variant in Shopify, or the tills cannot scan it",
    ]);
    assert.match(row.message, /barcodes .* NOT written/);
    assert.deepEqual(shop.products[0].barcodes, [], "nothing was written");
  } finally {
    SETS["10001-1"].barcode = { EAN: "", UPC: "" };
  }
});
