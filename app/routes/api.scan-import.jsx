// app/routes/api.scan-import.jsx
//
// POST /api/scan-import
//
// Called by the selling portal's staff scan page when a scanned set is not on
// Shopify: it imports ONE set exactly as the Import page would (Brickset data,
// images, barcodes, a DRAFT product stocked at every location at zero). The
// portal cannot do this itself because it has no write_publications scope.
//
// Not a Shopify-embedded request, so there is no session token: the portal
// proves itself with a shared secret (SCAN_IMPORT_SECRET, the same value on
// both Render services). With no secret set, the endpoint is closed.

/* global process */

import db from "../db.server.js";
import { unauthenticated } from "../shopify.server.js";
import { importSets } from "../lib/import-products.server.js";
import { parseScanSetNumber, scanImportConfigured, secretMatches } from "../lib/scan-import.js";

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

export async function loader() {
  return json({ ok: false, message: "Use POST." }, 405);
}

export async function action({ request }) {
  if (request.method !== "POST") return json({ ok: false, message: "Use POST." }, 405);

  const secret = process.env.SCAN_IMPORT_SECRET;
  if (!scanImportConfigured(secret)) {
    return json({ ok: false, message: "The importer is not set up for the scan page yet (SCAN_IMPORT_SECRET is not set)." }, 503);
  }
  if (!secretMatches(request.headers.get("authorization"), secret)) {
    return json({ ok: false, message: "Not allowed." }, 401);
  }

  let body = null;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  const setNumber = parseScanSetNumber(body);
  if (!setNumber) return json({ ok: false, message: "Send one set number, e.g. 75313." }, 400);

  // One store, one offline session: the same token the Import page uses.
  const session = await db.session.findFirst({ where: { isOnline: false }, select: { shop: true } });
  if (!session) return json({ ok: false, message: "The importer is not installed on the store." }, 503);

  try {
    console.log(`[scan-import] ${setNumber} requested by the scan page`);
    const result = await importSets(unauthenticated.admin(session.shop), [setNumber], process.env);
    return json(result);
  } catch (error) {
    console.error("[scan-import] failed:", error);
    return json({ ok: false, message: error?.message || "Unexpected server error", results: [] }, 500);
  }
}
