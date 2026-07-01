// ===============================================================
// /app/lib/brickset.server.js
// Brickset API v3 client.
// ===============================================================

const API_URL = "https://brickset.com/api/v3.asmx";

// Brickset issues a userHash at login. Logging in on every request trips
// Brickset's rate limiting (it starts serving HTML error pages instead of
// JSON), so we cache the hash in module scope and reuse it across requests.
let cachedHash = null;
let cachedHashAt = 0;
const HASH_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function credsFromEnv(env) {
  const apiKey = env.BRICKSET_API_KEY;
  const username = env.BRICKSET_USERNAME;
  const password = env.BRICKSET_PASSWORD;
  if (!apiKey || !username || !password) {
    throw new Error("Missing BRICKSET_API_KEY / USERNAME / PASSWORD in .env");
  }
  return { apiKey, username, password };
}

// Read the body as text first so a non-JSON response (an HTML rate-limit or
// error page) gives a clear message instead of a raw "Unexpected token <".
async function parseBricksetJson(res, context) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    const snippet = text.replace(/\s+/g, " ").trim().slice(0, 140);
    throw new Error(
      `Brickset ${context} returned a non-JSON response (HTTP ${res.status}). ` +
        `This usually means Brickset is rate limiting or the daily API limit was reached. ` +
        `Try again shortly. Response started: "${snippet}"`
    );
  }
}

/* ---------------- LOGIN (raw) ---------------- */
async function login(apiKey, username, password) {
  const res = await fetch(`${API_URL}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ apiKey, username, password }),
  });

  const data = await parseBricksetJson(res, "login");
  if (data.status !== "success") {
    throw new Error(`Brickset login failed: ${JSON.stringify(data)}`);
  }
  return data.hash;
}

// Cached login. Pass forceRefresh to bypass the cache, e.g. after an
// "Invalid user hash" error.
async function getUserHash(apiKey, username, password, forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && cachedHash && now - cachedHashAt < HASH_TTL_MS) {
    return cachedHash;
  }
  cachedHash = await login(apiKey, username, password);
  cachedHashAt = Date.now();
  return cachedHash;
}

/* ---------------- getSets (single set) ---------------- */
async function fetchBricksetSet(apiKey, userHash, setNumber) {
  const res = await fetch(`${API_URL}/getSets`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      apiKey,
      userHash,
      params: JSON.stringify({ setNumber, extendedData: 1 }),
    }),
  });

  const data = await parseBricksetJson(res, "getSets");
  if (!data.sets?.length) throw new Error(`Set not found: ${setNumber}`);
  return data.sets[0];
}

/* ---------------- ADDITIONAL IMAGES via setID ---------------- */
async function getAdditionalImages(apiKey, userHash, setID) {
  const res = await fetch(`${API_URL}/getAdditionalImages`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ apiKey, userHash, setID }),
  });

  const data = await parseBricksetJson(res, "getAdditionalImages");
  return data.additionalImages?.length ? data.additionalImages.map((i) => i.imageURL) : [];
}

/* ===============================================================
   EXPORT: MAIN FUNCTION used by import-products.server.js
=============================================================== */
export async function fetchSet(setNumber, env) {
  const { apiKey, username, password } = credsFromEnv(env);
  const userHash = await getUserHash(apiKey, username, password);

  // Normalize set number: if it doesn't end with -1, add it for the API call.
  let normalizedSetNumber = setNumber.trim();
  if (!normalizedSetNumber.endsWith("-1")) {
    normalizedSetNumber = `${normalizedSetNumber}-1`;
  }

  const s = await fetchBricksetSet(apiKey, userHash, normalizedSetNumber);

  const setID = s.setID;
  let gallery = [];

  if (s.image?.imageURL) gallery.push(s.image.imageURL);

  if (setID) {
    try {
      const extraImages = await getAdditionalImages(apiKey, userHash, setID);
      gallery = [...new Set([...gallery, ...extraImages])];
    } catch {
      // Additional images are optional; ignore failures here.
    }
  }

  const cleanSetNum = s.number;

  return {
    set_num: `${s.number}-${s.numberVariant}`, // Full set number with variant
    set_num_clean: cleanSetNum, // Clean set number without -1 for titles/SKU
    name: s.name,
    year: s.year ?? "",
    pieces: s.pieces ?? "",
    theme: s.theme ?? "",
    subtheme: s.subtheme ?? "",
    description: s.extendedData?.description ?? s.notes ?? "",
    bricksetURL: s.bricksetURL || "",
    ean: (s.barcode?.EAN || "").trim(), // EAN-13 for Shopify POS barcode scanning
    upc: (s.barcode?.UPC || "").trim(), // US UPC; not written to Shopify (won't match UK/EU boxes)
    gallery,
  };
}

/* ===============================================================
   BATCH EAN LOOKUP, used by the barcode backfill.
   getSets accepts a comma-delimited setNumber list; pageSize max 500.
   Returns the raw Brickset set objects (each has .number and .barcode.EAN).
=============================================================== */

// One getSets call for a batch of set numbers, with a cached hash, retries,
// and a forced re-login if the hash was rejected.
async function getSetsBatch(apiKey, username, password, batch) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const userHash = await getUserHash(apiKey, username, password, attempt > 0);

      const res = await fetch(`${API_URL}/getSets`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          apiKey,
          userHash,
          params: JSON.stringify({ setNumber: batch.join(","), pageSize: 500 }),
        }),
      });

      const data = await parseBricksetJson(res, "getSets");

      if (data.status && data.status !== "success") {
        // A rejected hash is retriable: force a fresh login next attempt.
        if (/user hash/i.test(data.message || "")) {
          lastErr = new Error(data.message);
          continue;
        }
        throw new Error(`Brickset getSets failed: ${JSON.stringify(data)}`);
      }

      return Array.isArray(data.sets) ? data.sets : [];
    } catch (err) {
      lastErr = err;
      await sleep(600 * (attempt + 1)); // 600ms, 1200ms backoff
    }
  }
  throw lastErr;
}

export async function fetchEansForSetNumbers(setNumbers, env) {
  const { apiKey, username, password } = credsFromEnv(env);

  // De-duplicate; a single Shopify page can repeat set numbers across variants.
  const unique = [...new Set((setNumbers || []).filter(Boolean))];
  if (unique.length === 0) return [];

  const sets = [];
  for (let i = 0; i < unique.length; i += 500) {
    const batch = unique.slice(i, i + 500);
    const batchSets = await getSetsBatch(apiKey, username, password, batch);
    sets.push(...batchSets);
  }
  return sets;
}
