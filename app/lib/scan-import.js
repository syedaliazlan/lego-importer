// app/lib/scan-import.js
//
// Checks for /api/scan-import, the endpoint the portal's staff scan page calls
// to add one set that is not on Shopify yet. Kept apart from the route so it
// can be tested without a server.

import { createHash, timingSafeEqual } from "node:crypto";

/** A shorter secret is treated as not set, so a placeholder can never open the endpoint. */
export const MIN_SECRET_LENGTH = 32;

/** A set number as the scan page sends it: 75313 or 75313-1. Nothing else is imported from here. */
const SET_NUMBER = /^\d{3,7}(-\d{1,2})?$/;

export function scanImportConfigured(secret) {
  return typeof secret === "string" && secret.length >= MIN_SECRET_LENGTH;
}

/**
 * True when the Authorization header carries the shared secret. Both sides are
 * hashed first so the comparison takes the same time whatever the lengths.
 */
export function secretMatches(authorizationHeader, secret) {
  if (!scanImportConfigured(secret)) return false;
  if (typeof authorizationHeader !== "string") return false;
  const m = /^Bearer (.+)$/.exec(authorizationHeader.trim());
  if (!m) return false;
  const given = createHash("sha256").update(m[1]).digest();
  const wanted = createHash("sha256").update(secret).digest();
  return timingSafeEqual(given, wanted);
}

/** The set number from the request body, or null if it is not one. */
export function parseScanSetNumber(body) {
  const raw = body && typeof body === "object" ? body.setNumber : null;
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  return SET_NUMBER.test(s) ? s : null;
}
