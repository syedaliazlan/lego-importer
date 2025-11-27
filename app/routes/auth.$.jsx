import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }) => {
  const url = new URL(request.url);
  console.log("[Auth] Route hit:", url.pathname);
  console.log("[Auth] Query params:", url.search);
  
  try {
    const result = await authenticate.admin(request);
    console.log("[Auth] Success - session should be stored now");
    return result;
  } catch (error) {
    console.error("[Auth] Error during authentication:", error);
    throw error;
  }
};

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
