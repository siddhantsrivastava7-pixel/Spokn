import { useState, useEffect, useRef } from "react";
import { LANGUAGES, REGIONS, getLanguage } from "../lib/languages";
import { fetchRecommendations, downloadModel } from "../lib/api";
import { getDownloadInfo } from "../lib/modelRecommender";
import type { ModeRecommendation } from "../lib/types";

type Step = "welcome" | "language" | "shortcuts" | "setup";

interface Props {
  onComplete: (langs: string[]) => void;
}

// ── Shortcut types (mirror App.tsx) ──────────────────────────────────────────
type ShortcutId = "record" | "upload" | "transcribe" | "clear";

const DEFAULT_SHORTCUTS: Record<ShortcutId, string> = {
  record: "Ctrl+Shift+R",
  upload: "Ctrl+Shift+U",
  transcribe: "Ctrl+Enter",
  clear: "Ctrl+Backspace",
};

const SHORTCUT_META: { id: ShortcutId; label: string; description: string }[] = [
  { id: "record",     label: "Record / Stop",  description: "Start or stop microphone recording" },
  { id: "upload",     label: "Upload file",     description: "Open a file picker to load an audio file" },
  { id: "transcribe", label: "Transcribe",      description: "Run transcription on the current audio" },
  { id: "clear",      label: "Clear",           description: "Clear audio and transcript" },
];

const SHORTCUTS_STORAGE_KEY = "stt-shortcuts";

function normalizeShortcutValue(shortcut: string): string {
  return shortcut.includes("+") ? shortcut : `Ctrl+Shift+${shortcut}`;
}

function normalizeShortcutMap(shortcuts: Record<ShortcutId, string>): Record<ShortcutId, string> {
  return {
    record: normalizeShortcutValue(shortcuts.record),
    upload: normalizeShortcutValue(shortcuts.upload),
    transcribe: normalizeShortcutValue(shortcuts.transcribe),
    clear: normalizeShortcutValue(shortcuts.clear),
  };
}

function keyEventToString(e: KeyboardEvent): string {
  const mods: string[] = [];
  if (e.ctrlKey || e.metaKey) mods.push("Ctrl");
  if (e.shiftKey) mods.push("Shift");
  if (e.altKey) mods.push("Alt");
  const key = e.key === " " ? "Space" : e.key.length === 1 ? e.key.toUpperCase() : e.key;
  return [...mods, key].join("+");
}

// ── Persistence helpers ───────────────────────────────────────────────────────
const ONBOARDING_KEY = "stt-onboarding-done";
const ONBOARDING_LANGS_KEY = "stt-onboarding-langs";

export function needsOnboarding(): boolean {
  return !localStorage.getItem(ONBOARDING_KEY);
}

export function getSavedLangs(): string[] {
  try {
    const saved = localStorage.getItem(ONBOARDING_LANGS_KEY);
    if (saved) return JSON.parse(saved) as string[];
  } catch { /* ignore */ }
  return ["auto"];
}

// ── Component ─────────────────────────────────────────────────────────────────
export function Onboarding({ onComplete }: Props) {
  const [step, setStep] = useState<Step>("welcome");

  // Language step
  const [selected, setSelected] = useState<string[]>([]);
  const [search, setSearch] = useState("");

  // Shortcut step
  const [shortcuts, setShortcuts] = useState<Record<ShortcutId, string>>(() => {
    try {
      const saved = localStorage.getItem(SHORTCUTS_STORAGE_KEY);
      const merged = saved ? { ...DEFAULT_SHORTCUTS, ...JSON.parse(saved) as Record<ShortcutId, string> } : DEFAULT_SHORTCUTS;
      return normalizeShortcutMap(merged);
    } catch { return DEFAULT_SHORTCUTS; }
  });
  const [binding, setBinding] = useState<ShortcutId | null>(null);

  // Setup step
  const [rec, setRec] = useState<ModeRecommendation | null>(null);
  const [recLoading, setRecLoading] = useState(false);
  const [recError, setRecError] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [downloadedMB, setDownloadedMB] = useState(0);
  const [totalMB, setTotalMB] = useState(0);
  const [dlDone, setDlDone] = useState(false);
  const [dlError, setDlError] = useState<string | null>(null);
  const [dlSkipped, setDlSkipped] = useState(false);
  const cancelRef = useRef<(() => void) | null>(null);

  // Capture keyboard when rebinding a shortcut
  useEffect(() => {
    if (!binding) return;
    const capture = (e: KeyboardEvent) => {
      if (e.key === "Escape") { setBinding(null); return; }
      if (["Control", "Meta", "Shift", "Alt"].includes(e.key)) return;
      e.preventDefault();
      e.stopPropagation();
      const next = normalizeShortcutMap({ ...shortcuts, [binding]: keyEventToString(e) });
      setShortcuts(next);
      localStorage.setItem(SHORTCUTS_STORAGE_KEY, JSON.stringify(next));
      setBinding(null);
    };
    window.addEventListener("keydown", capture, { capture: true });
    return () => window.removeEventListener("keydown", capture, { capture: true });
  }, [binding, shortcuts]);

  // When entering the setup step: fetch recommendation + auto-start download
  useEffect(() => {
    if (step !== "setup") return;
    const langs = selected.length > 0 ? selected : ["auto"];

    setRecLoading(true);
    setRecError(null);
    fetchRecommendations(langs)
      .then((recs) => {
        const autoRec = recs.auto;
        setRec(autoRec);
        const modelId = autoRec.selectedModel.id;
        const info = getDownloadInfo(modelId);
        if (!info) { setRecLoading(false); return; }

        if (info.backendId === "transformers-js") {
          setDlSkipped(true);
          setDlDone(true);
          setRecLoading(false);
          return;
        }

        if (!info.url || !info.filename) { setRecLoading(false); return; }

        setRecLoading(false);
        cancelRef.current = downloadModel(modelId, info.url, info.filename, info.label, {
          onProgress: (pct, dlMB, totMB) => { setProgress(pct); setDownloadedMB(dlMB); setTotalMB(totMB); },
          onDone: () => { setDlDone(true); setProgress(100); },
          onError: (msg) => setDlError(msg),
        });
      })
      .catch((e: Error) => { setRecError(e.message); setRecLoading(false); });

    return () => { cancelRef.current?.(); };
  }, [step]);

  function handleComplete() {
    const langs = selected.length > 0 ? selected : ["auto"];
    localStorage.setItem(ONBOARDING_KEY, "1");
    localStorage.setItem(ONBOARDING_LANGS_KEY, JSON.stringify(langs));
    onComplete(langs);
  }

  function toggleLang(code: string) {
    setSelected((prev) =>
      prev.includes(code) ? prev.filter((c) => c !== code) : [...prev, code]
    );
  }

  const STEPS: Step[] = ["welcome", "language", "shortcuts", "setup"];
  const stepIndex = STEPS.indexOf(step);
  const stepLabel = stepIndex > 0 ? `Step ${stepIndex} of 3` : null;

  const q = search.toLowerCase();
  const filtered = LANGUAGES.filter(
    (l) => l.name.toLowerCase().includes(q) || l.nativeName.toLowerCase().includes(q) || l.code.toLowerCase().includes(q)
  );

  return (
    <div style={{
      position: "fixed", inset: 0,
      background: "var(--bg)",
      display: "flex", alignItems: "center", justifyContent: "center",
      zIndex: 9999,
    }}>
      <div style={{
        width: "100%", maxWidth: 540,
        display: "flex", flexDirection: "column",
        maxHeight: "100vh",
        padding: "0 24px",
      }}>

        {/* ── Step indicator dot row ─────────────────────────────────────── */}
        {stepLabel && (
          <div style={{ display: "flex", justifyContent: "center", gap: 6, marginBottom: 28 }}>
            {[1, 2, 3].map((n) => (
              <div key={n} style={{
                width: n <= stepIndex ? 20 : 6, height: 6,
                borderRadius: 99,
                background: n === stepIndex ? "var(--accent)" : n < stepIndex ? "var(--accent-border)" : "var(--surface-4)",
                transition: "all 300ms var(--ease)",
              }} />
            ))}
          </div>
        )}

        {/* ── Step 1: Welcome ───────────────────────────────────────────── */}
        {step === "welcome" && (
          <div style={{ animation: "fadeUp 300ms var(--ease) both" }}>
            <div style={{ marginBottom: 28, display: "flex", justifyContent: "center" }}>
              <div style={{
                width: 56, height: 56, borderRadius: 16,
                background: "var(--accent-soft)", border: "1px solid var(--accent-border)",
                display: "flex", alignItems: "center", justifyContent: "center",
              }}>
                <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="1.6" strokeLinecap="round">
                  <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
                  <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                  <line x1="12" y1="19" x2="12" y2="23" />
                  <line x1="8" y1="23" x2="16" y2="23" />
                </svg>
              </div>
            </div>

            <h1 style={{ margin: "0 0 10px", fontSize: 26, fontWeight: 700, textAlign: "center", color: "var(--text)", letterSpacing: "-0.03em" }}>
              Welcome to STT
            </h1>
            <p style={{ margin: "0 0 8px", fontSize: 13, color: "var(--text-3)", textAlign: "center", lineHeight: 1.7 }}>
              Private, offline speech-to-text that runs entirely on your machine.
            </p>
            <p style={{ margin: "0 0 32px", fontSize: 12, color: "var(--text-4)", textAlign: "center", lineHeight: 1.6, fontFamily: "var(--font-mono)" }}>
              No cloud. No accounts. No data leaves your device.
            </p>

            <button onClick={() => setStep("language")} style={primaryBtn}>
              Get started
            </button>
          </div>
        )}

        {/* ── Step 2: Language ──────────────────────────────────────────── */}
        {step === "language" && (
          <div style={{ display: "flex", flexDirection: "column", maxHeight: "100vh", paddingTop: 8, paddingBottom: 24, animation: "fadeUp 300ms var(--ease) both" }}>
            <h2 style={stepTitle}>What languages do you speak?</h2>
            <p style={stepSub}>
              The router uses this to pick the best model for your voice. You can always change it later in the left panel.
            </p>

            <input
              type="text" placeholder="Search languages…" value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={searchInput}
            />

            <div style={{
              flex: 1, overflowY: "auto", minHeight: 0,
              background: "var(--surface-2)", border: "1px solid var(--border)",
              borderRadius: "var(--r-md)", marginBottom: 14,
            }}>
              {!search && (
                <label style={{
                  display: "flex", alignItems: "center", gap: 10, padding: "10px 14px",
                  cursor: "pointer", borderBottom: "1px solid var(--border)",
                  background: selected.length === 0 ? "var(--accent-soft)" : "transparent",
                }}>
                  <input type="checkbox" checked={selected.length === 0} onChange={() => setSelected([])} style={{ accentColor: "var(--accent)" }} />
                  <span style={{ fontSize: 12, color: selected.length === 0 ? "var(--accent)" : "var(--text)", fontWeight: 500 }}>Auto detect</span>
                  <span style={{ marginLeft: "auto", fontSize: 10, color: "var(--text-4)", fontFamily: "var(--font-mono)" }}>recommended</span>
                </label>
              )}
              {REGIONS.map((region) => {
                const langs = filtered.filter((l) => l.region === region);
                if (langs.length === 0) return null;
                return (
                  <div key={region}>
                    {!search && (
                      <div style={{ padding: "7px 14px 3px", fontSize: 9, textTransform: "uppercase", letterSpacing: "0.12em", color: "var(--text-4)", fontFamily: "var(--font-mono)", fontWeight: 600, borderTop: "1px solid var(--border)" }}>
                        {region}
                      </div>
                    )}
                    {langs.map((l) => {
                      const checked = selected.includes(l.code);
                      return (
                        <label key={l.code} style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 14px", cursor: "pointer", background: checked ? "var(--accent-soft)" : "transparent" }}>
                          <input type="checkbox" checked={checked} onChange={() => toggleLang(l.code)} style={{ accentColor: "var(--accent)" }} />
                          <span style={{ fontSize: 12, color: checked ? "var(--accent)" : "var(--text)", flex: 1 }}>{l.name}</span>
                          <span style={{ fontSize: 10.5, color: "var(--text-4)", fontFamily: "var(--font-mono)" }}>{l.nativeName}</span>
                          {l.needsLargeModel && (
                            <span style={{ fontSize: 9, background: "var(--surface-3)", border: "1px solid var(--border)", borderRadius: 4, padding: "1px 5px", color: "var(--text-4)", fontFamily: "var(--font-mono)" }}>large</span>
                          )}
                        </label>
                      );
                    })}
                  </div>
                );
              })}
            </div>

            {selected.length > 0 && (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginBottom: 14 }}>
                {selected.map((c) => (
                  <span key={c} style={{ display: "inline-flex", alignItems: "center", gap: 4, background: "var(--accent-soft)", border: "1px solid var(--accent-border)", borderRadius: 99, padding: "2px 8px", fontSize: 10.5, color: "var(--accent)", fontFamily: "var(--font-mono)" }}>
                    {getLanguage(c)?.name ?? c}
                    <button onClick={() => toggleLang(c)} style={{ background: "none", border: "none", cursor: "pointer", padding: 0, color: "var(--accent)", lineHeight: 1, fontSize: 12 }}>×</button>
                  </span>
                ))}
              </div>
            )}

            <button onClick={() => setStep("shortcuts")} style={primaryBtn}>Continue</button>
          </div>
        )}

        {/* ── Step 3: Shortcuts ─────────────────────────────────────────── */}
        {step === "shortcuts" && (
          <div style={{ animation: "fadeUp 300ms var(--ease) both" }}>
            <h2 style={stepTitle}>Set your keyboard shortcuts</h2>
            <p style={stepSub}>
              STT runs minimized in the background — you'll control it entirely by keyboard while typing in other apps. Click any key to rebind it.
            </p>

            {/* How it works callout */}
            <div style={{
              background: "var(--surface-2)", border: "1px solid var(--border)",
              borderRadius: "var(--r-md)", padding: "12px 14px", marginBottom: 20,
              display: "flex", gap: 10, alignItems: "flex-start",
            }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" style={{ flexShrink: 0, marginTop: 1 }}>
                <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
              <span style={{ fontSize: 11, color: "var(--text-3)", lineHeight: 1.6 }}>
                Press your shortcut anywhere on your PC — STT will pick it up even when its window is hidden. Global hotkeys work as long as the app is running.
              </span>
            </div>

            {/* Shortcut rows */}
            <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 28 }}>
              {SHORTCUT_META.map(({ id, label, description }) => {
                const isBinding = binding === id;
                return (
                  <div key={id} style={{
                    background: "var(--surface-2)", border: `1px solid ${isBinding ? "var(--accent-border)" : "var(--border)"}`,
                    borderRadius: "var(--r-md)", padding: "12px 14px",
                    display: "flex", alignItems: "center", gap: 12,
                    transition: "border-color 150ms",
                  }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text)", marginBottom: 2 }}>{label}</div>
                      <div style={{ fontSize: 10.5, color: "var(--text-4)", fontFamily: "var(--font-mono)" }}>{description}</div>
                    </div>
                    <button
                      onClick={() => setBinding(isBinding ? null : id)}
                      style={{
                        flexShrink: 0,
                        fontSize: 11, fontFamily: "var(--font-mono)", padding: "5px 12px",
                        background: isBinding ? "var(--accent)" : "var(--surface-3)",
                        color: isBinding ? "var(--accent-ink)" : "var(--text-2)",
                        border: `1px solid ${isBinding ? "transparent" : "var(--border)"}`,
                        borderRadius: "var(--r-sm)", cursor: "pointer",
                        minWidth: 100, textAlign: "center",
                        transition: "all 150ms",
                      }}
                    >
                      {isBinding ? "press key…" : shortcuts[id]}
                    </button>
                  </div>
                );
              })}
            </div>

            <div style={{ display: "flex", gap: 8 }}>
              <button
                onClick={() => {
                  setShortcuts(DEFAULT_SHORTCUTS);
                  localStorage.setItem(SHORTCUTS_STORAGE_KEY, JSON.stringify(DEFAULT_SHORTCUTS));
                }}
                style={ghostBtn}
              >
                Reset to defaults
              </button>
              <button onClick={() => setStep("setup")} style={{ ...primaryBtn, flex: 1 }}>
                Continue
              </button>
            </div>
          </div>
        )}

        {/* ── Step 4: Download & setup ──────────────────────────────────── */}
        {step === "setup" && (
          <div style={{ animation: "fadeUp 300ms var(--ease) both" }}>
            <h2 style={stepTitle}>Setting up your model</h2>
            <p style={stepSub}>
              Based on your languages and hardware, we picked the best free offline model for you.
            </p>

            {recLoading && (
              <div style={{ fontSize: 12, color: "var(--text-4)", fontFamily: "var(--font-mono)", marginBottom: 24 }}>
                Analysing your device…
              </div>
            )}
            {recError && (
              <div style={{ fontSize: 12, color: "var(--danger)", fontFamily: "var(--font-mono)", marginBottom: 20 }}>{recError}</div>
            )}

            {rec && (
              <div style={{ background: "var(--surface-2)", border: "1px solid var(--accent-border)", borderRadius: "var(--r-lg)", padding: "18px 20px", marginBottom: 24 }}>
                <div style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: "0.12em", color: "var(--accent)", fontFamily: "var(--font-mono)", fontWeight: 600, marginBottom: 6 }}>
                  Recommended for you
                </div>
                <div style={{ fontSize: 16, fontWeight: 700, color: "var(--text)", marginBottom: 2 }}>
                  {rec.selectedModel.displayName}
                  <span style={{ fontSize: 11, fontWeight: 400, color: "var(--text-4)", marginLeft: 10, fontFamily: "var(--font-mono)" }}>
                    {rec.selectedModel.sizeMB >= 1000 ? `${(rec.selectedModel.sizeMB / 1000).toFixed(1)} GB` : `${rec.selectedModel.sizeMB} MB`}
                  </span>
                </div>
                {rec.selectionReasons[0] && (
                  <div style={{ fontSize: 11.5, color: "var(--text-3)", marginBottom: rec.appliedBiases.length > 0 ? 8 : 14 }}>{rec.selectionReasons[0]}</div>
                )}
                {rec.appliedBiases.length > 0 && (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 14 }}>
                    {rec.appliedBiases.map((b) => (
                      <span key={b} style={{ fontSize: 9, fontFamily: "var(--font-mono)", padding: "1px 6px", background: "var(--surface-3)", border: "1px solid var(--border)", borderRadius: 4, color: "var(--text-4)" }}>{b}</span>
                    ))}
                  </div>
                )}

                {!dlDone && !dlError && !dlSkipped && (
                  <div>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "var(--text-4)", fontFamily: "var(--font-mono)", marginBottom: 6 }}>
                      <span>Downloading…</span>
                      <span>{progress}% · {downloadedMB.toFixed(0)}/{totalMB.toFixed(0)} MB</span>
                    </div>
                    <div style={{ background: "var(--surface-3)", borderRadius: 99, height: 4, overflow: "hidden" }}>
                      <div style={{ height: "100%", width: `${progress}%`, background: "var(--accent)", borderRadius: 99, transition: "width 300ms" }} />
                    </div>
                  </div>
                )}
                {dlSkipped && (
                  <div style={{ fontSize: 11, color: "var(--text-3)", fontFamily: "var(--font-mono)" }}>
                    This model auto-downloads on first transcription (ONNX via HuggingFace).
                  </div>
                )}
                {dlDone && !dlSkipped && (
                  <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11.5, color: "var(--success)", fontFamily: "var(--font-mono)" }}>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><polyline points="20 6 9 17 4 12" /></svg>
                    Downloaded and ready
                  </div>
                )}
                {dlError && (
                  <div style={{ fontSize: 11, color: "var(--danger)", fontFamily: "var(--font-mono)" }}>
                    Download failed: {dlError}
                    <br /><span style={{ color: "var(--text-4)" }}>You can download models later from Model Manager.</span>
                  </div>
                )}
              </div>
            )}

            <button
              onClick={handleComplete}
              disabled={!dlDone && !dlError && !recError && !dlSkipped}
              style={{
                ...primaryBtn,
                background: dlDone || dlError || recError || dlSkipped ? "var(--accent)" : "var(--surface-3)",
                color: dlDone || dlError || recError || dlSkipped ? "var(--accent-ink)" : "var(--text-4)",
                border: `1px solid ${dlDone || dlError || recError || dlSkipped ? "transparent" : "var(--border)"}`,
                cursor: !dlDone && !dlError && !recError && !dlSkipped ? "not-allowed" : "pointer",
              }}
            >
              {dlDone ? "Enter app →" : dlError || recError ? "Skip and enter app" : recLoading ? "Preparing…" : "Waiting for download…"}
            </button>

            <button onClick={handleComplete} style={{ width: "100%", marginTop: 8, padding: "7px", background: "none", border: "none", fontSize: 11, color: "var(--text-4)", cursor: "pointer", fontFamily: "var(--font-mono)" }}>
              Skip — set up models manually later
            </button>
          </div>
        )}
      </div>

      <style>{`
        @keyframes fadeUp {
          from { opacity: 0; transform: translateY(10px); }
          to   { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  );
}

// ── Shared style objects ───────────────────────────────────────────────────────
const primaryBtn: React.CSSProperties = {
  width: "100%", padding: "12px", borderRadius: "var(--r-md)",
  background: "var(--accent)", color: "var(--accent-ink)",
  border: "none", fontSize: 13, fontWeight: 600, cursor: "pointer",
  letterSpacing: "-0.01em", transition: "opacity 150ms",
};

const ghostBtn: React.CSSProperties = {
  padding: "11px 16px", borderRadius: "var(--r-md)",
  background: "none", color: "var(--text-3)",
  border: "1px solid var(--border)", fontSize: 12, cursor: "pointer",
  fontFamily: "var(--font-mono)", whiteSpace: "nowrap",
};

const stepTitle: React.CSSProperties = {
  margin: "0 0 8px", fontSize: 20, fontWeight: 700, color: "var(--text)", letterSpacing: "-0.025em",
};

const stepSub: React.CSSProperties = {
  margin: "0 0 20px", fontSize: 12, color: "var(--text-3)", lineHeight: 1.7,
};

const searchInput: React.CSSProperties = {
  width: "100%", background: "var(--surface-2)", border: "1px solid var(--border)",
  borderRadius: "var(--r-sm)", padding: "8px 12px", fontSize: 12,
  color: "var(--text)", fontFamily: "var(--font-sans)", outline: "none",
  marginBottom: 10, boxSizing: "border-box",
};
