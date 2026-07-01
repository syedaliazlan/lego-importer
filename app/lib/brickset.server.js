// ===============================================================
// /app/lib/brickset.server.js
// FINAL — matches your proven Python script exactly
// ===============================================================

const API_URL = "https://brickset.com/api/v3.asmx";

/* ---------------- LOGIN — get userHash ---------------- */
async function login(apiKey, username, password) {
  const res = await fetch(`${API_URL}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ apiKey, username, password })
  });

  const data = await res.json();
  if (data.status !== "success") {
    throw new Error(`Brickset Login Failed: ${JSON.stringify(data)}`);
  }

  return data.hash;
}

/* ---------------- getSets (MUST have userHash) ---------------- */
async function fetchBricksetSet(apiKey, userHash, setNumber) {
  const res = await fetch(`${API_URL}/getSets`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      apiKey,
      userHash,
      params: JSON.stringify({
        setNumber,
        extendedData: 1
      })
    })
  });

  const data = await res.json();
  if (!data.sets?.length) throw new Error(`Set not found: ${setNumber}`);

  return data.sets[0]; // return the single set object
}

/* ---------------- ADDITIONAL IMAGES via setID ---------------- */
async function getAdditionalImages(apiKey, userHash, setID) {
  const res = await fetch(`${API_URL}/getAdditionalImages`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      apiKey,
      userHash,
      setID
    })
  });

  const data = await res.json();

  return data.additionalImages?.length ? data.additionalImages.map(i => i.imageURL) : [];
}

/* ===============================================================
   EXPORT — MAIN FUNCTION used by import-products.server.js
=============================================================== */
export async function fetchSet(setNumber, env) {
  const apiKey = env.BRICKSET_API_KEY;
  const username = env.BRICKSET_USERNAME;
  const password = env.BRICKSET_PASSWORD;

  if (!apiKey || !username || !password) {
    throw new Error("Missing BRICKSET_API_KEY / USERNAME / PASSWORD in .env");
  }

  // AUTH LIKE YOUR PYTHON SCRIPT
  const userHash = await login(apiKey, username, password);

  // Normalize set number: if it doesn't end with -1, add it for API call
  // This allows users to input with or without -1
  let normalizedSetNumber = setNumber.trim();
  if (!normalizedSetNumber.endsWith('-1')) {
    normalizedSetNumber = `${normalizedSetNumber}-1`;
  }

  // Get main set info + setID
  const s = await fetchBricksetSet(apiKey, userHash, normalizedSetNumber);

  const setID = s.setID; // <-- CRITICAL FIX
  let gallery = [];

  // Add main image first
  if (s.image?.imageURL) gallery.push(s.image.imageURL);

  // Fetch additional images using setID (not setNumber)
  if (setID) {
    try {
      const extraImages = await getAdditionalImages(apiKey, userHash, setID);
      gallery = [...new Set([...gallery, ...extraImages])];
    } catch {
    }
  }

  // Return set_num without -1 for display (clean version)
  const cleanSetNum = s.number; // Just the number part, no variant
  
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
    ean: (s.barcode?.EAN || "").trim(),  // EAN-13 for Shopify POS barcode scanning
    upc: (s.barcode?.UPC || "").trim(),  // US UPC; captured but not written to Shopify (won't match UK/EU boxes)
    gallery  // FULL IMAGE SET NOW WORKING
  };
}

/* ===============================================================
   BATCH EAN LOOKUP — used by the barcode backfill
   getSets accepts a comma-delimited setNumber list; pageSize max 500.
   Returns the raw Brickset set objects (each has .number and .barcode.EAN).
=============================================================== */
export async function fetchEansForSetNumbers(setNumbers, env) {
  const apiKey = env.BRICKSET_API_KEY;
  const username = env.BRICKSET_USERNAME;
  const password = env.BRICKSET_PASSWORD;

  if (!apiKey || !username || !password) {
    throw new Error("Missing BRICKSET_API_KEY / USERNAME / PASSWORD in .env");
  }

  // De-duplicate; a single Shopify page can repeat set numbers across variants.
  const unique = [...new Set((setNumbers || []).filter(Boolean))];
  if (unique.length === 0) return [];

  // One login per call; reuse the userHash across all batches.
  const userHash = await login(apiKey, username, password);

  const sets = [];
  for (let i = 0; i < unique.length; i += 500) {
    const batch = unique.slice(i, i + 500);

    const res = await fetch(`${API_URL}/getSets`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        apiKey,
        userHash,
        params: JSON.stringify({
          setNumber: batch.join(","),
          pageSize: 500,
        }),
      }),
    });

    const data = await res.json();
    if (data.status && data.status !== "success") {
      throw new Error(`Brickset getSets failed: ${JSON.stringify(data)}`);
    }
    if (Array.isArray(data.sets)) sets.push(...data.sets);
  }

  return sets;
}
