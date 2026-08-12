// app/routes/app.import-minifigs.jsx
//
// Imports ONE chunk of minifigures per request. The page component loops
// through chunks so a large paste never exceeds the request timeout.

/* global process */

import { authenticate } from "../shopify.server.js";
import { importMinifigs } from "../lib/import-minifigs.server.js";

export async function action({ request }) {
  try {
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
          message: "No minifigure IDs provided",
          importedCount: 0,
          totalRequested: 0,
          results: [],
        }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const result = await importMinifigs(auth, ids, process.env);

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Minifigure import error:", error);

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
