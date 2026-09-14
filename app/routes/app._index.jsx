// app/routes/app._index.jsx
//
// Two importers behind one toggle.
//
// Sets post in a single request, as they always have. Minifigures post in
// chunks: Brickset allows one request per second, so a large paste in one
// request would exceed the platform timeout. Chunking also means the
// minifigure progress bar reflects real progress rather than a simulation.

/* eslint-disable react/prop-types */

import { useFetcher } from "react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { TitleBar } from "@shopify/app-bridge-react";

const MINIFIG_CHUNK_SIZE = 25;

const card = {
  background: "white",
  borderRadius: 8,
  padding: 24,
  boxShadow: "0 1px 3px rgba(0,0,0,0.06)",
};

const textarea = {
  width: "100%",
  fontSize: 14,
  padding: 10,
  borderRadius: 6,
  border: "1px solid #ccc",
  marginBottom: 12,
  fontFamily: "inherit",
};

function primaryButton(disabled) {
  return {
    padding: "10px 20px",
    backgroundColor: disabled ? "#9bbfb2" : "#008060",
    color: "white",
    borderRadius: 6,
    border: "none",
    fontWeight: 600,
    cursor: disabled ? "not-allowed" : "pointer",
  };
}

const secondaryButton = {
  padding: "10px 20px",
  background: "white",
  color: "#333",
  borderRadius: 6,
  border: "1px solid #ccc",
  fontWeight: 600,
  cursor: "pointer",
  marginLeft: 8,
};

function tabButton(active) {
  return {
    padding: "8px 16px",
    background: active ? "#008060" : "white",
    color: active ? "white" : "#444",
    border: `1px solid ${active ? "#008060" : "#ccc"}`,
    borderRadius: 6,
    fontWeight: 600,
    cursor: "pointer",
  };
}

function ProgressBar({ percent }) {
  return (
    <div style={{ height: 10, background: "#e5e5e5", borderRadius: 4, overflow: "hidden" }}>
      <div
        style={{
          height: "100%",
          width: `${Math.min(100, Math.max(0, percent))}%`,
          background: "#008060",
          transition: "width 0.4s ease",
        }}
      />
    </div>
  );
}

function parseIds(raw) {
  return String(raw || "")
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const emptyMinifigRun = () => ({
  running: false,
  total: 0,
  processed: 0,
  importedCount: 0,
  results: [],
  error: null,
  canResume: false,
});

export default function LegoImporterIndex() {
  const [mode, setMode] = useState("sets");

  /* ---------------- sets: one request ---------------- */
  const setsFetcher = useFetcher();
  const [setsInput, setSetsInput] = useState("");
  const setsSubmitting = setsFetcher.state === "submitting" || setsFetcher.state === "loading";

  // Sets have no per-item progress signal, so the bar is simulated.
  const [fakeProgress, setFakeProgress] = useState(0);
  useEffect(() => {
    if (!setsSubmitting) {
      setFakeProgress(100);
      return undefined;
    }
    setFakeProgress(0);
    const interval = setInterval(() => {
      setFakeProgress((p) => (p >= 90 ? 90 : p + Math.random() * 15));
    }, 400);
    return () => clearInterval(interval);
  }, [setsSubmitting]);

  /* ---------------- minifigures: chunked loop ---------------- */
  const minifigFetcher = useFetcher();
  const [minifigInput, setMinifigInput] = useState("");
  const [run, setRun] = useState(emptyMinifigRun);

  const stopRef = useRef(false);
  const handledRef = useRef(null); // dedupe: last response object processed
  const queueRef = useRef([]); // every ID in this run
  const attemptStartRef = useRef(0); // index the in-flight chunk started at
  const resumeIndexRef = useRef(0); // where to carry on from after a stop or error

  function submitChunk(startIndex) {
    attemptStartRef.current = startIndex;
    const chunk = queueRef.current.slice(startIndex, startIndex + MINIFIG_CHUNK_SIZE);
    const fd = new FormData();
    fd.set("ids", chunk.join("\n"));
    minifigFetcher.submit(fd, { method: "post", action: "/app/import-minifigs" });
  }

  function startMinifigs() {
    const ids = parseIds(minifigInput);
    if (ids.length === 0) return;

    stopRef.current = false;
    handledRef.current = null;
    queueRef.current = ids;
    resumeIndexRef.current = 0;
    setRun({ ...emptyMinifigRun(), running: true, total: ids.length });
    submitChunk(0);
  }

  function resumeMinifigs() {
    stopRef.current = false;
    handledRef.current = null;
    setRun((r) => ({ ...r, running: true, error: null, canResume: false }));
    submitChunk(resumeIndexRef.current);
  }

  function stopMinifigs() {
    stopRef.current = true;
  }

  useEffect(() => {
    const data = minifigFetcher.data;
    if (!data) return;
    if (minifigFetcher.state !== "idle") return;
    if (handledRef.current === data) return; // process each response once
    handledRef.current = data;

    // A chunk-wide failure (rate limit, quota, auth). Every row carries the
    // same error, so record the message rather than 25 duplicate rows, and
    // let the user resume from the chunk that failed.
    if (data.ok === false) {
      resumeIndexRef.current = attemptStartRef.current;
      setRun((r) => ({
        ...r,
        running: false,
        canResume: true,
        error: data.message || "Import failed",
      }));
      return;
    }

    const rows = data.results || [];
    setRun((r) => ({
      ...r,
      processed: r.processed + rows.length,
      importedCount: r.importedCount + (data.importedCount || 0),
      results: r.results.concat(rows),
    }));

    const next = attemptStartRef.current + MINIFIG_CHUNK_SIZE;
    resumeIndexRef.current = next;

    if (next >= queueRef.current.length) {
      setRun((r) => ({ ...r, running: false, canResume: false }));
      return;
    }

    if (stopRef.current) {
      setRun((r) => ({ ...r, running: false, canResume: true }));
      return;
    }

    submitChunk(next);
    // submitChunk is recreated each render but reads everything from refs;
    // including it here would restart the loop on every state update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [minifigFetcher.data, minifigFetcher.state]);

  /* ---------------- shared result view ---------------- */
  const isMinifigs = mode === "minifigs";
  const setsResult = setsFetcher.data;

  const result = useMemo(() => {
    if (isMinifigs) {
      if (run.total === 0) return null;
      return { importedCount: run.importedCount, totalRequested: run.total, results: run.results };
    }
    return setsResult || null;
  }, [isMinifigs, run, setsResult]);

  const busy = isMinifigs ? run.running : setsSubmitting;

  const progress = isMinifigs
    ? run.total > 0
      ? (run.processed / run.total) * 100
      : 0
    : setsSubmitting
      ? fakeProgress
      : setsResult && setsResult.totalRequested > 0
        ? (setsResult.importedCount / setsResult.totalRequested) * 100
        : 0;

  // Counts products actually created. Skipped duplicates and errors are
  // processed but not created, so "processed" here would read as a miscount.
  const summaryText = result ? `${result.importedCount} of ${result.totalRequested} created` : "";

  return (
    <s-page>
      <TitleBar title="LEGO Importer" />

      <div style={{ maxWidth: 800, margin: "24px auto", display: "flex", flexDirection: "column", gap: 24 }}>
        <section style={card}>
          <div style={{ display: "flex", gap: 8, marginBottom: 20 }}>
            <button type="button" style={tabButton(!isMinifigs)} onClick={() => setMode("sets")} disabled={busy}>
              Sets
            </button>
            <button type="button" style={tabButton(isMinifigs)} onClick={() => setMode("minifigs")} disabled={busy}>
              Minifigures
            </button>
          </div>

          {isMinifigs ? (
            <>
              <h1 style={{ fontSize: 22, fontWeight: 600, marginBottom: 10 }}>Import LEGO Minifigures</h1>
              <p style={{ marginBottom: 20, color: "#444" }}>
                Paste minifigure numbers (comma-separated or one per line). Use the catalogue number shown on
                BrickLink, for example sw0197. Draft products are created with the number as both the SKU and the
                barcode, so they scan at the till.
              </p>

              <textarea
                id="minifig-ids"
                rows={5}
                value={minifigInput}
                onChange={(e) => setMinifigInput(e.target.value)}
                disabled={run.running}
                placeholder={"Example:\nsw0197\nsw0844\nhp001, njo0500"}
                style={textarea}
              />

              <div>
                <button
                  type="button"
                  onClick={startMinifigs}
                  disabled={run.running || parseIds(minifigInput).length === 0}
                  style={primaryButton(run.running || parseIds(minifigInput).length === 0)}
                >
                  {run.running ? "Importing..." : "Import Minifigures"}
                </button>

                {run.running && (
                  <button type="button" onClick={stopMinifigs} style={secondaryButton}>
                    Stop
                  </button>
                )}

                {!run.running && run.canResume && (
                  <button type="button" onClick={resumeMinifigs} style={secondaryButton}>
                    Resume
                  </button>
                )}
              </div>

              {run.error && (
                <div
                  style={{
                    marginTop: 16,
                    padding: 12,
                    borderRadius: 6,
                    background: "#fff4f4",
                    border: "1px solid #e0b3b3",
                    color: "#8a1f1f",
                    fontSize: 14,
                  }}
                >
                  {run.error} Press Resume to carry on from where it stopped.
                </div>
              )}

              {run.total > 0 && (
                <div style={{ marginTop: 20 }}>
                  <ProgressBar percent={progress} />
                  <p style={{ marginTop: 8, fontSize: 12, color: "#555" }}>
                    {run.processed} of {run.total} processed
                  </p>
                </div>
              )}
            </>
          ) : (
            <>
              <h1 style={{ fontSize: 22, fontWeight: 600, marginBottom: 10 }}>Import LEGO Sets</h1>
              <p style={{ marginBottom: 20, color: "#444" }}>
                Paste LEGO set numbers (comma-separated or one per line). Draft products will be created
                automatically.
              </p>

              <setsFetcher.Form method="post" action="/app/import">
                <textarea
                  id="ids"
                  name="ids"
                  required
                  rows={5}
                  value={setsInput}
                  onChange={(e) => setSetsInput(e.target.value)}
                  placeholder={"Example:\n10236-1\n75192-1\n8038-1, 71043-1"}
                  style={textarea}
                />

                <button type="submit" disabled={setsSubmitting} style={primaryButton(setsSubmitting)}>
                  {setsSubmitting ? "Importing..." : "Import Sets"}
                </button>
              </setsFetcher.Form>

              {setsSubmitting && (
                <div style={{ marginTop: 20 }}>
                  <ProgressBar percent={progress} />
                  <p style={{ marginTop: 8, fontSize: 12, color: "#555" }}>Importing sets...</p>
                </div>
              )}
            </>
          )}
        </section>

        {result && result.results.length > 0 && (
          <section style={card}>
            <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 10 }}>Import Results</h2>

            <p style={{ color: "#444", marginBottom: 10 }}>{summaryText}</p>

            {result.totalRequested > 1 && (
              <div style={{ marginBottom: 20 }}>
                <ProgressBar percent={(result.importedCount / result.totalRequested) * 100} />
              </div>
            )}

            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
              <thead>
                <tr>
                  <th style={{ padding: 6, borderBottom: "1px solid #eee", textAlign: "left" }}>ID</th>
                  <th style={{ padding: 6, borderBottom: "1px solid #eee", textAlign: "left" }}>Status</th>
                  <th style={{ padding: 6, borderBottom: "1px solid #eee", textAlign: "left" }}>Message / Product</th>
                </tr>
              </thead>
              <tbody>
                {result.results.map((row, index) => (
                  <tr key={`${row.id}-${index}`}>
                    <td style={{ padding: 6, borderBottom: "1px solid #f3f3f3", color: "#333" }}>{row.id}</td>
                    <td
                      style={{
                        padding: 6,
                        borderBottom: "1px solid #f3f3f3",
                        textTransform: "capitalize",
                        color: row.status === "error" ? "#8a1f1f" : row.status === "skipped" ? "#8a6d1f" : "#1f6b45",
                      }}
                    >
                      {row.status}
                    </td>
                    <td style={{ padding: 6, borderBottom: "1px solid #f3f3f3" }}>
                      {row.status === "created" ? (
                        <>
                          Created: <strong>{row.shopifyProductTitle}</strong>{" "}
                          <span style={{ color: "#999" }}>({row.shopifyProductId})</span>
                          {row.stockingError ? (
                            <div style={{ color: "#8a1f1f", fontSize: 12, marginTop: 2 }}>
                              Not stocked at every location: {row.stockingError}. Open the product in Shopify and
                              tick the missing location(s) under Inventory.
                            </div>
                          ) : row.stockedAt?.length ? (
                            <div style={{ color: "#777", fontSize: 12, marginTop: 2 }}>
                              Stocked at {row.stockedAt.join(", ")} (0 in stock)
                            </div>
                          ) : null}
                        </>
                      ) : (
                        row.message || "-"
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}
      </div>
    </s-page>
  );
}
