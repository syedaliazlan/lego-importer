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

// Turn a getSets JSON error into a clear, correctly-typed Error.
function throwGetSetsError(message) {
  if (/api limit exceeded/i.test(message)) {
    throw new Error(
      "Brickset daily API limit reached (getSets). This quota resets each day. " +
        "Try again tomorrow, or reduce how much you sync at once."
    );
  }
  throw new Error(`Brickset getSets failed: ${message}`);
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
    ean: (s.barcode?.EAN || "").trim(), // EAN-13 for Shopify POS barcode scanning
    upc: (s.barcode?.UPC || "").trim(), // US UPC; not written to Shopify (won't match UK/EU boxes)
    gallery,
  };
}

/* ===============================================================
   BATCH EAN LOOKUP, used by the barcode backfill.
   getSets accepts a comma-delimited setNumber list; pageSize max 500,
   so one rate-limited call resolves up to 500 sets.
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

export async function fetchEansForSetNumbers(setNumbers, env) {
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
