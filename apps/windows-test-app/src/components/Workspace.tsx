import { useEffect, useRef, useState, useMemo } from "react";
import { ICode, ICopy, IDownload, ISearch } from "./Icons";
import { SignatureLine } from "./SignatureLine";
import { Waveform } from "./Waveform";
import { DebugPanel } from "./DebugPanel";
import { learnFromCorrections } from "../lib/learnedVocab";
import { submitFeedback } from "../lib/api";
import { applySnippets } from "../lib/snippets";
import type { Snippet } from "../lib/snippets";
import type { AppState } from "../App";
import type { TranscribeResult, TranscriptSegment } from "../lib/types";
import type { Mode } from "./LeftPanel";

interface Props {
  appState: AppState;
  result: TranscribeResult | null;
  error: string | null;
  durationSec: number;
  mode: Mode;
  langs: string[];
  shortcuts: Record<string, string>;
  showTimestamps: boolean;
  waveformVariant?: "ripple" | "bars" | "pulse" | "line";
  snippets: Snippet[];
  onRecord: () => void;
  onUploadClick: () => void;
  onVocabUpdated?: () => void;
  /**
   * Invoked every time the canonical editable text changes.
   * This is the single source of truth for cross-app injection:
   * `typingText = applySnippets(correctedText, snippets) + user edits`.
   * App.tsx reads from here — never from `transcript.fullText` or
   * `transcript.correctedText` directly.
   */
  onTypingTextChange?: (text: string) => void;
  /** Current auto-inject mode — drives the "Type now" button visibility. */
  injectMode?: "auto" | "review";
  /** Manually inject the current typingText (bypasses debounce). */
  onTypeNow?: () => void;
  /** Flow Mode's canonical session buffer — rendered in the Debug panel only. */
  flowBufferText?: string;
  /** True when Flow Mode is actively listening. */
  flowActive?: boolean;
}

const INTEL_MESSAGES = [
  "Optimizing for multilingual speech",
  "Detecting Hindi–English code-switching",
  "Warming acoustic cache",
  "Applying context-aware decoding",
  "Finalizing transcript",
];

const PROC_STEPS = ["Loading model", "Analyzing audio", "Transcribing", "Finalizing"];

function formatMs(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function formatDuration(ms: number): string {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function formatIntentLabel(intent: string): string {
  switch (intent) {
    case "bullet_list": return "Bullet list";
    case "numbered_list": return "Numbered list";
    case "todo_list": return "To-do list";
    case "email": return "Email";
    case "message": return "Message";
    case "meeting_notes": return "Meeting notes";
    default: return "Paragraph";
  }
}

function formatTransformationLabel(level: string): string {
  if (level === "low") return "Lightly edited";
  if (level === "medium") return "Moderately formatted";
  if (level === "high") return "Substantially formatted";
  return "";
}

const CHUNK_WORDS = 6;

function chunkify(text: string): string[] {
  const words = text.split(/(\s+)/);
  const chunks: string[] = [];
  let buf: string[] = [];
  let count = 0;
  for (const w of words) {
    buf.push(w);
    if (/\S/.test(w)) count++;
    if (count >= CHUNK_WORDS) {
      chunks.push(buf.join(""));
      buf = [];
      count = 0;
    }
  }
  if (buf.length) chunks.push(buf.join(""));
  return chunks;
}

function HighlightText({ text }: { text: string }) {
  const parts = text.split(/(\s+|[,.?!—])/);
  return (
    <>
      {parts.map((p, i) => {
        if (!p.trim() || /[,.?!—]/.test(p)) return <span key={i}>{p}</span>;
        const isLatin = /^[A-Za-z'\-]+$/.test(p);
        if (isLatin && p.length >= 4) return <span key={i} className="hi-en">{p}</span>;
        return <span key={i}>{p}</span>;
      })}
    </>
  );
}

interface SegmentProps {
  seg: TranscriptSegment;
  allText: string;
  visibleChunks: number;
  showTimestamps: boolean;
  isCurrent: boolean;
}

function SegmentView({ seg, allText, visibleChunks, showTimestamps, isCurrent }: SegmentProps) {
  const chunks = useMemo(() => chunkify(seg.text), [seg.text]);
  return (
    <div className={`segment ${isCurrent ? "current" : ""}`}>
      <div className="segment-time" style={{ opacity: showTimestamps ? undefined : 0 }}>
        {formatMs(seg.startMs)}
      </div>
      <div className="segment-text">
        {chunks.slice(0, visibleChunks).map((c, i) => (
          <span key={i} className="seg-chunk" style={{ animationDelay: `${i * 90}ms` }}>
            <HighlightText text={c} />
          </span>
        ))}
      </div>
    </div>
  );
}

export function Workspace({
  appState, result, error, durationSec,
  mode, langs, shortcuts, showTimestamps, waveformVariant = "ripple",
  snippets,
  onRecord, onUploadClick, onVocabUpdated, onTypingTextChange,
  injectMode = "auto", onTypeNow,
  flowBufferText, flowActive,
}: Props) {
  const [debugOpen, setDebugOpen] = useState(false);
  const [intelIdx, setIntelIdx] = useState(0);
  const [procStep, setProcStep] = useState(0);
  const [revealState, setRevealState] = useState<Record<number, number>>({});
  const [editedText, setEditedText] = useState("");
  const [savedConfirm, setSavedConfirm] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Raw ↔ Formatted view state. Raw is the default because the primary use
  // case is dictation into external apps that strip formatting — what the user
  // sees in the editable (Raw) area is what gets typed into Slack/browser/etc.
  // Formatted is a preview-only mode, never injected.
  const hasFormatted = !!result?.transcript.formattedOutput;
  const [view, setView] = useState<"raw" | "formatted">("raw");
  useEffect(() => {
    setView("raw");
  }, [result?.transcript.id]);

  const segments = result?.transcript.segments ?? [];
  // typingText is the *editable* canonical text — seeded from correctedText
  // (pipeline-cleaned, deterministic) plus snippets (applied at the UI layer).
  // User edits mutate editedText directly; correctedText is never modified.
  const correctedText = result?.transcript.correctedText ?? "";
  const baselineText = result ? applySnippets(correctedText, snippets) : "";

  // Cycle intel messages during processing
  useEffect(() => {
    if (appState !== "processing") return;
    setProcStep(0);
    const stepTimers = [700, 1600, 2400, 3000].map((t, i) =>
      setTimeout(() => setProcStep(i + 1), t)
    );
    const interval = setInterval(() => setIntelIdx((i) => (i + 1) % INTEL_MESSAGES.length), 1200);
    return () => { stepTimers.forEach(clearTimeout); clearInterval(interval); };
  }, [appState]);

  // Progressive reveal when done
  useEffect(() => {
    if (appState !== "done" || segments.length === 0) return;
    setRevealState({});
    let segIdx = 0;
    let chunkIdx = 0;
    let cancelled = false;

    const step = () => {
      if (cancelled) return;
      const seg = segments[segIdx];
      if (!seg) return;
      const chunks = chunkify(seg.text);
      chunkIdx += 1;
      setRevealState((rs) => ({ ...rs, [segIdx]: chunkIdx }));
      if (chunkIdx >= chunks.length) {
        segIdx += 1;
        chunkIdx = 0;
        if (segIdx >= segments.length) return;
        setTimeout(step, 420);
      } else {
        setTimeout(step, 110);
      }
    };
    setTimeout(step, 300);
    return () => { cancelled = true; };
  }, [appState, segments.length]);

  // Initialize editable text when result arrives — use transcript.id so this
  // fires even when two consecutive transcriptions produce identical text.
  // Source is correctedText (pipeline-cleaned), then snippets applied at the UI
  // layer. correctedText itself never contains snippet expansion.
  useEffect(() => {
    if (result) setEditedText(applySnippets(result.transcript.correctedText, snippets));
  }, [result?.transcript.id, snippets]);

  // Expose the canonical typingText to the parent for injection.
  // Invariant: whatever the user sees in the textarea is what gets injected.
  useEffect(() => {
    onTypingTextChange?.(editedText);
  }, [editedText, onTypingTextChange]);

  // Auto-scroll transcript
  useEffect(() => {
    if (scrollRef.current) {
      requestAnimationFrame(() => scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" }));
    }
  }, [revealState]);

  const anyVisible = Object.keys(revealState).length > 0;
  const lastVisibleIdx = Object.keys(revealState).map(Number).filter((k) => revealState[k]! > 0).reduce((a, b) => Math.max(a, b), -1);
  // True only when the last segment has all its chunks revealed — used to gate
  // the "transcript complete" indicator so it doesn't fire at the first chunk.
  const lastSegIdx = segments.length - 1;
  const lastSegChunkTotal = lastSegIdx >= 0 ? chunkify(segments[lastSegIdx]!.text).length : 0;
  const transcriptFullyRevealed =
    lastSegIdx >= 0 && (revealState[lastSegIdx] ?? 0) >= lastSegChunkTotal;

  const isDirty = !!result && editedText !== baselineText;

  function saveCorrections() {
    if (!result) return;
    learnFromCorrections(baselineText, editedText);

    // If the pipeline produced a formatted output, also send this as a
    // feedback event so adaptive rules can learn from it. Fire-and-forget —
    // UI confirmation doesn't wait on the server.
    const { transcript } = result;
    if (transcript.formattedOutput && transcript.detectedIntent) {
      const corrections = (transcript.metadata?.["corrections"] as unknown[] | undefined) ?? [];
      void submitFeedback({
        rawText: transcript.rawText,
        formattedOutput: transcript.formattedOutput,
        userCorrected: editedText,
        detectedIntent: transcript.detectedIntent.intent,
        intentConfidence: transcript.detectedIntent.confidence,
        corrections,
        language: transcript.language,
      }).catch(() => {
        // Swallow — feedback is opportunistic. Vocab learning already succeeded.
      });
    }

    setSavedConfirm(true);
    onVocabUpdated?.();
    setTimeout(() => setSavedConfirm(false), 2000);
  }

  function copyText() {
    // Always prefer the canonical editable text — same rule as injection.
    void navigator.clipboard.writeText(editedText || result?.transcript.correctedText || "");
  }

  const modeLabel = mode === "Auto" ? "Balanced mode" : `${mode} mode`;
  const isAuto = langs.includes("auto") || langs.length === 0;
  const langLabel = isAuto ? "Auto language" : langs.length > 1 ? "Multilingual" : (langs[0] ?? "");

  const statusTop: Record<AppState, string> = {
    idle: `${modeLabel} · ${langLabel}`,
    recording: "Listening · Speak naturally",
    processing: `${modeLabel} · ${langLabel}`,
    done: "Ready · Transcript complete",
    error: "Transcription failed",
  };
  const statusSub: Record<AppState, string> = {
    idle: "Optimized for offline speech recognition",
    recording: "Mixed languages are fine",
    processing: INTEL_MESSAGES[intelIdx] ?? "",
    done: result ? `${result.modelId} · ${formatDuration(result.transcript.durationMs)} · ${result.transcript.segments.length} segments` : "",
    error: error ?? "",
  };

  return (
    <div className="workspace">
      <div className="workspace-inner">
        <div className="wk-main">
          <SignatureLine appState={appState} />

          {/* Status strip */}
          <div className="status">
            <div className="status-left">
              <div className="status-model">
                <div className="m1">{statusTop[appState]}</div>
                <div className="m2">
                  <span className="intelligent" key={statusSub[appState]}>{statusSub[appState]}</span>
                </div>
              </div>
            </div>
            <div className="status-right">
              {result && (
                <>
                  <button className="ibtn-ghost" title="Copy" onClick={copyText}><ICopy /></button>
                  {isDirty && (
                    <button className="ibtn-ghost" onClick={saveCorrections} style={{ color: "var(--accent)" }}>
                      {savedConfirm ? "Saved!" : "Save corrections"}
                    </button>
                  )}
                  <div className="divider-vertical" />
                </>
              )}
              <button
                className={`ibtn-ghost ${debugOpen ? "active" : ""}`}
                onClick={() => setDebugOpen((v) => !v)}
                title="Toggle debug panel"
              >
                <ICode /> Debug
              </button>
            </div>
          </div>

          {/* Content */}
          {appState === "idle" && (
            <div className="transcript-wrap">
              <div className="empty">
                <div className="empty-badge"><span className="empty-badge-dot" /> Engine ready</div>
                <h1>Just speak.</h1>
                <p>Spokn turns your voice into text — privately, on your device.</p>
                <div className="empty-actions">
                  <button className="empty-chip primary" onClick={onRecord}>Record <kbd>{shortcuts.record ?? "Ctrl+Shift+R"}</kbd></button>
                  <button className="empty-chip" onClick={onUploadClick}>Upload file <kbd>{shortcuts.upload ?? "Ctrl+Shift+U"}</kbd></button>
                </div>
              </div>
            </div>
          )}

          {appState === "recording" && (
            <div className="transcript-wrap">
              <div className="rec-overlay">
                <div className="rec-card">
                  <div className="rec-meta">
                    <span className="rd" /> Recording · input
                  </div>
                  <h2 className="rec-title">
                    {String(Math.floor(durationSec / 60)).padStart(2, "0")}:{String(durationSec % 60).padStart(2, "0")}
                  </h2>
                  <p className="rec-sub">Speak naturally. Mixed languages are fine.</p>
                  <Waveform active variant={waveformVariant} />
                  <div className="rec-actions">
                    <button className="rec-stop" onClick={onRecord}>
                      Stop &amp; transcribe
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {appState === "processing" && (
            <div className="transcript-wrap">
              <div className="proc">
                <div className="proc-title">{INTEL_MESSAGES[intelIdx]}</div>
                <div className="proc-bar" />
                <div className="proc-steps">
                  {PROC_STEPS.map((s, i) => {
                    const status = i < procStep ? "done" : i === procStep ? "active" : "pending";
                    return (
                      <div key={s} className={`proc-step ${status}`}>
                        <span className="proc-step-icon" />
                        <span>{s}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          )}

          {appState === "error" && (
            <div className="transcript-wrap">
              <div className="error-state">
                <div className="error-box">
                  <div className="error-title">Transcription failed</div>
                  <div className="error-msg">{error}</div>
                </div>
              </div>
            </div>
          )}

          {appState === "done" && result && (
            <div className="transcript-wrap">
              <div className="transcript" style={{ maxWidth: 720 }}>
                {/* Minimal post-transcription UI. Flow Mode is the primary
                    product — paste lands in the focused external app, not
                    here. One-shot users still get a compact editable area
                    so correction learning stays intact; everything else
                    (segments, raw/formatted toggle, detailed metadata)
                    lives in the Debug panel. */}
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 10 }}>
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.12em", color: "var(--text-4)" }}>
                    {editedText.trim().split(/\s+/).filter(Boolean).length} words · {result.transcript.language.toUpperCase()}
                    {injectMode === "auto" ? " · typed into focused window" : " · click \"Type now\" to inject"}
                  </span>
                  <div style={{ display: "flex", gap: 8 }}>
                    {onTypeNow && (
                      <button
                        className="ibtn-ghost"
                        onClick={onTypeNow}
                        style={{ padding: "4px 10px", fontSize: 11 }}
                        title="Type this text into the previously focused window"
                      >
                        Type now
                      </button>
                    )}
                    {isDirty && (
                      <button className="transcript-save-btn" onClick={saveCorrections}>
                        {savedConfirm ? "✓ Saved" : "Save corrections"}
                      </button>
                    )}
                  </div>
                </div>
                <textarea
                  className="transcript-editable"
                  value={editedText}
                  onChange={(e) => setEditedText(e.target.value)}
                  rows={Math.max(3, Math.ceil(editedText.length / 80))}
                  spellCheck={false}
                  placeholder="Transcript text…"
                  style={{
                    border: isDirty ? "1px solid var(--accent-border)" : "1px solid var(--border)",
                    borderRadius: "var(--r-md)",
                    padding: "14px 16px",
                    background: isDirty ? "var(--accent-soft)" : "var(--surface-2)",
                    transition: "all 200ms var(--ease)",
                    width: "100%",
                  }}
                />
                {!isDirty && (
                  <p className="transcript-edit-hint" style={{ marginTop: 6 }}>
                    Edit here to correct words — they are learned for future sessions. Full transcript details are in the Debug panel.
                  </p>
                )}
              </div>
            </div>
          )}
        </div>

        <DebugPanel
          open={debugOpen}
          result={result}
          mode={mode}
          langs={langs}
          flowBufferText={flowBufferText}
          flowActive={flowActive}
        />
      </div>
    </div>
  );
}
