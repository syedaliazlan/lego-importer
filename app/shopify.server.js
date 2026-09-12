import "@shopify/shopify-app-react-router/adapters/node";
import {
  AppDistribution,
  shopifyApp,
} from "@shopify/shopify-app-react-router/server";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import prisma from "./db.server";

// Admin API 2026-10 is the first version with typed multi-barcodes
// (ProductVariant.barcodes / ProductVariantsBulkInput.barcodes), which the
// importer and the barcode backfill rely on. It is a release candidate until
// 1 October 2026 (shopify.dev/docs/api/usage/versioning).
//
// The installed @shopify/shopify-api (12.1.1, pulled in by
// @shopify/shopify-app-react-router 1.0.2) only enumerates up to
// ApiVersion.January26; October26 first appears in @shopify/shopify-api 14,
// which needs the 2.x line of shopify-app-react-router and new session
// storage majors. The library only uses the version as a plain "YYYY-MM"
// string (URL segment + numeric compare), so the string is passed directly
// rather than taking three major bumps for one enum member.
export const apiVersion = "2026-10";

const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
  apiVersion,
  scopes: process.env.SHOPIFY_API_SCOPES?.split(","),
  appUrl: process.env.SHOPIFY_APP_URL || "",
  authPathPrefix: "/auth",
  sessionStorage: new PrismaSessionStorage(prisma),
  distribution: AppDistribution.SingleMerchant,
  ...(process.env.SHOP_CUSTOM_DOMAIN
    ? { customShopDomains: [process.env.SHOP_CUSTOM_DOMAIN] }
    : {}),
});

export default shopify;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;
