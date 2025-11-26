import { useFetcher } from "react-router";
import { useEffect, useMemo, useState } from "react";
import { TitleBar } from "@shopify/app-bridge-react";

export default function LegoImporterIndex() {
  const fetcher = useFetcher();
  const result = fetcher.data;

  const isSubmitting =
    fetcher.state === "submitting" || fetcher.state === "loading";

  // Fake progress bar while waiting
  const [fakeProgress, setFakeProgress] = useState(0);

  useEffect(() => {
    if (isSubmitting) {
      setFakeProgress(0);

      const interval = setInterval(() => {
        setFakeProgress((p) => {
          if (p >= 90) return 90; // Don't hit 100 before actual results
          return p + Math.random() * 15; // Fast early, slow later
        });
      }, 400);

      return () => clearInterval(interval);
    } else {
      // When finished, jump to 100%
      setFakeProgress(100);
    }
  }, [isSubmitting]);

  // Real progress from server
  const realProgress =
    result && result.totalRequested > 0
      ? (result.importedCount / result.totalRequested) * 100
      : 0;

  // Displayed progress = fake while loading, real after
  const displayProgress = isSubmitting ? fakeProgress : realProgress;

  const summaryText = useMemo(() => {
    if (!result) return "";
    return `${result.importedCount} of ${result.totalRequested} processed`;
  }, [result]);

  return (
    <s-page>
      <TitleBar title="LEGO Importer" />

      <div
        style={{
          maxWidth: 800,
          margin: "24px auto",
          display: "flex",
          flexDirection: "column",
          gap: "24px",
        }}
      >
        {/* Import Form */}
        <section
          style={{
            background: "white",
            borderRadius: 8,
            padding: 24,
            boxShadow: "0 1px 3px rgba(0,0,0,0.06)",
          }}
        >
          <h1 style={{ fontSize: 22, fontWeight: 600, marginBottom: 10 }}>
            Import LEGO Sets
          </h1>

          <p style={{ marginBottom: 20, color: "#444" }}>
            Paste LEGO set numbers (comma-separated or one per line).
            Draft products will be created automatically.
          </p>

          <fetcher.Form method="post" action="/app/import">
            <textarea
              id="ids"
              name="ids"
              required
              rows={5}
              placeholder={"Example:\n10236-1\n75192-1\n8038-1, 71043-1"}
              style={{
                width: "100%",
                fontSize: 14,
                padding: 10,
                borderRadius: 6,
                border: "1px solid #ccc",
                marginBottom: 12,
              }}
            />

            <button
              type="submit"
              disabled={isSubmitting}
              style={{
                padding: "10px 20px",
                backgroundColor: "#008060",
                color: "white",
                borderRadius: 6,
                border: "none",
                fontWeight: 600,
                cursor: isSubmitting ? "not-allowed" : "pointer",
              }}
            >
              {isSubmitting ? "Importing…" : "Import Sets"}
            </button>
          </fetcher.Form>

          {/* Progress Bar (always visible while submitting) */}
          {isSubmitting && (
            <div style={{ marginTop: 20 }}>
              <div
                style={{
                  height: 10,
                  background: "#e5e5e5",
                  borderRadius: 4,
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    height: "100%",
                    width: `${displayProgress}%`,
                    background: "#008060",
                    transition: "width 0.4s ease",
                  }}
                />
              </div>
              <p style={{ marginTop: 8, fontSize: 12, color: "#555" }}>
                Importing sets…
              </p>
            </div>
          )}
        </section>

        {/* Results Section */}
        {result && (
          <section
            style={{
              background: "white",
              borderRadius: 8,
              padding: 24,
              boxShadow: "0 1px 3px rgba(0,0,0,0.06)",
            }}
          >
            <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 10 }}>
              Import Results
            </h2>

            <p style={{ color: "#444", marginBottom: 10 }}>{summaryText}</p>

            {/* Final progress bar */}
            {result.totalRequested > 1 && (
              <div style={{ marginBottom: 20 }}>
                <div
                  style={{
                    height: 10,
                    background: "#eee",
                    borderRadius: 4,
                    overflow: "hidden",
                  }}
                >
                  <div
                    style={{
                      height: "100%",
                      width: `${realProgress}%`,
                      backgroundColor: "#008060",
                      transition: "width 0.5s ease",
                    }}
                  />
                </div>
              </div>
            )}

            {/* Results Table */}
            <table
              style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}
            >
              <thead>
                <tr>
                  <th style={{ padding: 6, borderBottom: "1px solid #eee" }}>
                    ID
                  </th>
                  <th style={{ padding: 6, borderBottom: "1px solid #eee" }}>
                    Status
                  </th>
                  <th style={{ padding: 6, borderBottom: "1px solid #eee" }}>
                    Message / Product
                  </th>
                </tr>
              </thead>
              <tbody>
                {result.results.map((row) => (
                  <tr key={row.id}>
                    <td
                      style={{
                        padding: 6,
                        borderBottom: "1px solid #f3f3f3",
                        color: "#333",
                      }}
                    >
                      {row.id}
                    </td>
                    <td
                      style={{
                        padding: 6,
                        borderBottom: "1px solid #f3f3f3",
                        textTransform: "capitalize",
                      }}
                    >
                      {row.status}
                    </td>
                    <td
                      style={{
                        padding: 6,
                        borderBottom: "1px solid #f3f3f3",
                      }}
                    >
                      {row.status === "created" ? (
                        <>
                          Created: <strong>{row.shopifyProductTitle}</strong>{" "}
                          <span style={{ color: "#999" }}>
                            ({row.shopifyProductId})
                          </span>
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
