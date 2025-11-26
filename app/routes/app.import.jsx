// app/routes/app.import.jsx

import { authenticate } from "../shopify.server.js";
import { importSets } from "../lib/import-products.server.js";

export async function action({ request }) {
  try {
    // FIX: authenticate first (await it)
    const auth = await authenticate.admin(request);

    const formData = await request.formData();
    const rawIds = formData.get("ids") || "";

    const ids = rawIds
      .toString()
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean);

    if (ids.length === 0) {
      return new Response(
        JSON.stringify({
          ok: false,
          message: "No IDs provided",
          importedCount: 0,
          totalRequested: 0,
          results: [],
        }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    // FIX: pass the *resolved* auth, not the promise
    const result = await importSets(auth, ids, process.env);

    console.log("DEBUG action: importSets result", result);

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

  } catch (error) {
    console.error("Import error:", error);

    return new Response(
      JSON.stringify({
        ok: false,
        message: error?.message || "Unexpected server error",
        importedCount: 0,
        totalRequested: 0,
        results: [],
      }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}
