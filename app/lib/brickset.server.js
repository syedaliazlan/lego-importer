// ===============================================================
// /app/lib/brickset.server.js
// Brickset API v3 client with conservative, self-imposed rate limiting.
//
// Brickset does not publish a numeric rate limit, but it enforces two things:
//   1. A daily getSets quota. Over it, getSets returns JSON
//      {status:"error", message:"API limit exceeded"} (only getSets counts).
//   2. Infrastructure throttling: too many requests too quickly returns an
//      HTTP 429 with an HTML page (Cloudflare), on ANY endpoint including login.
//
// To stay well within both we:
//   - Log in once and cache the userHash for the life of the process, only
//     re-logging in if the hash is explicitly rejected.
//   - Serialize every Brickset HTTP call through one global limiter so we never
//     send more than ~1 request per second.
//   - Back off (honouring Retry-After) on 429/503, and stop clearly on the
//     documented daily-limit error.
// ===============================================================

const API_URL = "https://brickset.com/api/v3.asmx";

// Minimum gap between the START of one Brickset request and the next.
// ~1 request/second is comfortably within Brickset's tolerance.
const MIN_INTERVAL_MS = 1000;

// The userHash is long lived; refresh at most this often (or on rejection).
const HASH_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

let cachedHash = null;
let cachedHashAt = 0;

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

/* ---------------- Global rate limiter ----------------
   All Brickset calls run one at a time, spaced by MIN_INTERVAL_MS.
   Module scope means it holds across every backfill chunk in the process. */
let lastCallAt = 0;
let queue = Promise.resolve();

function scheduleBricksetCall(fn) {
  const run = async () => {
    const wait = lastCallAt + MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastCallAt = Date.now();
    return fn();
  };
  const result = queue.then(run, run);
  // Keep the chain alive whether this call resolves or rejects.
  queue = result.then(
    () => {},
    () => {}
  );
  return result;
}

// Read the body as text first so a non-JSON response (an HTML error page)
// gives a clear message instead of a raw "Unexpected token <".
async function parseBricksetJson(res, context) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    const snippet = text.replace(/\s+/g, " ").trim().slice(0, 120);
    throw new Error(
      `Brickset ${context} returned a non-JSON response (HTTP ${res.status}). ` +
        `Response started: "${snippet}"`
    );
  }
}

// One POST, rate limited, with backoff on 429/503. Returns parsed JSON.
async function bricksetPost(path, params, context) {
  const maxRetries = 5;
  let backoff = 2000;

  for (let attempt = 0; ; attempt++) {
    const res = await scheduleBricksetCall(() =>
      fetch(`${API_URL}/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(params),
      })
    );

    if (res.status === 429 || res.status === 503) {
      await res.text().catch(() => {}); // drain the body
      if (attempt >= maxRetries) {
        throw new Error(
          `Brickset ${context} is rate limiting (HTTP ${res.status}). ` +
            `Wait a few minutes, then run again to resume.`
        );
      }
      const retryAfter = Number(res.headers.get("retry-after"));
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoff;
      await sleep(Math.min(waitMs, 60000));
      backoff = Math.min(backoff * 2, 30000);
      continue;
    }

    return parseBricksetJson(res, context);
  }
}

/* ---------------- LOGIN (cached) ---------------- */
async function login(apiKey, username, password) {
  const data = await bricksetPost("login", { apiKey, username, password }, "login");
  if (data.status !== "success") {
    throw new Error(`Brickset login failed: ${JSON.stringify(data)}`);
  }
  return data.hash;
}

async function getUserHash(apiKey, username, password, forceRefresh = false) {
  if (!forceRefresh && cachedHash && Date.now() - cachedHashAt < HASH_TTL_MS) {
    return cachedHash;
  }
  cachedHash = await login(apiKey, username, password);
  cachedHashAt = Date.now();
  return cachedHash;
}

// Turn a Brickset JSON error into a clear, correctly-typed Error.
function throwBricksetDataError(operation, message) {
  if (/api limit exceeded/i.test(message)) {
    throw new Error(
      `Brickset daily API limit reached (${operation}). This quota resets each day. ` +
        "Try again tomorrow, or reduce how much you sync at once."
    );
  }
  throw new Error(`Brickset ${operation} failed: ${message}`);
}

function throwGetSetsError(message) {
  throwBricksetDataError("getSets", message);
}

/* ---------------- getSets (single set) ---------------- */
async function fetchBricksetSet(apiKey, userHash, setNumber) {
  const data = await bricksetPost(
    "getSets",
    { apiKey, userHash, params: JSON.stringify({ setNumber, extendedData: 1 }) },
    "getSets"
  );
  if (data.status === "error") throwGetSetsError(data.message || JSON.stringify(data));
  if (!data.sets?.length) throw new Error(`Set not found: ${setNumber}`);
  return data.sets[0];
}

/* ---------------- ADDITIONAL IMAGES via setID ---------------- */
async function getAdditionalImages(apiKey, userHash, setID) {
  const data = await bricksetPost("getAdditionalImages", { apiKey, userHash, setID }, "getAdditionalImages");
  return data.additionalImages?.length ? data.additionalImages.map((i) => i.imageURL) : [];
}

/* ===============================================================
   EXPORT: MAIN FUNCTION used by import-products.server.js
=============================================================== */
export async function fetchSet(setNumber, env) {
  const { apiKey, username, password } = credsFromEnv(env);
  const userHash = await getUserHash(apiKey, username, password);

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
    set_num: `${s.number}-${s.numberVariant}`,
    set_num_clean: cleanSetNum,
    name: s.name,
    year: s.year ?? "",
    pieces: s.pieces ?? "",
    theme: s.theme ?? "",
    subtheme: s.subtheme ?? "",
    description: s.extendedData?.description ?? s.notes ?? "",
    bricksetURL: s.bricksetURL || "",
    // Both go onto the variant as typed barcodes (EAN-13 for UK/EU boxes,
    // UPC-A for North American boxes) so the till scans either box.
    ean: (s.barcode?.EAN || "").trim(),
    upc: (s.barcode?.UPC || "").trim(),
    gallery,
  };
}

/* ===============================================================
   BATCH BARCODE LOOKUP, used by the barcode backfill.
   getSets accepts a comma-delimited setNumber list; pageSize max 500,
   so one rate-limited call resolves up to 500 sets. Each returned set
   carries barcode: { EAN, UPC } (observed; either may be empty).
=============================================================== */
async function getSetsBatch(apiKey, username, password, batch) {
  // Two attempts: the second only if the first hash was rejected.
  for (let attempt = 0; attempt < 2; attempt++) {
    const userHash = await getUserHash(apiKey, username, password, attempt > 0);
    const data = await bricksetPost(
      "getSets",
      { apiKey, userHash, params: JSON.stringify({ setNumber: batch.join(","), pageSize: 500 }) },
      "getSets"
    );

    if (data.status === "error") {
      const message = data.message || "";
      if (/user hash/i.test(message) && attempt === 0) continue; // refresh + retry once
      throwGetSetsError(message);
    }

    return Array.isArray(data.sets) ? data.sets : [];
  }
  return [];
}

export async function fetchBarcodesForSetNumbers(setNumbers, env) {
  const { apiKey, username, password } = credsFromEnv(env);

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

/* ===============================================================
   MINIFIGURES

   Despite its name, getMinifigCollection returns catalogue data for ANY
   minifigure when given a `query`, not just ones this account owns. The
   ownedTotal fields simply come back as 0.

   Two quirks drive the lookup strategy below:
     1. `query` will not take a comma-delimited list. "sw0197,sw0308"
        matches nothing, so there is no true batch call.
     2. `query` prefix matches. "sw019" returns sw0190 through sw0199 in
        one call, so dropping the last character of each ID lets one
        request resolve up to ten neighbours.

   Minifigure IDs follow BrickLink's catalogue scheme (sw0197, hp001,
   col001, njo0500), which is what the storefront already uses.
=============================================================== */

// A prefix query can return the whole numeric neighbourhood of an ID.
// 100 leaves plenty of headroom over the ~10 we expect.
const MINIFIG_PAGE_SIZE = 100;

// Brickset minifigure categories use theme names that differ from the set
// themes already used as the product vendor. Align them so a City set and
// a City minifigure sit under the same vendor.
const THEME_ALIASES = new Map([
  ["town", "City"],
  ["ninjago", "Ninjago"],
]);

/**
 * Normalise a minifigure ID to Brickset's lowercase catalogue form.
 * "SW0197" and " sw0197 " both become "sw0197".
 * Returns "" for anything that is not a plausible minifigure ID, which is
 * how a pasted set number ("40760") gets rejected before it hits the API.
 * @param {unknown} rawId
 * @returns {string}
 */
export function normalizeMinifigId(rawId) {
  const id = String(rawId ?? "")
    .trim()
    .toLowerCase();
  return /^[a-z]{2,6}\d{1,5}[a-z]?$/.test(id) ? id : "";
}

/**
 * Group IDs so that one prefix query resolves several of them.
 * Dropping the last character of "sw0197" gives "sw019", which prefix
 * matches sw0190 to sw0199. Short IDs are queried whole.
 * @param {Array<string>} ids - already normalised
 * @returns {Map<string, Array<string>>} prefix -> IDs that share it
 */
export function groupIdsByPrefix(ids) {
  const groups = new Map();
  for (const id of ids || []) {
    const prefix = id.length > 3 ? id.slice(0, -1) : id;
    if (!groups.has(prefix)) groups.set(prefix, []);
    groups.get(prefix).push(id);
  }
  return groups;
}

/**
 * Split a Brickset minifigure category path into theme and subtheme.
 * The path varies in depth:
 *   "Star Wars / Star Wars The Clone Wars" -> Star Wars, Star Wars The Clone Wars
 *   "Town / City / Building"               -> City (aliased), Building
 *   "Collectible Minifigures"              -> Collectible Minifigures, ""
 * The first segment is the theme and the last is the most specific
 * subtheme. Internal whitespace is collapsed, which tidies Brickset's
 * double space in "Series  1 Minifigures".
 * @param {unknown} rawCategory
 * @returns {{theme: string, subtheme: string}}
 */
export function parseMinifigCategory(rawCategory) {
  const segments = String(rawCategory ?? "")
    .split("/")
    .map((part) => part.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  if (segments.length === 0) return { theme: "", subtheme: "" };

  return {
    theme: normalizeTheme(segments[0]),
    subtheme: segments.length > 1 ? segments[segments.length - 1] : "",
  };
}

/**
 * Map a Brickset minifigure theme onto the theme name used for sets.
 * Unknown themes pass through untouched.
 * @param {unknown} rawTheme
 * @returns {string}
 */
export function normalizeTheme(rawTheme) {
  const theme = String(rawTheme ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return THEME_ALIASES.get(theme.toLowerCase()) ?? theme;
}

/**
 * Build a lookup of normalised ID -> minifigure record from raw Brickset
 * minifig objects. First entry wins, so a prefix query's results are not
 * overwritten by a later exact query for the same ID.
 * @param {Array<object>} minifigs
 * @returns {Map<string, {id: string, sku: string, name: string, theme: string, subtheme: string}>}
 */
export function buildMinifigMap(minifigs) {
  const map = new Map();
  for (const m of minifigs || []) {
    const id = normalizeMinifigId(m?.minifigNumber);
    if (!id || map.has(id)) continue;

    const { theme, subtheme } = parseMinifigCategory(m?.category);
    map.set(id, {
      id,
      sku: id.toUpperCase(),
      name: String(m?.name ?? "").trim(),
      theme,
      subtheme,
    });
  }
  return map;
}

/* ---------------- getMinifigCollection (one query) ---------------- */
async function getMinifigCollectionQuery(apiKey, username, password, query) {
  // Two attempts: the second only if the first hash was rejected.
  for (let attempt = 0; attempt < 2; attempt++) {
    const userHash = await getUserHash(apiKey, username, password, attempt > 0);
    const data = await bricksetPost(
      "getMinifigCollection",
      { apiKey, userHash, params: JSON.stringify({ query, pageSize: MINIFIG_PAGE_SIZE }) },
      "getMinifigCollection"
    );

    if (data.status === "error") {
      const message = data.message || "";
      if (/user hash/i.test(message) && attempt === 0) continue; // refresh + retry once
      throwBricksetDataError("getMinifigCollection", message);
    }

    return Array.isArray(data.minifigs) ? data.minifigs : [];
  }
  return [];
}

/**
 * Resolve minifigure catalogue data for a list of IDs.
 * Pass 1 issues one prefix query per group and keeps every minifigure it
 * sees, so neighbours come back free. Pass 2 issues an exact query for
 * anything pass 1 did not resolve.
 *
 * Errors propagate. A rate limit or daily quota stop is a real stop, and
 * the caller imports in chunks so the run can be resumed.
 *
 * @param {Array<string>} ids - raw IDs as pasted
 * @param {Object} env - process.env
 * @returns {Promise<Map<string, object>>} normalised ID -> minifigure record
 */
export async function fetchMinifigs(ids, env) {
  const { apiKey, username, password } = credsFromEnv(env);

  const normalized = [...new Set((ids || []).map(normalizeMinifigId).filter(Boolean))];
  const found = new Map();
  if (normalized.length === 0) return found;

  // Pass 1: one call per prefix group, caching every minifigure returned.
  for (const prefix of groupIdsByPrefix(normalized).keys()) {
    const minifigs = await getMinifigCollectionQuery(apiKey, username, password, prefix);
    for (const [id, record] of buildMinifigMap(minifigs)) {
      if (!found.has(id)) found.set(id, record);
    }
  }

  // Pass 2: exact query for anything a prefix group missed.
  for (const id of normalized) {
    if (found.has(id)) continue;
    const minifigs = await getMinifigCollectionQuery(apiKey, username, password, id);
    for (const [foundId, record] of buildMinifigMap(minifigs)) {
      if (!found.has(foundId)) found.set(foundId, record);
    }
  }

  return found;
}
