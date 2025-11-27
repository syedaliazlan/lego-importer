import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }) => {
  const url = new URL(request.url);
  console.log("[Auth] Incoming request to:", url.pathname + url.search);
  
  try {
    const result = await authenticate.admin(request);
    console.log("[Auth] Authentication successful");
    return result;
  } catch (error) {
    console.error("[Auth] Authentication error:", error);
    console.error("[Auth] Error stack:", error.stack);
    throw error;
  }
};

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
