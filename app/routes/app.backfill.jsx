// app/routes/app.backfill.jsx
//
// Backfill EAN and UPC barcodes onto existing products (Admin API 2026-10,
// typed multi-barcodes). A merge: what a variant already has is kept, and
// whatever Brickset knows and the variant lacks is added with its type.
// The action processes ONE page ("chunk") of the catalogue per request; the
// page component loops through chunks (following the returned cursor) so a
// large catalogue is processed without any single request timing out.

/* eslint-disable react/prop-types */
/* global process */

import { useEffect, useMemo, useRef, useState } from "react";
import { useFetcher } from "react-router";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server.js";
import { backfillChunk } from "../lib/backfill-barcodes.server.js";
import { applyBarcodeCsvChunk } from "../lib/barcode-csv-apply.server.js";
import { MAX_CSV_BYTES, MAX_CSV_ROWS } from "../lib/barcode-csv.js";

export async function action({ request }) {
  try {
    const { admin } = await authenticate.admin(request);

    const formData = await request.formData();
    const mode = formData.get("mode") === "commit" ? "commit" : "preview";

    // Second card: a hand-filled CSV of barcodes, processed a chunk of rows
    // per request. The parse re-checks the size limit before anything else.
    if (formData.get("intent") === "csv") {
      const csv = String(formData.get("csv") ?? "");
      const offset = Number(formData.get("offset")) || 0;
      const result = await applyBarcodeCsvChunk(admin, { csv, offset, mode });
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    const cursor = formData.get("cursor") || null;

    const result = await backfillChunk(admin, process.env, { cursor, mode, pageSize: 100 });

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Backfill error:", error);
    return new Response(
      JSON.stringify({ error: error?.message || "Unexpected server error", done: true, nextCursor: null }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}

const emptyTotals = () => ({
  chunks: 0,
  processed: 0,
  updated: 0,
  wouldUpdate: 0,
  unchanged: 0,
  skipped: 0,
  barcodesAdded: 0,
  barcodesRetyped: 0,
  noBricksetData: [],
  notFound: [],
  notAdded: [],
  errors: [],
});

function mergeTotals(t, d) {
  return {
    chunks: t.chunks + 1,
    processed: t.processed + (d.processed || 0),
    updated: t.updated + (d.updated || 0),
    wouldUpdate: t.wouldUpdate + (d.wouldUpdate || 0),
    unchanged: t.unchanged + (d.unchanged || 0),
    skipped: t.skipped + (d.skipped || 0),
    barcodesAdded: t.barcodesAdded + (d.barcodesAdded || 0),
    barcodesRetyped: t.barcodesRetyped + (d.barcodesRetyped || 0),
    noBricksetData: t.noBricksetData.concat(d.noBricksetData || []),
    notFound: t.notFound.concat(d.notFound || []),
    notAdded: t.notAdded.concat(d.notAdded || []),
    errors: t.errors.concat(d.errors || []),
  };
}

const card = {
  background: "white",
  borderRadius: 8,
  padding: 24,
  boxShadow: "0 1px 3px rgba(0,0,0,0.06)",
};

const buttonBase = {
  padding: "10px 20px",
  borderRadius: 6,
  fontWeight: 600,
  border: "none",
};

function csvEscape(value) {
  const s = String(value ?? "");
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// Build a CSV in the browser and hand it to the user as a download.
// Prepends a UTF-8 BOM so Excel opens accented product names correctly.
function downloadCsv(filename, header, rows) {
  const lines = rows.map((r) => r.map(csvEscape).join(","));
  const csv = [header.join(","), ...lines].join("\r\n");
  const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export default function BackfillBarcodes() {
  const fetcher = useFetcher();
  const [totals, setTotals] = useState(emptyTotals);
  const [running, setRunning] = useState(false);
  const [mode, setMode] = useState("preview");

  const [canResume, setCanResume] = useState(false);

  const stopRef = useRef(false);
  const modeRef = useRef("preview");
  const handledRef = useRef(null); // dedupe: last fetcher.data object we processed
  const attemptCursorRef = useRef(""); // cursor of the chunk currently in flight
  const resumeCursorRef = useRef(null); // where to carry on from after a stop or error

  function submitChunk(cursor) {
    attemptCursorRef.current = cursor || "";
    const fd = new FormData();
    fd.set("mode", modeRef.current);
    fd.set("cursor", cursor || "");
    fetcher.submit(fd, { method: "post", action: "/app/backfill" });
  }

  function start(selectedMode) {
    stopRef.current = false;
    modeRef.current = selectedMode;
    handledRef.current = null;
    resumeCursorRef.current = null;
    setCanResume(false);
    setMode(selectedMode);
    setTotals(emptyTotals());
    setRunning(true);
    submitChunk("");
  }

  function resume() {
    stopRef.current = false;
    handledRef.current = null;
    setCanResume(false);
    setRunning(true);
    submitChunk(resumeCursorRef.current || "");
  }

  function stop() {
    stopRef.current = true;
  }

  useEffect(() => {
    const data = fetcher.data;
    if (!data) return;
    if (fetcher.state !== "idle") return;
    if (handledRef.current === data) return; // process each response once
    handledRef.current = data;

    if (data.error) {
      // The in-flight chunk failed; let the user resume from the same point.
      resumeCursorRef.current = attemptCursorRef.current;
      setCanResume(true);
      setRunning(false);
      return;
    }

    setTotals((t) => mergeTotals(t, data));

    if (data.done || !data.nextCursor) {
      resumeCursorRef.current = null;
      setCanResume(false);
      setRunning(false);
      return;
    }
    if (stopRef.current) {
      resumeCursorRef.current = data.nextCursor;
      setCanResume(true);
      setRunning(false);
      return;
    }
    // Small gap between chunks to stay gentle on the Brickset API.
    const timer = setTimeout(() => {
      if (stopRef.current) {
        resumeCursorRef.current = data.nextCursor;
        setCanResume(true);
        setRunning(false);
        return;
      }
      submitChunk(data.nextCursor);
    }, 400);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher.data, fetcher.state]);

  const updatedLabel = mode === "commit" ? "Products updated" : "Products to update";
  const updatedValue = mode === "commit" ? totals.updated : totals.wouldUpdate;
  const hasRun = totals.chunks > 0;
  const lastError = fetcher.data?.error;

  const flagged = useMemo(() => {
    const has = (r) => (r.existingCount ? `, already has ${r.existingCount}` : ", has none");
    const rows = [];
    for (const r of totals.noBricksetData) {
      rows.push({ setNumber: r.setNumber, productName: r.productName, reason: `No barcode in Brickset${has(r)}` });
    }
    for (const r of totals.notFound) {
      rows.push({ setNumber: r.setNumber, productName: r.productName, reason: `Not found on Brickset${has(r)}` });
    }
    for (const r of totals.notAdded) {
      rows.push({
        setNumber: r.sku,
        productName: "",
        reason: `${r.type || "Barcode"} ${r.value} not added: ${r.reason}`,
      });
    }
    return rows;
  }, [totals.noBricksetData, totals.notFound, totals.notAdded]);

  const flaggedDisplay = useMemo(() => {
    if (!flagged.length) return "None";
    const lines = flagged.map(
      (r) => `${String(r.setNumber).padEnd(12)} ${r.productName} (${r.reason})`
    );
    return ["Set number   Product name (reason)", ...lines].join("\n");
  }, [flagged]);

  function downloadFlaggedCsv() {
    // EAN, UPC and GTIN columns are included empty so the file can be filled
    // in and uploaded straight back through "Add barcodes from a CSV".
    downloadCsv(
      "barcode-backfill-flagged-sets.csv",
      ["Set Number", "Product Name", "Reason", "EAN", "UPC", "GTIN"],
      flagged.map((r) => [r.setNumber, r.productName, r.reason, "", "", ""])
    );
  }

  return (
    <s-page>
      <TitleBar title="Backfill barcodes" />

      <div style={{ maxWidth: 800, margin: "24px auto", display: "flex", flexDirection: "column", gap: 24 }}>
        <section style={card}>
          <h1 style={{ fontSize: 22, fontWeight: 600, marginBottom: 10 }}>Backfill EAN and UPC barcodes</h1>
          <p style={{ marginBottom: 8, color: "#444" }}>
            Goes through your existing products, matches each one to its Brickset set by SKU, and adds every
            barcode Brickset has for it, each with its type (EAN for UK and EU boxes, UPC for North American
            boxes), so the till scans whichever box is on the counter. Barcodes already on a product are kept
            exactly as they are; only missing ones are added, so it is safe to run more than once. A product
            that already has its EAN still gets its UPC.
          </p>
          <p style={{ marginBottom: 20, color: "#444" }}>
            Run <strong>Preview</strong> first to see what would change and get the list of sets Brickset has no
            barcode for. Nothing is written until you choose <strong>Run backfill</strong>. Needs Shopify Admin
            API 2026-10, the first version with typed multi-barcodes.
          </p>

          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            <button
              type="button"
              onClick={() => start("preview")}
              disabled={running}
              style={{
                padding: "10px 20px",
                backgroundColor: "white",
                color: "#008060",
                border: "1px solid #008060",
                borderRadius: 6,
                fontWeight: 600,
                cursor: running ? "not-allowed" : "pointer",
              }}
            >
              Preview (no changes)
            </button>

            <button
              type="button"
              onClick={() => start("commit")}
              disabled={running}
              style={{
                padding: "10px 20px",
                backgroundColor: "#008060",
                color: "white",
                border: "none",
                borderRadius: 6,
                fontWeight: 600,
                cursor: running ? "not-allowed" : "pointer",
              }}
            >
              Run backfill
            </button>

            {!running && canResume && (
              <button
                type="button"
                onClick={resume}
                style={{
                  padding: "10px 20px",
                  backgroundColor: "#005bd3",
                  color: "white",
                  border: "none",
                  borderRadius: 6,
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                Resume from where it stopped
              </button>
            )}

            {running && (
              <button
                type="button"
                onClick={stop}
                style={{
                  padding: "10px 20px",
                  backgroundColor: "#b83c3c",
                  color: "white",
                  border: "none",
                  borderRadius: 6,
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                Stop after this page
              </button>
            )}
          </div>

          {running && (
            <p style={{ marginTop: 16, fontSize: 13, color: "#555" }}>
              {mode === "commit" ? "Backfilling" : "Previewing"}… {totals.processed} products scanned across{" "}
              {totals.chunks} page(s).
            </p>
          )}
        </section>

        {(hasRun || lastError) && (
          <section style={card}>
            <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 12 }}>
              {mode === "commit" ? "Backfill results" : "Preview results"}
              {running ? " (in progress)" : ""}
            </h2>

            {lastError && (
              <p style={{ color: "#b83c3c", marginBottom: 12 }}>
                Stopped: {lastError} Click Resume to carry on from where it stopped, without redoing what is
                already done.
              </p>
            )}

            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12, marginBottom: 16 }}>
              <Stat label="Scanned" value={totals.processed} />
              <Stat label={updatedLabel} value={updatedValue} highlight />
              <Stat
                label={mode === "commit" ? "Barcodes added" : "Barcodes to add"}
                value={totals.barcodesAdded}
                highlight
              />
              <Stat label="Already complete" value={totals.unchanged} />
              <Stat label="No barcode in Brickset" value={totals.noBricksetData.length} />
              <Stat label="Not found on Brickset" value={totals.notFound.length} />
              <Stat label="Skipped (non-set SKU)" value={totals.skipped} />
              <Stat
                label={mode === "commit" ? "Existing barcodes given a type" : "Existing barcodes to give a type"}
                value={totals.barcodesRetyped}
              />
            </div>

            {totals.errors.length > 0 && (
              <p style={{ color: "#b83c3c", marginBottom: 12 }}>
                {totals.errors.length} write error(s). First: {totals.errors[0].sku}: {totals.errors[0].message}
              </p>
            )}

            {flagged.length > 0 && (
              <div>
                <p style={{ color: "#444", marginBottom: 8 }}>
                  {totals.noBricksetData.length} set(s) have no barcode in Brickset and {totals.notFound.length}{" "}
                  SKU(s) were not found on Brickset. Download the list to review the sets that could not be
                  matched to a barcode automatically.
                </p>
                <button
                  type="button"
                  onClick={downloadFlaggedCsv}
                  style={{
                    padding: "8px 16px",
                    backgroundColor: "#f4f4f4",
                    color: "#333",
                    border: "1px solid #ccc",
                    borderRadius: 6,
                    fontWeight: 600,
                    cursor: "pointer",
                    marginBottom: 12,
                  }}
                >
                  Download flagged list (.csv)
                </button>
                <pre
                  style={{
                    maxHeight: 220,
                    overflow: "auto",
                    background: "#fafafa",
                    border: "1px solid #eee",
                    borderRadius: 6,
                    padding: 12,
                    fontSize: 12,
                    whiteSpace: "pre-wrap",
                  }}
                >
                  {flaggedDisplay}
                </pre>
              </div>
            )}
          </section>
        )}

        <CsvUploadCard />
      </div>
    </s-page>
  );
}

/* ===============================================================
   CARD 2: add barcodes from a CSV
=============================================================== */

const OUTCOME_LABEL = {
  added: { preview: "Would add", commit: "Added" },
  unchanged: { preview: "Already on product", commit: "Already on product" },
  notFound: { preview: "Not found", commit: "Not found" },
  ambiguous: { preview: "Ambiguous", commit: "Ambiguous" },
  invalid: { preview: "Invalid row", commit: "Invalid row" },
  duplicate: { preview: "Duplicate", commit: "Duplicate" },
  error: { preview: "Error", commit: "Error" },
};

const OK_OUTCOMES = new Set(["added", "unchanged"]);

function outcomeLabel(outcome, mode) {
  return OUTCOME_LABEL[outcome]?.[mode] || outcome;
}

function rowDetail(r) {
  const parts = [];
  if (r.added?.length) parts.push(r.added.join(", "));
  if (r.retyped?.length) parts.push(`type set on ${r.retyped.join(", ")}`);
  if (r.outcome === "unchanged") parts.push(r.requested?.length ? `${r.requested.join(", ")} already there` : "");
  if (r.notAdded?.length) parts.push(r.notAdded.join("; "));
  if (r.error) parts.push(r.error);
  return parts.filter(Boolean).join(". ");
}

function CsvUploadCard() {
  const fetcher = useFetcher();
  const [fileName, setFileName] = useState("");
  const [fileError, setFileError] = useState("");
  const [hasFile, setHasFile] = useState(false);
  const [mode, setMode] = useState("preview");
  const [running, setRunning] = useState(false);
  const [rows, setRows] = useState([]);
  const [totalRows, setTotalRows] = useState(0);
  const [ignoredColumns, setIgnoredColumns] = useState([]);
  const [runError, setRunError] = useState("");

  const textRef = useRef(""); // the file's text, re-sent with every chunk
  const modeRef = useRef("preview");
  const stopRef = useRef(false);
  const handledRef = useRef(null);

  async function onFileChange(event) {
    const file = event.target.files?.[0];
    setRows([]);
    setRunError("");
    setFileError("");
    setTotalRows(0);
    if (!file) {
      setFileName("");
      setHasFile(false);
      textRef.current = "";
      return;
    }
    setFileName(file.name);
    if (file.size > MAX_CSV_BYTES) {
      setFileError(`${file.name} is ${Math.ceil(file.size / 1024)} KB; the limit is ${MAX_CSV_BYTES / 1024} KB.`);
      setHasFile(false);
      textRef.current = "";
      return;
    }
    try {
      textRef.current = await file.text();
      setHasFile(true);
    } catch (err) {
      setFileError(`Could not read ${file.name}: ${err?.message || "unknown error"}`);
      setHasFile(false);
      textRef.current = "";
    }
  }

  function submitChunk(offset) {
    const fd = new FormData();
    fd.set("intent", "csv");
    fd.set("mode", modeRef.current);
    fd.set("offset", String(offset));
    fd.set("csv", textRef.current);
    fetcher.submit(fd, { method: "post", action: "/app/backfill" });
  }

  function start(selectedMode) {
    stopRef.current = false;
    modeRef.current = selectedMode;
    handledRef.current = null;
    setMode(selectedMode);
    setRows([]);
    setRunError("");
    setTotalRows(0);
    setRunning(true);
    submitChunk(0);
  }

  function stop() {
    stopRef.current = true;
  }

  useEffect(() => {
    const data = fetcher.data;
    if (!data) return;
    if (fetcher.state !== "idle") return;
    if (handledRef.current === data) return;
    handledRef.current = data;

    if (data.error) {
      setRunError(data.error);
      setRunning(false);
      return;
    }

    setTotalRows(data.totalRows || 0);
    setIgnoredColumns(data.ignoredColumns || []);
    setRows((r) => r.concat(data.results || []));

    if (data.done || data.nextOffset == null || stopRef.current) {
      setRunning(false);
      return;
    }
    const timer = setTimeout(() => submitChunk(data.nextOffset), 150);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher.data, fetcher.state]);

  const counts = useMemo(() => {
    const c = { added: 0, unchanged: 0, notFound: 0, ambiguous: 0, invalid: 0, duplicate: 0, error: 0, found: 0 };
    for (const r of rows) {
      if (r.outcome in c) c[r.outcome]++;
      if (r.found) c.found++;
    }
    return c;
  }, [rows]);

  const failedRows = useMemo(
    () => rows.filter((r) => !OK_OUTCOMES.has(r.outcome) || (r.notAdded && r.notAdded.length)),
    [rows]
  );

  function downloadFailedCsv() {
    downloadCsv(
      "barcode-csv-not-applied.csv",
      ["Line", "Set Number", "EAN", "UPC", "GTIN", "Result", "Detail"],
      failedRows.map((r) => [
        r.line,
        r.setNumber,
        r.raw?.ean || "",
        r.raw?.upc || "",
        r.raw?.gtin || "",
        outcomeLabel(r.outcome, mode),
        rowDetail(r),
      ])
    );
  }

  const hasRun = rows.length > 0 || Boolean(runError);
  const problems = counts.notFound + counts.ambiguous + counts.invalid + counts.duplicate + counts.error;

  return (
    <>
      <section style={card}>
        <h2 style={{ fontSize: 20, fontWeight: 600, marginBottom: 10 }}>Add barcodes from a CSV</h2>
        <p style={{ marginBottom: 8, color: "#444" }}>
          For the sets Brickset has no barcode for. Fill in the flagged list above (or any CSV) with the
          barcodes from the box or barcodelookup.com and upload it. Columns: <strong>Set Number</strong>,{" "}
          <strong>EAN</strong> (13 or 8 digits), <strong>UPC</strong> (12 digits), and optionally{" "}
          <strong>GTIN</strong> (14 digits). Column names are not case sensitive, any other column (Product
          Name, Reason) is ignored, and spaces or dashes inside a barcode are fine.
        </p>
        <p style={{ marginBottom: 8, color: "#444" }}>
          Barcodes are added to what the product already has; nothing is removed or duplicated, so a file can
          be uploaded again safely. A bad value (wrong length or check digit) only skips that row. If a set
          number appears twice, the last row is used. Limits: {MAX_CSV_BYTES / 1024} KB and{" "}
          {MAX_CSV_ROWS.toLocaleString()} rows.
        </p>
        <p style={{ marginBottom: 20, color: "#444" }}>
          If the spreadsheet shows a barcode as something like 5.70202E+12, format that column as Text and
          paste the full number, otherwise the digits are lost.
        </p>

        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center", marginBottom: 16 }}>
          <label htmlFor="barcode-csv-file" style={{ fontWeight: 600, fontSize: 14 }}>
            CSV file
          </label>
          <input
            id="barcode-csv-file"
            type="file"
            accept=".csv,text/csv,text/plain"
            onChange={onFileChange}
            disabled={running}
          />
        </div>

        {fileError && <p style={{ color: "#b83c3c", marginBottom: 12 }}>{fileError}</p>}

        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <button
            type="button"
            onClick={() => start("preview")}
            disabled={running || !hasFile}
            style={{
              ...buttonBase,
              backgroundColor: "white",
              color: "#008060",
              border: "1px solid #008060",
              cursor: running || !hasFile ? "not-allowed" : "pointer",
              opacity: hasFile ? 1 : 0.6,
            }}
          >
            Preview CSV (no changes)
          </button>

          <button
            type="button"
            onClick={() => start("commit")}
            disabled={running || !hasFile}
            style={{
              ...buttonBase,
              backgroundColor: "#008060",
              color: "white",
              cursor: running || !hasFile ? "not-allowed" : "pointer",
              opacity: hasFile ? 1 : 0.6,
            }}
          >
            Apply CSV
          </button>

          {running && (
            <button
              type="button"
              onClick={stop}
              style={{ ...buttonBase, backgroundColor: "#b83c3c", color: "white", cursor: "pointer" }}
            >
              Stop after this batch
            </button>
          )}
        </div>

        {running && (
          <p style={{ marginTop: 16, fontSize: 13, color: "#555" }}>
            {mode === "commit" ? "Applying" : "Previewing"} {fileName}… {rows.length}
            {totalRows ? ` of ${totalRows}` : ""} rows done.
          </p>
        )}
      </section>

      {hasRun && (
        <section style={card}>
          <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 12 }}>
            {mode === "commit" ? "CSV results" : "CSV preview"}
            {running ? " (in progress)" : ""}
            {fileName ? ` for ${fileName}` : ""}
          </h2>

          {runError && (
            <p style={{ color: "#b83c3c", marginBottom: 12 }}>
              Stopped: {runError}
              {rows.length ? " The rows below were processed before it stopped." : ""}
            </p>
          )}

          {ignoredColumns.length > 0 && (
            <p style={{ color: "#666", fontSize: 13, marginBottom: 12 }}>
              Ignored column(s): {ignoredColumns.join(", ")}.
            </p>
          )}

          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12, marginBottom: 16 }}>
            <Stat label="Rows" value={totalRows || rows.length} />
            <Stat label="Products found" value={counts.found} />
            <Stat label={mode === "commit" ? "Products updated" : "Products to update"} value={counts.added} highlight />
            <Stat label="Already on product" value={counts.unchanged} />
            <Stat label="Not found" value={counts.notFound + counts.ambiguous} />
            <Stat label="Invalid or duplicate rows" value={counts.invalid + counts.duplicate} />
            {counts.error > 0 && <Stat label="Errors" value={counts.error} />}
          </div>

          {failedRows.length > 0 && (
            <div style={{ marginBottom: 12 }}>
              <p style={{ color: "#444", marginBottom: 8 }}>
                {problems} row(s) were not applied. Download them, fix the file and upload it again; rows that
                already went through will show as already on the product.
              </p>
              <button
                type="button"
                onClick={downloadFailedCsv}
                style={{
                  padding: "8px 16px",
                  backgroundColor: "#f4f4f4",
                  color: "#333",
                  border: "1px solid #ccc",
                  borderRadius: 6,
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                Download rows not applied (.csv)
              </button>
            </div>
          )}

          {rows.length > 0 && (
            <div style={{ maxHeight: 360, overflow: "auto", border: "1px solid #eee", borderRadius: 6 }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <thead>
                  <tr style={{ background: "#fafafa" }}>
                    <th style={th}>Line</th>
                    <th style={th}>Set number</th>
                    <th style={th}>Found</th>
                    <th style={th}>Result</th>
                    <th style={th}>Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.line}>
                      <td style={td}>{r.line}</td>
                      <td style={td}>{r.setNumber || "-"}</td>
                      <td style={td}>
                        {r.found ? (
                          <>
                            Yes{r.productTitle ? <span style={{ color: "#777" }}> ({r.productTitle})</span> : null}
                          </>
                        ) : r.outcome === "invalid" || r.outcome === "duplicate" ? (
                          "-"
                        ) : (
                          "No"
                        )}
                      </td>
                      <td style={{ ...td, color: OK_OUTCOMES.has(r.outcome) ? "#1f6b45" : "#8a1f1f", whiteSpace: "nowrap" }}>
                        {outcomeLabel(r.outcome, mode)}
                      </td>
                      <td style={td}>{rowDetail(r) || "-"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </>
  );
}

const th = { padding: 6, borderBottom: "1px solid #eee", textAlign: "left", position: "sticky", top: 0, background: "#fafafa" };
const td = { padding: 6, borderBottom: "1px solid #f3f3f3", verticalAlign: "top" };

function Stat({ label, value, highlight }) {
  return (
    <div
      style={{
        border: "1px solid #eee",
        borderRadius: 8,
        padding: 12,
        background: highlight ? "#f0faf6" : "white",
      }}
    >
      <div style={{ fontSize: 24, fontWeight: 700, color: highlight ? "#008060" : "#222" }}>{value}</div>
      <div style={{ fontSize: 12, color: "#666" }}>{label}</div>
    </div>
  );
}
