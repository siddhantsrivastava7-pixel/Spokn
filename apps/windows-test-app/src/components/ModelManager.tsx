import { useState, useEffect, useRef } from "react";
import { IX } from "./Icons";
import {
  registerModel,
  unregisterModel,
  downloadModel,
  fetchRecommendations,
  fetchModelCatalog,
  type ModelCompatibilityEntry,
} from "../lib/api";
import { MODEL_CATALOG, getDownloadInfo } from "../lib/modelRecommender";
import type { PerModeRecommendations } from "../lib/types";
import type { DeviceInfo } from "../lib/types";

interface Props {
  installedModels: string[];
  langs: string[];
  device: DeviceInfo | null;
  onClose: () => void;
  onRefresh: () => void;
}

type Tab = "recommend" | "all";

const MODE_META: { key: keyof PerModeRecommendations; label: string; hint: string }[] = [
  { key: "auto",         label: "Auto (your pick)",  hint: "What the router selects for you based on your device + languages" },
  { key: "fast",         label: "Fast",               hint: "Prioritises speed — best for quick dictation" },
  { key: "balanced",     label: "Balanced",           hint: "Good accuracy without maxing out your CPU" },
  { key: "best_accuracy",label: "Best accuracy",      hint: "Highest quality — slowest, most resource-intensive" },
];

export function ModelManagerModal({ installedModels, langs, device, onClose, onRefresh }: Props) {
  const [tab, setTab] = useState<Tab>("recommend");
  const [recs, setRecs] = useState<PerModeRecommendations | null>(null);
  const [recsLoading, setRecsLoading] = useState(false);
  const [recsError, setRecsError] = useState<string | null>(null);

  const [downloading, setDownloading] = useState<string | null>(null); // modelId being downloaded
  const [progress, setProgress] = useState(0);
  const [downloadedMB, setDownloadedMB] = useState(0);
  const [totalMB, setTotalMB] = useState(0);
  const [dlError, setDlError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const cancelRef = useRef<(() => void) | null>(null);

  // All-models browse (compat map fetched from backend)
  const [compatMap, setCompatMap] = useState<Record<string, ModelCompatibilityEntry> | null>(null);
  const [compatLoading, setCompatLoading] = useState(false);
  const [compatError, setCompatError] = useState<string | null>(null);

  // Path register (power-user fallback, tucked below the list)
  const [pathRegOpen, setPathRegOpen] = useState(false);
  const [manualId, setManualId] = useState(MODEL_CATALOG[0]?.id ?? "");
  const [filePath, setFilePath] = useState("");
  const [regLoading, setRegLoading] = useState(false);
  const [regErr, setRegErr] = useState<string | null>(null);

  useEffect(() => {
    if (tab !== "recommend") return;
    setRecsLoading(true);
    setRecsError(null);
    fetchRecommendations(langs)
      .then(setRecs)
      .catch((e: Error) => setRecsError(e.message))
      .finally(() => setRecsLoading(false));
  }, [tab, langs.join(",")]);

  useEffect(() => {
    if (tab !== "all") return;
    setCompatLoading(true);
    setCompatError(null);
    fetchModelCatalog()
      .then((entries) => {
        const map: Record<string, ModelCompatibilityEntry> = {};
        for (const e of entries) map[e.modelId] = e;
        setCompatMap(map);
      })
      .catch((e: Error) => setCompatError(e.message))
      .finally(() => setCompatLoading(false));
  }, [tab]);

  function handleDownload(modelId: string) {
    const info = getDownloadInfo(modelId);
    if (!info || downloading) return;
    // transformers-js models auto-download on first inference — nothing to do here
    if (info.backendId === "transformers-js") return;
    if (!info.url || !info.filename) return;
    setDownloading(modelId);
    setProgress(0);
    setDlError(null);

    cancelRef.current = downloadModel(info.id, info.url, info.filename, info.label, {
      onProgress: (pct, dlMB, totMB) => { setProgress(pct); setDownloadedMB(dlMB); setTotalMB(totMB); },
      onDone: () => { setDownloading(null); setProgress(100); onRefresh(); },
      onError: (msg) => { setDownloading(null); setDlError(msg); },
    });
  }

  function handleCancel() { cancelRef.current?.(); setDownloading(null); setProgress(0); }

  async function handleRegister() {
    if (!manualId || !filePath.trim()) return;
    setRegLoading(true); setRegErr(null); setActionError(null);
    try { await registerModel(manualId, filePath.trim()); onRefresh(); setFilePath(""); }
    catch (e) { setRegErr(e instanceof Error ? e.message : String(e)); }
    finally { setRegLoading(false); }
  }

  async function handleRemove(modelId: string) {
    setActionError(null);
    try {
      await unregisterModel(modelId);
      onRefresh();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    }
  }

  const isInstalled = (id: string) => installedModels.includes(id);
  const isDeviceCompatible = (id: string) => {
    // When compat map isn't loaded yet, fall back to allowing (Recommendations
    // tab never saw this gate before — only the "All models" tab hard-filters).
    const entry = compatMap?.[id];
    return entry ? entry.compatible : true;
  };
  const canDownload = (id: string) => {
    const info = getDownloadInfo(id);
    if (!info || isInstalled(id) || downloading) return false;
    if (info.backendId === "transformers-js") return false; // auto-downloads on first use
    if (!isDeviceCompatible(id)) return false; // hard filter — model would exceed device budget
    return !!info.url;
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 500, width: "100%" }}>
        <div className="modal-head">
          <div>
            <div className="modal-title">Model Manager</div>
            <div className="modal-sub">
              {device
                ? `${Math.round(device.ramMB / 1024)}GB RAM · ${device.cpuTier} CPU · ${langs.join(", ")} selected`
                : "Detecting hardware…"}
            </div>
          </div>
          <button className="modal-close" onClick={onClose}><IX size={13} /></button>
        </div>

        {/* Tabs */}
        <div style={{ display: "flex", borderBottom: "1px solid var(--border)", padding: "0 20px" }}>
          {(["recommend", "all"] as Tab[]).map((t) => (
            <button key={t} onClick={() => setTab(t)} style={{
              background: "none", border: "none", cursor: "pointer", padding: "10px 14px 9px",
              fontSize: 11, fontFamily: "var(--font-mono)", color: tab === t ? "var(--accent)" : "var(--text-4)",
              borderBottom: tab === t ? "2px solid var(--accent)" : "2px solid transparent", marginBottom: -1,
            }}>
              {t === "recommend" ? "Recommendations" : "All models"}
            </button>
          ))}
        </div>

        <div className="modal-body">
          {tab === "recommend" && (
            <>
              {recsLoading && (
                <div style={{ textAlign: "center", padding: "24px 0", fontSize: 12, color: "var(--text-4)", fontFamily: "var(--font-mono)" }}>
                  Analysing your device…
                </div>
              )}
              {recsError && (
                <div style={{ fontSize: 11, color: "var(--danger)", fontFamily: "var(--font-mono)" }}>{recsError}</div>
              )}

              {recs && (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {MODE_META.map(({ key, label, hint }) => {
                    const rec = recs[key];
                    const modelId = rec.selectedModel.id;
                    const dlInfo = getDownloadInfo(modelId);
                    const installed = isInstalled(modelId);
                    const isAutoKey = key === "auto";

                    return (
                      <div key={key} style={{
                        background: isAutoKey ? "var(--accent-soft)" : "var(--surface-2)",
                        border: `1px solid ${isAutoKey ? "var(--accent-border)" : "var(--border)"}`,
                        borderRadius: "var(--r-md)", padding: "12px 14px",
                      }}>
                        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 10 }}>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            {/* Mode label */}
                            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                              <span style={{
                                fontSize: 9, fontFamily: "var(--font-mono)", textTransform: "uppercase",
                                letterSpacing: "0.12em", color: isAutoKey ? "var(--accent)" : "var(--text-4)",
                                fontWeight: 600,
                              }}>
                                {label}
                              </span>
                              {installed && (
                                <span style={{ fontSize: 9, background: "var(--surface-3)", color: "var(--text-3)", borderRadius: 4, padding: "1px 5px", border: "1px solid var(--border)" }}>
                                  installed ✓
                                </span>
                              )}
                            </div>

                            {/* Model name + size */}
                            <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", marginBottom: 3 }}>
                              {rec.selectedModel.displayName}
                              <span style={{ fontSize: 10.5, fontWeight: 400, color: "var(--text-4)", marginLeft: 8, fontFamily: "var(--font-mono)" }}>
                                {rec.selectedModel.sizeMB >= 1000
                                  ? `${(rec.selectedModel.sizeMB / 1000).toFixed(1)}GB`
                                  : `${rec.selectedModel.sizeMB}MB`}
                              </span>
                              {dlInfo?.backendId === "transformers-js" && (
                                <span style={{
                                  fontSize: 8.5, fontFamily: "var(--font-mono)", marginLeft: 6,
                                  padding: "1px 5px", background: "var(--surface-3)",
                                  border: "1px solid var(--border)", borderRadius: 4,
                                  color: "var(--text-4)", verticalAlign: "middle",
                                }}>ONNX</span>
                              )}
                            </div>

                            {/* Top reason */}
                            {rec.selectionReasons[0] && (
                              <div style={{ fontSize: 11, color: "var(--text-3)", marginBottom: 4 }}>
                                {rec.selectionReasons[0]}
                              </div>
                            )}

                            {/* Hint */}
                            <div style={{ fontSize: 10, color: "var(--text-4)", fontFamily: "var(--font-mono)" }}>{hint}</div>

                            {/* Applied biases */}
                            {rec.appliedBiases.length > 0 && (
                              <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 6 }}>
                                {rec.appliedBiases.map((b) => (
                                  <span key={b} style={{
                                    fontSize: 9, fontFamily: "var(--font-mono)", padding: "1px 5px",
                                    background: "var(--surface-3)", border: "1px solid var(--border)",
                                    borderRadius: 4, color: "var(--text-4)",
                                  }}>{b}</span>
                                ))}
                              </div>
                            )}
                          </div>

                          {/* Download button */}
                          <div style={{ flexShrink: 0 }}>
                            {installed ? (
                              <span style={{ fontSize: 11, color: "var(--text-4)", fontFamily: "var(--font-mono)" }}>ready</span>
                            ) : dlInfo?.backendId === "transformers-js" ? (
                              <span style={{
                                fontSize: 9, fontFamily: "var(--font-mono)", padding: "2px 6px",
                                background: "var(--surface-3)", border: "1px solid var(--border)",
                                borderRadius: 4, color: "var(--text-4)", whiteSpace: "nowrap",
                              }}>auto on use</span>
                            ) : downloading === modelId ? (
                              <button onClick={handleCancel} style={{
                                fontSize: 10, padding: "4px 10px", background: "none",
                                border: "1px solid var(--border)", borderRadius: "var(--r-sm)",
                                color: "var(--text-3)", cursor: "pointer", fontFamily: "var(--font-mono)",
                              }}>cancel</button>
                            ) : dlInfo ? (
                              <button onClick={() => handleDownload(modelId)} disabled={!canDownload(modelId)} style={{
                                fontSize: 10, padding: "5px 12px",
                                background: isAutoKey ? "var(--accent)" : "var(--surface-3)",
                                color: isAutoKey ? "#fff" : "var(--text-2)",
                                border: `1px solid ${isAutoKey ? "transparent" : "var(--border)"}`,
                                borderRadius: "var(--r-sm)", cursor: canDownload(modelId) ? "pointer" : "not-allowed",
                                fontFamily: "var(--font-mono)", opacity: downloading && downloading !== modelId ? 0.4 : 1,
                              }}>
                                Download
                              </button>
                            ) : (
                              <span style={{ fontSize: 10, color: "var(--text-4)", fontFamily: "var(--font-mono)" }}>no url</span>
                            )}
                          </div>
                        </div>

                        {/* Progress bar — shown inline under the active download */}
                        {downloading === modelId && (
                          <div style={{ marginTop: 10 }}>
                            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "var(--text-4)", fontFamily: "var(--font-mono)", marginBottom: 4 }}>
                              <span>Downloading…</span>
                              <span>{progress}% · {downloadedMB.toFixed(0)}/{totalMB.toFixed(0)} MB</span>
                            </div>
                            <div style={{ background: "var(--surface-3)", borderRadius: 99, height: 3, overflow: "hidden" }}>
                              <div style={{ height: "100%", width: `${progress}%`, background: "var(--accent)", transition: "width 300ms", borderRadius: 99 }} />
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              {dlError && (
                <div style={{ fontSize: 11, color: "var(--danger)", fontFamily: "var(--font-mono)", marginTop: 10 }}>{dlError}</div>
              )}
              {actionError && (
                <div style={{ fontSize: 11, color: "var(--danger)", fontFamily: "var(--font-mono)", marginTop: 10 }}>{actionError}</div>
              )}
            </>
          )}

          {tab === "all" && (
            <>
              <div style={{ fontSize: 10.5, color: "var(--text-4)", fontFamily: "var(--font-mono)", marginBottom: 10, lineHeight: 1.5 }}>
                Full catalog. Pick any model your device can run — models that would exceed your RAM / storage / CPU budget are disabled.
              </div>

              {compatLoading && (
                <div style={{ textAlign: "center", padding: "16px 0", fontSize: 12, color: "var(--text-4)", fontFamily: "var(--font-mono)" }}>
                  Checking compatibility…
                </div>
              )}
              {compatError && (
                <div style={{ fontSize: 11, color: "var(--danger)", fontFamily: "var(--font-mono)" }}>{compatError}</div>
              )}

              {compatMap && (
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {MODEL_CATALOG.map((m) => {
                    const compat = compatMap[m.id];
                    // Models not registered in stt-core won't have a compat entry — treat as incompatible.
                    const compatible = compat?.compatible ?? false;
                    const reason = compat?.reason ?? (compat ? null : "Not registered in stt-core");
                    const installed = isInstalled(m.id);
                    const isOnnx = m.backendId === "transformers-js";
                    const sizeLabel = m.sizeMB >= 1000 ? `${(m.sizeMB / 1000).toFixed(1)}GB` : `${m.sizeMB}MB`;

                    return (
                      <div key={m.id} style={{
                        background: "var(--surface-2)",
                        border: "1px solid var(--border)",
                        borderRadius: "var(--r-md)",
                        padding: "10px 12px",
                        opacity: !compatible && !installed ? 0.55 : 1,
                      }}>
                        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 10 }}>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text)", marginBottom: 2 }}>
                              {m.label}
                              <span style={{ fontSize: 10.5, fontWeight: 400, color: "var(--text-4)", marginLeft: 8, fontFamily: "var(--font-mono)" }}>
                                {sizeLabel}
                              </span>
                              {isOnnx && (
                                <span style={{
                                  fontSize: 8.5, fontFamily: "var(--font-mono)", marginLeft: 6,
                                  padding: "1px 5px", background: "var(--surface-3)",
                                  border: "1px solid var(--border)", borderRadius: 4,
                                  color: "var(--text-4)", verticalAlign: "middle",
                                }}>ONNX</span>
                              )}
                              {installed && (
                                <span style={{ fontSize: 9, marginLeft: 6, background: "var(--surface-3)", color: "var(--text-3)", borderRadius: 4, padding: "1px 5px", border: "1px solid var(--border)" }}>
                                  installed ✓
                                </span>
                              )}
                            </div>
                            {!compatible && !installed && reason && (
                              <div style={{ fontSize: 10, color: "var(--danger)", fontFamily: "var(--font-mono)", marginTop: 4 }}>
                                ✕ {reason}
                              </div>
                            )}
                          </div>

                          <div style={{ flexShrink: 0 }}>
                            {installed ? (
                              <span style={{ fontSize: 11, color: "var(--text-4)", fontFamily: "var(--font-mono)" }}>ready</span>
                            ) : isOnnx ? (
                              <span style={{
                                fontSize: 9, fontFamily: "var(--font-mono)", padding: "2px 6px",
                                background: "var(--surface-3)", border: "1px solid var(--border)",
                                borderRadius: 4, color: "var(--text-4)", whiteSpace: "nowrap",
                              }}>auto on use</span>
                            ) : downloading === m.id ? (
                              <button onClick={handleCancel} style={{
                                fontSize: 10, padding: "4px 10px", background: "none",
                                border: "1px solid var(--border)", borderRadius: "var(--r-sm)",
                                color: "var(--text-3)", cursor: "pointer", fontFamily: "var(--font-mono)",
                              }}>cancel</button>
                            ) : (
                              <button
                                onClick={() => handleDownload(m.id)}
                                disabled={!canDownload(m.id)}
                                title={!compatible ? (reason ?? "Incompatible with this device") : undefined}
                                style={{
                                  fontSize: 10, padding: "5px 12px",
                                  background: "var(--surface-3)",
                                  color: "var(--text-2)",
                                  border: "1px solid var(--border)",
                                  borderRadius: "var(--r-sm)",
                                  cursor: canDownload(m.id) ? "pointer" : "not-allowed",
                                  fontFamily: "var(--font-mono)",
                                  opacity: downloading && downloading !== m.id ? 0.4 : 1,
                                }}
                              >
                                Download
                              </button>
                            )}
                          </div>
                        </div>

                        {downloading === m.id && (
                          <div style={{ marginTop: 8 }}>
                            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "var(--text-4)", fontFamily: "var(--font-mono)", marginBottom: 4 }}>
                              <span>Downloading…</span>
                              <span>{progress}% · {downloadedMB.toFixed(0)}/{totalMB.toFixed(0)} MB</span>
                            </div>
                            <div style={{ background: "var(--surface-3)", borderRadius: 99, height: 3, overflow: "hidden" }}>
                              <div style={{ height: "100%", width: `${progress}%`, background: "var(--accent)", transition: "width 300ms", borderRadius: 99 }} />
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Installed models (remove affordance) */}
              {installedModels.length > 0 && (
                <div style={{ marginTop: 16 }}>
                  <div className="modal-label">Installed</div>
                  <div className="modal-installed">
                    {installedModels.map((id) => {
                      const isOnnx = MODEL_CATALOG.find((x) => x.id === id)?.backendId === "transformers-js";
                      return (
                        <div className="modal-model-row" key={id}>
                          <span className="modal-model-name"><span className="modal-model-dot" /> {id}</span>
                          {isOnnx ? (
                            <span style={{ fontSize: 9, fontFamily: "var(--font-mono)", color: "var(--text-4)", padding: "1px 5px", background: "var(--surface-3)", border: "1px solid var(--border)", borderRadius: 4 }}>auto-managed</span>
                          ) : (
                            <button className="modal-model-remove" onClick={() => void handleRemove(id)}>remove</button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Register from local path — tucked away for power users with a pre-downloaded GGUF */}
              <div style={{ marginTop: 18, borderTop: "1px solid var(--border)", paddingTop: 12 }}>
                <button
                  onClick={() => setPathRegOpen((v) => !v)}
                  style={{
                    background: "none", border: "none", padding: 0, cursor: "pointer",
                    fontSize: 10.5, fontFamily: "var(--font-mono)", color: "var(--text-4)",
                    textTransform: "uppercase", letterSpacing: "0.08em",
                  }}
                >
                  {pathRegOpen ? "▾" : "▸"} Register from local file
                </button>
                {pathRegOpen && (
                  <div style={{ marginTop: 10 }}>
                    <div style={{ fontSize: 10, color: "var(--text-4)", fontFamily: "var(--font-mono)", marginBottom: 8, lineHeight: 1.5 }}>
                      Already have a GGUF file? Point stt-core at it instead of re-downloading.
                    </div>
                    <div className="modal-field">
                      <div className="modal-label">Model</div>
                      <select className="modal-input" value={manualId} onChange={(e) => setManualId(e.target.value)} style={{ appearance: "none" }}>
                        {MODEL_CATALOG.filter((m) => m.backendId !== "transformers-js").map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.label} ({m.sizeMB >= 1000 ? `${(m.sizeMB / 1000).toFixed(1)}GB` : `${m.sizeMB}MB`})
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="modal-field">
                      <div className="modal-label">File path</div>
                      <input
                        className="modal-input" type="text"
                        placeholder="C:\Users\you\Downloads\ggml-large-v3-turbo.bin"
                        value={filePath} onChange={(e) => setFilePath(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter") void handleRegister(); }}
                      />
                    </div>
                    <button
                      className="modal-btn primary"
                      onClick={() => void handleRegister()}
                      disabled={regLoading || !filePath.trim()}
                      style={{ marginTop: 4 }}
                    >
                      {regLoading ? "Registering…" : "Register model"}
                    </button>
                    {regErr && <div style={{ fontSize: 11.5, color: "var(--danger)", fontFamily: "var(--font-mono)", marginTop: 8 }}>{regErr}</div>}
                  </div>
                )}
              </div>

              {actionError && <div style={{ fontSize: 11.5, color: "var(--danger)", fontFamily: "var(--font-mono)", marginTop: 10 }}>{actionError}</div>}
              {dlError && <div style={{ fontSize: 11.5, color: "var(--danger)", fontFamily: "var(--font-mono)", marginTop: 10 }}>{dlError}</div>}
            </>
          )}
        </div>

        <div className="modal-footer">
          <button className="modal-btn ghost" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
