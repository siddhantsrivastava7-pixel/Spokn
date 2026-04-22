import { useRef, useState } from "react";
import { IMic, IStop, IUpload, ISpark, ILayers, ICpu, IPackage, IChevronDown } from "./Icons";
import { SpoknMark } from "./SpoknMark";
import { LanguagePicker } from "./LanguagePicker";
import type { AppState } from "../App";
import type { Snippet } from "../lib/snippets";
import type { FlowContext } from "../lib/flowToneMapping";

export type Mode = "Auto" | "Fast" | "Balanced" | "Best";
export type FlowContextChoice = "auto" | FlowContext;

interface Props {
  mode: Mode;
  setMode: (m: Mode) => void;
  langs: string[];
  setLangs: (l: string[]) => void;
  timestamps: boolean;
  setTimestamps: (v: boolean) => void;
  appState: AppState;
  hasAudio: boolean;
  installedModels: string[];
  learnedWords: string[];
  snippets: Snippet[];
  onRecord: () => void;
  onUpload: (file: File) => void;
  onTranscribe: () => void;
  onManageModels: () => void;
  onClearVocab: () => void;
  onAddSnippet: (trigger: string, value: string) => void;
  onRemoveSnippet: (id: string) => void;
  shortcuts?: Record<string, string>;
  // ── Flow Mode ──────────────────────────────────────────────────────────
  flowActive: boolean;
  flowContext: FlowContextChoice;
  flowResolvedContext: FlowContext;
  onFlowToggle: () => void;
  onFlowContextChange: (c: FlowContextChoice) => void;
}

const MODES: Mode[] = ["Auto", "Fast", "Balanced", "Best"];

export function LeftPanel({
  mode, setMode, langs, setLangs, timestamps, setTimestamps,
  appState, hasAudio, installedModels,
  learnedWords, snippets,
  onRecord, onUpload, onTranscribe, onManageModels,
  onClearVocab, onAddSnippet, onRemoveSnippet,
  shortcuts = {},
  flowActive, flowContext, flowResolvedContext,
  onFlowToggle, onFlowContextChange,
}: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  const isRecording = appState === "recording";
  const isBusy = appState === "processing";
  const isDone = appState === "done";

  const [vocabOpen, setVocabOpen] = useState(false);
  const [snippetsOpen, setSnippetsOpen] = useState(false);
  const [triggerDraft, setTriggerDraft] = useState("");
  const [valueDraft, setValueDraft] = useState("");

  let ctaLabel = "Transcribe";
  let ctaState = "idle";
  if (isBusy) { ctaLabel = "Transcribing…"; ctaState = "busy"; }
  else if (isDone) { ctaLabel = "Transcript ready"; ctaState = "done"; }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) { onUpload(file); e.target.value = ""; }
  }

  function handleAddSnippet() {
    if (!triggerDraft.trim() || !valueDraft.trim()) return;
    onAddSnippet(triggerDraft, valueDraft);
    setTriggerDraft("");
    setValueDraft("");
  }

  return (
    <aside className="leftpanel">
      <div className="brand">
        <div className="brand-mark" aria-hidden>
          <SpoknMark size={28} className="brand-mark-image" />
        </div>
        <div className="brand-text">
          <div className="name">Spokn <span className="brand-dot" /></div>
          <div className="sub">Offline Speech Engine</div>
        </div>
      </div>

      {/* Input */}
      <div className="lp-section">
        <div className="lp-label">
          <IMic size={10} weight={2} /> <span>Input</span>
        </div>
        <button
          className={`record-cta ${isRecording ? "recording" : ""}`}
          onClick={onRecord}
          disabled={isBusy}
        >
          <span className="record-cta-left">
            {isRecording ? <IStop size={15} weight={2.2} /> : <IMic size={15} weight={2} />}
            <span>{isRecording ? "Stop recording" : "Record"}</span>
          </span>
          <span className="record-cta-kbd"><kbd>{shortcuts.record ?? "R"}</kbd></span>
        </button>

        <button
          className="upload-btn"
          onClick={() => fileRef.current?.click()}
          disabled={isRecording || isBusy}
        >
          <IUpload size={13} />
          <span>Upload audio</span>
          <kbd>{shortcuts.upload ?? "U"}</kbd>
        </button>
        <input
          id="upload-trigger"
          ref={fileRef}
          type="file"
          accept="audio/*,.wav,.mp3,.m4a,.webm,.ogg,.flac"
          style={{ display: "none" }}
          onChange={handleFileChange}
        />
      </div>

      {/* Flow Mode */}
      <div className="lp-section">
        <div className="lp-label">
          <ISpark size={10} weight={2} /> <span>Flow</span>
        </div>
        <button
          className={`record-cta ${flowActive ? "recording" : ""}`}
          onClick={onFlowToggle}
          disabled={appState === "recording" || appState === "processing"}
          title="Continuous listening with auto-commit and inline correction"
        >
          <span className="record-cta-left">
            {flowActive ? <IStop size={15} weight={2.2} /> : <ISpark size={15} weight={2} />}
            <span>{flowActive ? "Stop Flow" : "Start Flow"}</span>
          </span>
          <span className="record-cta-kbd"><kbd>{shortcuts.flow ?? "Ctrl+Shift+F"}</kbd></span>
        </button>
        <div className="seg" role="tablist" style={{ marginTop: 8 }}>
          {(["auto", "chat", "email", "notes"] as const).map((c) => (
            <button
              key={c}
              className={flowContext === c ? "active" : ""}
              onClick={() => onFlowContextChange(c)}
              role="tab"
              aria-selected={flowContext === c}
              style={{ fontSize: 10, textTransform: "capitalize" }}
              title={c === "auto" ? `Auto · ${flowResolvedContext}` : undefined}
            >
              {c === "auto" && flowActive ? `auto · ${flowResolvedContext}` : c}
            </button>
          ))}
        </div>
      </div>

      {/* Engine */}
      <div className="lp-section">
        <div className="lp-label">
          <ICpu size={10} weight={2} /> <span>Engine</span>
        </div>
        <div className="seg-group">
          <div className="seg-row">
            <span className="seg-row-label">Mode</span>
            <span className="seg-row-val">{mode.toLowerCase()}</span>
          </div>
          <div className="seg" role="tablist">
            {MODES.map((m) => (
              <button
                key={m}
                className={mode === m ? "active" : ""}
                onClick={() => setMode(m)}
                role="tab"
                aria-selected={mode === m}
              >{m}</button>
            ))}
          </div>

          <div className="seg-row" style={{ marginTop: 10 }}>
            <span className="seg-row-label">Languages</span>
          </div>
          <LanguagePicker selected={langs} onChange={setLangs} />
        </div>
      </div>

      {/* Output */}
      <div className="lp-section">
        <div className="lp-label">
          <ILayers size={10} weight={2} /> <span>Output</span>
        </div>
        <div className="toggle-row">
          <div>
            <div>Timestamps</div>
            <div className="toggle-hint">Per-segment, hh:mm:ss</div>
          </div>
          <button
            className={`toggle ${timestamps ? "on" : ""}`}
            onClick={() => setTimestamps(!timestamps)}
            aria-pressed={timestamps}
          />
        </div>
      </div>

      {/* Vocabulary */}
      <div className="lp-section">
        <button
          className="lp-label lp-label-btn"
          onClick={() => setVocabOpen((v) => !v)}
          style={{ width: "100%", display: "flex", justifyContent: "space-between", cursor: "pointer", background: "none", border: "none", padding: 0 }}
        >
          <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <IPackage size={10} weight={2} /> <span>Vocabulary</span>
            {learnedWords.length > 0 && (
              <span style={{ fontSize: 9, background: "var(--accent)", color: "#fff", borderRadius: 10, padding: "1px 5px" }}>{learnedWords.length}</span>
            )}
          </span>
          <span style={{ transform: vocabOpen ? "rotate(180deg)" : "none", transition: "transform 200ms", color: "var(--text-4)" }}>
            <IChevronDown size={11} />
          </span>
        </button>

        {vocabOpen && (
          <div style={{ marginTop: 8 }}>
            {learnedWords.length === 0 ? (
              <div style={{ fontSize: 10, color: "var(--text-4)", fontFamily: "var(--font-mono)", lineHeight: 1.5 }}>
                No learned words yet.<br />Correct a transcript to start building vocabulary.
              </div>
            ) : (
              <>
                <div style={{ fontSize: 10.5, color: "var(--accent)", fontFamily: "var(--font-mono)", lineHeight: 1.8, wordBreak: "break-word", marginBottom: 8 }}>
                  {learnedWords.join(", ")}
                </div>
                <button
                  onClick={onClearVocab}
                  style={{ fontSize: 10, fontFamily: "var(--font-mono)", color: "var(--text-4)", background: "none", border: "1px solid var(--border)", borderRadius: "var(--r-sm)", padding: "3px 8px", cursor: "pointer" }}
                >
                  clear all
                </button>
              </>
            )}
          </div>
        )}
      </div>

      {/* Snippets */}
      <div className="lp-section">
        <button
          className="lp-label lp-label-btn"
          onClick={() => setSnippetsOpen((v) => !v)}
          style={{ width: "100%", display: "flex", justifyContent: "space-between", cursor: "pointer", background: "none", border: "none", padding: 0 }}
        >
          <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <ISpark size={10} weight={2} /> <span>Snippets</span>
            {snippets.length > 0 && (
              <span style={{ fontSize: 9, background: "var(--surface-3)", color: "var(--text-3)", borderRadius: 10, padding: "1px 5px" }}>{snippets.length}</span>
            )}
          </span>
          <span style={{ transform: snippetsOpen ? "rotate(180deg)" : "none", transition: "transform 200ms", color: "var(--text-4)" }}>
            <IChevronDown size={11} />
          </span>
        </button>

        {snippetsOpen && (
          <div style={{ marginTop: 8 }}>
            <div style={{ fontSize: 10, color: "var(--text-4)", fontFamily: "var(--font-mono)", marginBottom: 8, lineHeight: 1.5 }}>
              Say the trigger phrase — it gets replaced in your transcript.
            </div>

            {/* Existing snippets */}
            {snippets.map((s) => (
              <div key={s.id} style={{ marginBottom: 6, background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: "var(--r-sm)", padding: "7px 9px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 6 }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 10, color: "var(--text-4)", fontFamily: "var(--font-mono)", marginBottom: 2 }}>trigger</div>
                    <div style={{ fontSize: 11, color: "var(--accent)", fontFamily: "var(--font-mono)", wordBreak: "break-all" }}>"{s.trigger}"</div>
                    <div style={{ fontSize: 10, color: "var(--text-4)", fontFamily: "var(--font-mono)", marginTop: 4, marginBottom: 2 }}>expands to</div>
                    <div style={{ fontSize: 11, color: "var(--text-2)", fontFamily: "var(--font-mono)", wordBreak: "break-all" }}>{s.value}</div>
                  </div>
                  <button
                    onClick={() => onRemoveSnippet(s.id)}
                    style={{ flexShrink: 0, fontSize: 10, color: "var(--text-4)", background: "none", border: "none", cursor: "pointer", padding: "2px 4px" }}
                  >
                    ✕
                  </button>
                </div>
              </div>
            ))}

            {/* Add form */}
            <div style={{ marginTop: snippets.length > 0 ? 10 : 0 }}>
              <input
                className="modal-input"
                type="text"
                placeholder='Trigger phrase (e.g. "insert my x link")'
                value={triggerDraft}
                onChange={(e) => setTriggerDraft(e.target.value)}
                style={{ marginBottom: 6, fontSize: 11 }}
              />
              <input
                className="modal-input"
                type="text"
                placeholder="Expands to (e.g. https://x.com/you)"
                value={valueDraft}
                onChange={(e) => setValueDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") handleAddSnippet(); }}
                style={{ marginBottom: 8, fontSize: 11 }}
              />
              <button
                onClick={handleAddSnippet}
                disabled={!triggerDraft.trim() || !valueDraft.trim()}
                style={{
                  width: "100%", padding: "6px 0", fontSize: 11, fontFamily: "var(--font-mono)",
                  background: "var(--accent)", color: "#fff", border: "none",
                  borderRadius: "var(--r-sm)", cursor: "pointer", opacity: (!triggerDraft.trim() || !valueDraft.trim()) ? 0.4 : 1,
                }}
              >
                + Add snippet
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Transcribe CTA */}
      <div className="lp-section lp-action">
        <button
          className={`cta cta-${ctaState}`}
          onClick={onTranscribe}
          disabled={isRecording || isBusy || !hasAudio}
        >
          {ctaState === "idle" && <ISpark size={13} weight={2} />}
          {ctaState === "busy" && <span className="cta-spinner" />}
          {ctaState === "done" && <span className="cta-check">✓</span>}
          <span>{ctaLabel}</span>
          {ctaState === "idle" && <span className="kbd">{shortcuts.transcribe ?? "Ctrl+Enter"}</span>}
        </button>
      </div>

      {/* Footer */}
      <div className="lp-footer">
        <button className="chip" onClick={onManageModels} title="Manage models">
          <span className="chip-dot" />
          {installedModels.length > 0 ? `${installedModels.length} model${installedModels.length > 1 ? "s" : ""}` : "no models"}
        </button>
        <span>v0.1.0</span>
      </div>
    </aside>
  );
}
