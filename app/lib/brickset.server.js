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

  // Get main set info + setID
  const s = await fetchBricksetSet(apiKey, userHash, setNumber);

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
      console.log(`⚠ Additional images failed for ${setNumber}`);
    }
  }

  return {
    set_num: `${s.number}-${s.numberVariant}`,
    name: s.name,
    year: s.year ?? "",
    pieces: s.pieces ?? "",
    theme: s.theme ?? "",
    subtheme: s.subtheme ?? "",
    description: s.extendedData?.description ?? s.notes ?? "",
    bricksetURL: s.bricksetURL || "",
    gallery  // FULL IMAGE SET NOW WORKING
  };
}
