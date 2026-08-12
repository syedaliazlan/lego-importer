// Unit tests for the pure minifigure helpers.
// Run with: npm test   (uses Node's built-in test runner, no extra deps)

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildMinifigMap,
  groupIdsByPrefix,
  normalizeMinifigId,
  normalizeTheme,
  parseMinifigCategory,
} from "./brickset.server.js";
import {
  buildMinifigProductInput,
  buildMinifigTitle,
  minifigImageUrl,
} from "./import-minifigs.server.js";

/* ---------------- normalizeMinifigId ---------------- */

test("normalizeMinifigId: lowercases and trims", () => {
  assert.equal(normalizeMinifigId("SW0197"), "sw0197");
  assert.equal(normalizeMinifigId("  sw0197 "), "sw0197");
  assert.equal(normalizeMinifigId("Sw0197"), "sw0197");
});

test("normalizeMinifigId: accepts the ID shapes BrickLink actually uses", () => {
  assert.equal(normalizeMinifigId("hp001"), "hp001"); // 2 letters, 3 digits
  assert.equal(normalizeMinifigId("col001"), "col001"); // 3 letters, 3 digits
  assert.equal(normalizeMinifigId("njo0500"), "njo0500"); // 3 letters, 4 digits
  assert.equal(normalizeMinifigId("cty1234"), "cty1234");
  assert.equal(normalizeMinifigId("sw0001a"), "sw0001a"); // trailing variant letter
});

test("normalizeMinifigId: rejects set numbers and junk", () => {
  assert.equal(normalizeMinifigId("40760"), ""); // a set number, not a minifig
  assert.equal(normalizeMinifigId("40760-1"), "");
  assert.equal(normalizeMinifigId(""), "");
  assert.equal(normalizeMinifigId(null), "");
  assert.equal(normalizeMinifigId(undefined), "");
  assert.equal(normalizeMinifigId("sw"), ""); // no digits
  assert.equal(normalizeMinifigId("some minifig"), "");
});

/* ---------------- groupIdsByPrefix ---------------- */

test("groupIdsByPrefix: consecutive IDs collapse into one query", () => {
  const groups = groupIdsByPrefix(["sw0190", "sw0195", "sw0197", "sw0199"]);
  assert.equal(groups.size, 1);
  assert.deepEqual(groups.get("sw019"), ["sw0190", "sw0195", "sw0197", "sw0199"]);
});

test("groupIdsByPrefix: scattered IDs get their own group each", () => {
  const groups = groupIdsByPrefix(["sw0197", "hp001", "njo0500"]);
  assert.equal(groups.size, 3);
  assert.deepEqual([...groups.keys()], ["sw019", "hp00", "njo050"]);
});

test("groupIdsByPrefix: never loses an ID", () => {
  const ids = ["sw0190", "sw0191", "hp001", "hp002", "col001"];
  const groups = groupIdsByPrefix(ids);
  assert.deepEqual([...groups.values()].flat().sort(), [...ids].sort());
});

test("groupIdsByPrefix: very short IDs are queried whole", () => {
  const groups = groupIdsByPrefix(["ab1"]);
  assert.deepEqual(groups.get("ab1"), ["ab1"]);
});

test("groupIdsByPrefix: handles empty input", () => {
  assert.equal(groupIdsByPrefix([]).size, 0);
  assert.equal(groupIdsByPrefix(null).size, 0);
});

/* ---------------- parseMinifigCategory ---------------- */

test("parseMinifigCategory: two-level path splits into theme and subtheme", () => {
  assert.deepEqual(parseMinifigCategory("Star Wars / Star Wars The Clone Wars"), {
    theme: "Star Wars",
    subtheme: "Star Wars The Clone Wars",
  });
});

test("parseMinifigCategory: three-level path keeps the most specific subtheme", () => {
  assert.deepEqual(parseMinifigCategory("Town / City / Building"), {
    theme: "City", // Town is aliased to match the set themes
    subtheme: "Building",
  });
});

test("parseMinifigCategory: single-level path has no subtheme", () => {
  assert.deepEqual(parseMinifigCategory("Harry Potter"), { theme: "Harry Potter", subtheme: "" });
});

test("parseMinifigCategory: collapses Brickset's double spaces", () => {
  assert.deepEqual(parseMinifigCategory("Collectible Minifigures / Series  1 Minifigures"), {
    theme: "Collectible Minifigures",
    subtheme: "Series 1 Minifigures",
  });
});

test("parseMinifigCategory: handles missing or empty categories", () => {
  assert.deepEqual(parseMinifigCategory(""), { theme: "", subtheme: "" });
  assert.deepEqual(parseMinifigCategory(null), { theme: "", subtheme: "" });
  assert.deepEqual(parseMinifigCategory(" / "), { theme: "", subtheme: "" });
});

/* ---------------- normalizeTheme ---------------- */

test("normalizeTheme: aliases the themes that differ from set themes", () => {
  assert.equal(normalizeTheme("Town"), "City");
  assert.equal(normalizeTheme("NINJAGO"), "Ninjago");
});

test("normalizeTheme: passes everything else through untouched", () => {
  assert.equal(normalizeTheme("Star Wars"), "Star Wars");
  assert.equal(normalizeTheme("Harry Potter"), "Harry Potter");
  assert.equal(normalizeTheme(""), "");
});

/* ---------------- buildMinifigMap ---------------- */

test("buildMinifigMap: maps real Brickset payloads", () => {
  const map = buildMinifigMap([
    {
      minifigNumber: "sw0197",
      name: "Obi-Wan Kenobi - Clone Wars, Large Eyes",
      category: "Star Wars / Star Wars The Clone Wars",
      ownedTotal: 0,
    },
    {
      minifigNumber: "cty1234",
      name: "Mom - Medium Lavender Jacket, Dark Blue Legs, Black Hair",
      category: "Town / City / Building",
      ownedTotal: 0,
    },
  ]);

  assert.deepEqual(map.get("sw0197"), {
    id: "sw0197",
    sku: "SW0197",
    name: "Obi-Wan Kenobi - Clone Wars, Large Eyes",
    theme: "Star Wars",
    subtheme: "Star Wars The Clone Wars",
  });
  assert.equal(map.get("cty1234").theme, "City");
  assert.equal(map.get("cty1234").sku, "CTY1234");
});

test("buildMinifigMap: first entry wins on duplicates", () => {
  const map = buildMinifigMap([
    { minifigNumber: "sw0197", name: "First", category: "Star Wars" },
    { minifigNumber: "sw0197", name: "Second", category: "Star Wars" },
  ]);
  assert.equal(map.get("sw0197").name, "First");
});

test("buildMinifigMap: drops rows without a usable ID", () => {
  const map = buildMinifigMap([
    { minifigNumber: "", name: "No id", category: "Star Wars" },
    { minifigNumber: null, name: "Null id", category: "Star Wars" },
  ]);
  assert.equal(map.size, 0);
});

test("buildMinifigMap: handles empty input", () => {
  assert.equal(buildMinifigMap([]).size, 0);
  assert.equal(buildMinifigMap(null).size, 0);
});

/* ---------------- title and product input ---------------- */

const OBI_WAN = {
  id: "sw0197",
  sku: "SW0197",
  name: "Obi-Wan Kenobi - Clone Wars, Large Eyes",
  theme: "Star Wars",
  subtheme: "Star Wars The Clone Wars",
};

test("buildMinifigTitle: matches the storefront convention", () => {
  assert.equal(
    buildMinifigTitle(OBI_WAN),
    "Obi-Wan Kenobi - Clone Wars, Large Eyes SW0197 | Star Wars Minifigure | LEGO"
  );
});

test("buildMinifigTitle: still reads correctly without a theme", () => {
  assert.equal(
    buildMinifigTitle({ ...OBI_WAN, theme: "" }),
    "Obi-Wan Kenobi - Clone Wars, Large Eyes SW0197 | Minifigure | LEGO"
  );
});

test("buildMinifigTitle: does not repeat 'Minifigure' for the CMF theme", () => {
  assert.equal(
    buildMinifigTitle({
      id: "col001",
      sku: "COL001",
      name: "Tribal Hunter, Series 1",
      theme: "Collectible Minifigures",
      subtheme: "Series 1 Minifigures",
    }),
    "Tribal Hunter, Series 1 COL001 | Collectible Minifigures | LEGO"
  );
});

test("buildMinifigTitle: trims long catalogue names to Shopify's 255 char limit", () => {
  const title = buildMinifigTitle({ ...OBI_WAN, name: "A".repeat(400) });

  assert.ok(title.length <= 255, `expected <= 255, got ${title.length}`);
  // The number and theme survive; only the name is cut.
  assert.ok(title.endsWith(" SW0197 | Star Wars Minifigure | LEGO"));
  assert.match(title, /\.\.\. SW0197/);
});

test("buildMinifigTitle: leaves a name that already fits untouched", () => {
  const title = buildMinifigTitle(OBI_WAN);
  assert.ok(title.length <= 255);
  assert.ok(!title.includes("..."));
});

test("minifigImageUrl: points at the BrickLink CDN using the lowercase ID", () => {
  assert.equal(minifigImageUrl("sw0197"), "https://img.bricklink.com/ItemImage/MN/0/sw0197.png");
});

test("buildMinifigProductInput: sets the fields the shop relies on", () => {
  const input = buildMinifigProductInput(OBI_WAN, {});

  assert.equal(input.productType, "Minifigures");
  assert.equal(input.status, "DRAFT");
  assert.equal(input.vendor, "Star Wars");
  assert.deepEqual(input.tags, ["brickset-imported", "minifigure"]);
  assert.match(input.title, /^Obi-Wan Kenobi - Clone Wars, Large Eyes SW0197 \| Star Wars Minifigure \| LEGO$/);
  assert.match(input.descriptionHtml, /SW0197/);
  assert.match(input.descriptionHtml, /Star Wars The Clone Wars/);
});

test("buildMinifigProductInput: writes theme and number into the brickset namespace", () => {
  const input = buildMinifigProductInput(OBI_WAN, {});
  const byKey = Object.fromEntries(input.metafields.map((m) => [m.key, m]));

  assert.equal(byKey.minifig_number.value, "SW0197");
  assert.equal(byKey.minifig_number.namespace, "brickset");
  assert.equal(byKey.theme.value, "Star Wars");
  assert.equal(byKey.subtheme.value, "Star Wars The Clone Wars");
  assert.equal(byKey.source.value, "brickset");
});

test("buildMinifigProductInput: falls back to DEFAULT_VENDOR when the theme is missing", () => {
  const input = buildMinifigProductInput({ ...OBI_WAN, theme: "" }, { DEFAULT_VENDOR: "LEGO" });
  assert.equal(input.vendor, "LEGO");
});
